// The collections agent. It reads this workspace's unpaid invoices with PayPal's Agent Toolkit, checks
// what was already sent, and proposes (or, on autopilot, sends) reminders in a tone that fits how late
// each invoice is. It can never add recipients, touch other workspaces' invoices or skip the rules.

import { PayPalAgentToolkit } from '@paypal/agent-toolkit/openai';
import { config } from './config.js';
import { chat, type Message, type Tool, type ToolCall, type Usage } from './ai.js';
import type { PayPalInvoice } from './paypal.js';
import { agentMayRemind, overdueDays, record, remindersFor, today, toneFor, type Tone } from './reminders.js';

export interface Proposal {
  invoiceId: string;
  number: string;
  client: string;
  dueAmount: string;
  currency: string;
  daysOverdue?: number;
  action: 'remind' | 'none';
  tone?: Tone;
  subject?: string;
  note?: string;
  reason: string;
  nextCheck?: string;
  /** Set when the agent sent it itself on autopilot. */
  sent?: boolean;
}

export type AgentEvent =
  | { type: 'step'; kind: 'search' | 'read' | 'history' | 'think' | 'send'; text: string }
  | { type: 'proposal'; proposal: Proposal }
  | { type: 'blocked'; invoiceId: string; number: string; reason: string }
  | { type: 'done'; summary: string; usage: Usage }
  | { type: 'error'; message: string };

let kit: PayPalAgentToolkit | undefined;
export function toolkit(): PayPalAgentToolkit {
  kit ??= new PayPalAgentToolkit({
    clientId: config.paypal.clientId,
    clientSecret: config.paypal.clientSecret,
    configuration: { actions: { invoices: { search: true, get: true, sendReminder: true } }, context: { sandbox: true } }
  });
  return kit;
}

/** Runs one PayPal Agent Toolkit tool and returns its parsed JSON; the toolkit's errors become exceptions. */
export async function runToolkit<T = unknown>(name: string, args: Record<string, unknown>): Promise<T> {
  const out = await toolkit().handleToolCall({ id: `lb-${Date.now()}`, type: 'function', function: { name, arguments: JSON.stringify(args) } });
  const text = typeof out.content === 'string' ? out.content : JSON.stringify(out.content);
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new Error(text.slice(0, 300) || `${name} failed`); }
  if (parsed && typeof parsed === 'object' && ((parsed as { ok?: unknown }).ok === false || 'error' in parsed)) {
    const p = parsed as { message?: string; error?: { message?: string } };
    throw new Error(`PayPal: ${p.message ?? p.error?.message ?? `${name} failed`}`);
  }
  return parsed as T;
}

/** Sends a reminder through the toolkit's send_invoice_reminder tool and logs it. */
export async function sendReminder(invoiceId: string, subject: string, note: string, by: 'you' | 'agent', tone?: Tone, day = today()): Promise<void> {
  await runToolkit('send_invoice_reminder', { invoice_id: invoiceId, subject: subject.slice(0, 200), note: note.slice(0, 2000) });
  record(invoiceId, { at: new Date().toISOString(), day, subject, by, ...(tone ? { tone } : {}) });
}

const own = (name: string, description: string, properties: Record<string, unknown>, required: string[]): Tool =>
  ({ type: 'function', function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } } });

const REMINDER_FIELDS = {
  invoice_id: { type: 'string' },
  tone: { type: 'string', enum: ['friendly', 'firm', 'final'] },
  subject: { type: 'string', description: 'Under 80 characters.' },
  note: { type: 'string', description: 'Under 90 words; see the rules.' },
  reason: { type: 'string', description: 'One short sentence for the freelancer: why this reminder, why now.' }
};

function rules(business: string, signer: string, autopilot: boolean, day: string): string {
  return `You are the collections agent in Logbill for ${business}. Today is ${day}.
You review this workspace's unpaid PayPal invoices and decide, for each one, whether a payment reminder should go out now.

Work like this:
1. Call search_invoicing once (resource_type invoice) with status SENT, UNPAID, PARTIALLY_PAID and PAYMENT_PENDING.
2. For each invoice, call reminder_history. Call get_invoice only if you need more detail than the search gave.
3. For each invoice, call exactly one of ${autopilot ? 'send_invoice_reminder (sends it now)' : 'propose_reminder (the freelancer approves it)'} or propose_no_action.
4. Then reply with two or three plain sentences summarising what you did and what to watch. No markdown.

Rules (Logbill also enforces them and will tell you if you break one):
- Not due yet: no reminder, unless it is due within 2 days and no reminder was sent; then a short friendly heads-up is fine.
- Overdue 1 to 13 days: friendly. 14 to 29 days: firm. 30 days or more: final notice, still polite, offering a quick call.
- At most one reminder per invoice every 3 days, and at most 3 in total; after that, propose_no_action and suggest a personal call.
- PAYMENT_PENDING: no reminder, the payment is on its way.
- PARTIALLY_PAID: thank them for what they paid and remind them of the balance.
- Write the note to the client's contact by first name. Include the invoice number, the amount due, the due date and what the work was (from the items), and a clear ask. Sign off as ${signer}. Under 90 words. No links (PayPal adds the pay button), no placeholders, no threats or talk of further steps, no legal terms, nothing that is not in the invoice.`;
}

const clientOf = (inv: PayPalInvoice): string => {
  const b = inv.primary_recipients?.[0]?.billing_info;
  return b?.business_name || [b?.name?.given_name, b?.name?.surname].filter(Boolean).join(' ') || b?.email_address || 'Client';
};

/** Keeps what the model needs from an invoice, so the conversation stays small. */
function brief(inv: PayPalInvoice, day: string) {
  const b = inv.primary_recipients?.[0]?.billing_info;
  return {
    id: inv.id, invoice_number: inv.detail.invoice_number, status: inv.status, invoice_date: inv.detail.invoice_date,
    due_date: inv.detail.payment_term?.due_date, days_overdue: overdueDays(inv, day), total: inv.amount?.value, due_amount: inv.due_amount?.value ?? inv.amount?.value,
    paid: inv.payments?.paid_amount?.value, currency: inv.detail.currency_code, client: clientOf(inv), contact_first_name: b?.name?.given_name,
    items: inv.items?.map((i) => `${i.name} (${i.quantity} h)`)
  };
}

export async function runAgent(opts: { reference: string; business: string; signer: string; autopilot: boolean; today?: string; emit: (e: AgentEvent) => void }): Promise<void> {
  const { reference, emit } = opts;
  const day = opts.today ?? today();
  const seen = new Map<string, PayPalInvoice>();
  const decided = new Set<string>();
  const usage: Usage = { prompt_tokens: 0, completion_tokens: 0, cost: 0 };
  const kitTools = toolkit().getTools() as unknown as Tool[];
  const pick = (name: string) => kitTools.find((t) => t.function.name === name);
  const search = pick('search_invoicing'); const get = pick('get_invoice'); const send = pick('send_invoice_reminder');
  if (!search || !get || !send) throw new Error('The PayPal Agent Toolkit did not offer the invoice tools.');
  const tools: Tool[] = [
    search, get,
    own('reminder_history', 'Reminders Logbill already sent for an invoice, oldest first.', { invoice_id: { type: 'string' } }, ['invoice_id']),
    ...(opts.autopilot
      ? [{ type: 'function', function: { ...send.function, description: 'Send a payment reminder for an unpaid invoice now. Logbill checks the rules first.', parameters: { type: 'object', properties: REMINDER_FIELDS, required: ['invoice_id', 'tone', 'subject', 'note', 'reason'], additionalProperties: false } } } as Tool]
      : [own('propose_reminder', 'Propose a payment reminder; the freelancer reviews and sends it.', REMINDER_FIELDS, ['invoice_id', 'tone', 'subject', 'note', 'reason'])]),
    own('propose_no_action', 'Record that an invoice needs no reminder now.', { invoice_id: { type: 'string' }, reason: { type: 'string' }, next_check: { type: 'string', description: 'YYYY-MM-DD, when to look again.' } }, ['invoice_id', 'reason'])
  ];

  const messages: Message[] = [
    { role: 'system', content: rules(opts.business, opts.signer, opts.autopilot, day) },
    { role: 'user', content: 'Review my unpaid invoices and handle the reminders.' }
  ];

  // Search results leave out line items, so get_invoice always reads the full invoice.
  const full = new Set<string>();
  const known = async (id: string, fresh = false): Promise<PayPalInvoice | undefined> => {
    if (seen.has(id) && !(fresh && !full.has(id))) return seen.get(id);
    const inv = await runToolkit<PayPalInvoice>('get_invoice', { invoice_id: id }).catch(() => undefined);
    if (inv?.detail?.reference !== reference) return undefined;
    seen.set(id, inv); full.add(id); return inv;
  };

  const handle = async (call: ToolCall): Promise<string> => {
    let args: Record<string, unknown> = {};
    try { args = JSON.parse(call.function.arguments || '{}'); } catch { return 'Error: the arguments were not valid JSON.'; }
    const id = String(args.invoice_id ?? '');
    switch (call.function.name) {
      case 'search_invoicing': {
        emit({ type: 'step', kind: 'search', text: 'Searching your unpaid invoices on PayPal' });
        const filters = (args.invoice_filters ?? {}) as Record<string, unknown>;
        // Only this workspace's invoices, whatever the model asked for.
        const res = await runToolkit<{ items?: PayPalInvoice[] }>('search_invoicing', { resource_type: 'invoice', page: 1, page_size: 50, total_required: true, invoice_filters: { ...(Array.isArray(filters.status) ? { status: filters.status } : {}), reference } });
        const items = (res.items ?? []).filter((i) => i.detail?.reference === reference);
        for (const i of items) seen.set(i.id, i);
        return JSON.stringify({ count: items.length, invoices: items.map((i) => brief(i, day)) });
      }
      case 'get_invoice': {
        const inv = await known(id, true);
        emit({ type: 'step', kind: 'read', text: `Reading invoice ${inv?.detail.invoice_number ?? id}` });
        return inv ? JSON.stringify(brief(inv, day)) : 'Error: that invoice is not in this workspace.';
      }
      case 'reminder_history': {
        const inv = await known(id);
        if (!inv) return 'Error: that invoice is not in this workspace.';
        const sent = remindersFor(id);
        emit({ type: 'step', kind: 'history', text: `Checking reminders already sent for ${inv.detail.invoice_number}: ${sent.length || 'none'}` });
        return JSON.stringify({ invoice_id: id, reminders: sent.map((r) => ({ date: r.day ?? r.at.slice(0, 10), tone: r.tone, subject: r.subject })) });
      }
      case 'propose_no_action': {
        const inv = await known(id);
        if (!inv) return 'Error: that invoice is not in this workspace.';
        decided.add(id);
        emit({ type: 'proposal', proposal: { ...base(inv, day), action: 'none', reason: String(args.reason ?? '').slice(0, 300), ...(args.next_check ? { nextCheck: String(args.next_check).slice(0, 10) } : {}) } });
        return 'Recorded.';
      }
      case 'propose_reminder':
      case 'send_invoice_reminder': {
        const inv = await known(id);
        if (!inv) return 'Error: that invoice is not in this workspace.';
        const fresh = (await runToolkit<PayPalInvoice>('get_invoice', { invoice_id: id }).catch(() => inv)) ?? inv;
        const days = overdueDays(fresh, day) ?? 0;
        const tone = (['friendly', 'firm', 'final'].includes(String(args.tone)) ? args.tone : toneFor(days)) as Tone;
        const subject = String(args.subject ?? '').slice(0, 120) || `Reminder: invoice ${fresh.detail.invoice_number}`;
        const note = String(args.note ?? '').slice(0, 1500);
        const allowed = agentMayRemind(fresh, day);
        if (!allowed.ok) {
          emit({ type: 'blocked', invoiceId: id, number: fresh.detail.invoice_number ?? id, reason: allowed.reason });
          return `Blocked by Logbill's rules: ${allowed.reason} Use propose_no_action for this invoice instead.`;
        }
        if (call.function.name === 'send_invoice_reminder') {
          emit({ type: 'step', kind: 'send', text: `Sending a ${tone} reminder for ${fresh.detail.invoice_number} with PayPal` });
          await sendReminder(id, subject, note, 'agent', tone, day);
        }
        decided.add(id);
        emit({ type: 'proposal', proposal: { ...base(fresh, day), action: 'remind', tone, subject, note, reason: String(args.reason ?? '').slice(0, 300), ...(call.function.name === 'send_invoice_reminder' ? { sent: true } : {}) } });
        return call.function.name === 'send_invoice_reminder' ? 'Sent.' : 'Proposed; the freelancer will review it.';
      }
      default:
        return `Error: unknown tool ${call.function.name}.`;
    }
  };

  for (let turn = 0; turn < 12; turn++) {
    const { message, usage: u } = await chat(messages, { tools, toolChoice: 'auto', maxTokens: 3000, temperature: 0.3 });
    usage.prompt_tokens! += u.prompt_tokens ?? 0; usage.completion_tokens! += u.completion_tokens ?? 0; usage.cost! += u.cost ?? 0;
    const calls = message.tool_calls ?? [];
    messages.push({ role: 'assistant', content: message.content ?? null, ...(calls.length ? { tool_calls: calls } : {}) });
    if (!calls.length) {
      emit({ type: 'done', summary: String(message.content ?? '').trim() || 'Done.', usage });
      return;
    }
    for (const call of calls) {
      let result: string;
      try { result = await handle(call); } catch (e) { result = `Error: ${e instanceof Error ? e.message : String(e)}`.slice(0, 500); }
      messages.push({ role: 'tool', tool_call_id: call.id, content: result });
    }
  }
  emit({ type: 'done', summary: 'Stopped after twelve steps; run the agent again to continue.', usage });
}

function base(inv: PayPalInvoice, day: string) {
  const days = overdueDays(inv, day);
  return {
    invoiceId: inv.id, number: inv.detail.invoice_number ?? inv.id, client: clientOf(inv),
    dueAmount: inv.due_amount?.value ?? inv.amount?.value ?? '0.00', currency: inv.detail.currency_code,
    ...(days !== undefined ? { daysOverdue: days } : {})
  };
}

export { clientOf };
