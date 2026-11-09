// Logbill's API and, in production, the built web app.

import express, { type NextFunction, type Request, type Response } from 'express';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { config, missingSettings, recipientAllowed } from './config.js';
import { AiUnavailable, aiConfigured, draftLines } from './ai.js';
import { clientOf, runAgent, sendReminder, type AgentEvent } from './agent.js';
import { PayPalError, cancelInvoice, createInvoice, deleteDraft, getInvoice, invoiceQr, invoicesFor, sendInvoice, type PayPalInvoice } from './paypal.js';
import { REMINDABLE, overdueDays, remindersFor, today } from './reminders.js';
import { addDays, auditDraft, buildDraft, paypalInvoice, rulesDraft, type InvoiceLine, type TermDays } from '../shared/core.js';
import type { DraftResponse, Health, InvoiceSummary } from '../shared/api.js';

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '2mb' }));

// ---------- Workspaces ----------
// Each browser keeps a random workspace id; invoices carry it as their PayPal reference, so a visitor
// to the shared demo only ever sees, reminds or cancels their own invoices.

const SESSION = /^[a-z0-9-]{8,64}$/;
function workspace(req: Request): string {
  const sid = String(req.header('x-logbill-session') ?? req.query.session ?? '').toLowerCase();
  if (!SESSION.test(sid)) throw new HttpError(400, 'Missing workspace id. Reload the page.');
  return `logbill-${sid}`;
}

/** The visitor's own date (sent by the browser), trusted only within a day of the server's. */
function dayOf(req: Request): string {
  const d = String(req.header('x-logbill-today') ?? req.query.today ?? '');
  const server = today();
  return /^\d{4}-\d{2}-\d{2}$/.test(d) && Math.abs(Date.parse(d) - Date.parse(server)) <= 86_400_000 ? d : server;
}

class HttpError extends Error { constructor(readonly status: number, message: string) { super(message); } }

async function ownInvoice(req: Request): Promise<PayPalInvoice> {
  const ref = workspace(req);
  const id = String(req.params.id ?? '');
  if (!/^[A-Za-z0-9-]{1,64}$/.test(id)) throw new HttpError(400, 'Bad invoice id.');
  const inv = await getInvoice(id).catch(() => undefined);
  if (!inv || inv.detail.reference !== ref) throw new HttpError(404, 'That invoice is not in this workspace.');
  return inv;
}

// ---------- Limits for the public demo ----------

const windows = new Map<string, { n: number; reset: number }>();
const limit = (bucket: string, max: number) => (req: Request, _res: Response, next: NextFunction) => {
  const key = `${bucket}|${req.ip}`; const now = Date.now();
  const w = windows.get(key);
  if (!w || w.reset < now) windows.set(key, { n: 1, reset: now + 3_600_000 });
  else if (++w.n > max) return next(new HttpError(429, 'That is a lot of requests for a demo. Try again in an hour.'));
  next();
};

const wrap = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) => { fn(req, res).catch(next); };

// ---------- Shapes ----------

const Entry = z.object({
  id: z.string().max(20), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), client: z.string().max(200), project: z.string().max(200),
  description: z.string().max(300), person: z.string().max(120), minutes: z.number().int().positive().max(24 * 60), billable: z.boolean(),
  rateCents: z.number().int().positive().max(10_000_000).optional()
});
const Line = z.object({
  id: z.string().max(20), name: z.string().min(1).max(200), description: z.string().max(1000), minutes: z.number().int().nonnegative(),
  rateCents: z.number().int().nonnegative().max(10_000_000), entryIds: z.array(z.string().max(20)).max(500)
});
const Name = z.object({ givenName: z.string().min(1).max(140), surname: z.string().max(140), business: z.string().max(300).optional() });
const SendBody = z.object({
  lines: z.array(Line).min(1).max(100),
  currency: z.literal('USD'),
  invoicer: Name,
  recipient: Name.extend({ email: z.string().email().max(254) }),
  invoiceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  termDays: z.union([z.literal(0), z.literal(10), z.literal(15), z.literal(30), z.literal(45), z.literal(60), z.literal(90)]),
  note: z.string().max(4000)
});
const RemindBody = z.object({ subject: z.string().min(1).max(200), note: z.string().max(2000), tone: z.enum(['friendly', 'firm', 'final']).optional() });

function summary(inv: PayPalInvoice, day = today()): InvoiceSummary {
  const b = inv.primary_recipients?.[0]?.billing_info;
  return {
    id: inv.id, number: inv.detail.invoice_number ?? '', status: inv.status, client: clientOf(inv),
    contact: [b?.name?.given_name, b?.name?.surname].filter(Boolean).join(' '), email: b?.email_address ?? '',
    currency: inv.detail.currency_code, total: inv.amount?.value ?? '0.00', due: inv.due_amount?.value ?? inv.amount?.value ?? '0.00',
    paid: inv.payments?.paid_amount?.value ?? '0.00', invoiceDate: inv.detail.invoice_date ?? '', dueDate: inv.detail.payment_term?.due_date ?? '',
    daysOverdue: overdueDays(inv, day) ?? null, payerUrl: inv.detail.metadata?.recipient_view_url ?? '', reminders: remindersFor(inv.id),
    items: (inv.items ?? []).map((i) => ({ name: i.name, hours: i.quantity, rate: i.unit_amount.value })),
    created: inv.detail.metadata?.create_time ?? ''
  };
}

// ---------- Routes ----------

app.get('/api/health', (_req, res) => {
  const missing = missingSettings();
  const body: Health = {
    ok: !missing.length, paypal: !missing.length, ai: aiConfigured(), model: config.ai.model, missing,
    invoicerEmail: config.paypal.invoicerEmail, demoRecipient: config.demo.recipientEmail, recipientDomains: config.demo.recipientDomains
  };
  res.json(body);
});

app.post('/api/draft', limit('draft', 40), wrap(async (req, res) => {
  const body = z.object({ entries: z.array(Entry).min(1).max(500), rateCents: z.number().int().positive().max(10_000_000), client: z.string().max(200), business: z.string().max(300) }).parse(req.body);
  const started = Date.now();
  let out: DraftResponse;
  try {
    const { raw, usage } = await draftLines(body.entries, { client: body.client, business: body.business });
    const draft = buildDraft(raw, body.entries, body.rateCents);
    out = { draft, problems: auditDraft(draft, body.entries), ms: Date.now() - started, ...(usage.cost !== undefined ? { cost: usage.cost } : {}) };
  } catch (e) {
    const draft = rulesDraft(body.entries, body.rateCents);
    out = { draft, problems: auditDraft(draft, body.entries), aiError: e instanceof AiUnavailable ? e.message : 'The AI could not draft this timesheet.', ms: Date.now() - started };
    if (!(e instanceof AiUnavailable)) console.error('draft failed', e);
  }
  res.json(out);
}));

app.get('/api/invoices', wrap(async (req, res) => {
  const list = await invoicesFor(workspace(req));
  const day = dayOf(req);
  res.json(list.map((i) => summary(i, day)));
}));

app.post('/api/invoices', limit('send', 40), wrap(async (req, res) => {
  const ref = workspace(req);
  const body = SendBody.parse(req.body);
  if (!recipientAllowed(body.recipient.email)) throw new HttpError(400, `This sandbox demo only sends invoices to ${config.demo.recipientDomains.join(', ')} addresses, the kind PayPal sandbox accounts use.`);
  const inv = await createInvoice(paypalInvoice({
    lines: body.lines as InvoiceLine[], currency: body.currency,
    invoicer: { ...body.invoicer, email: config.paypal.invoicerEmail }, recipient: body.recipient,
    invoiceDate: body.invoiceDate, termDays: body.termDays as TermDays, note: body.note, reference: ref
  }));
  try { await sendInvoice(inv.id); }
  catch (e) { await deleteDraft(inv.id).catch(() => undefined); throw e; }
  res.status(201).json(summary(await getInvoice(inv.id), dayOf(req)));
}));

app.get('/api/invoices/:id/qr', wrap(async (req, res) => {
  const inv = await ownInvoice(req);
  res.json({ dataUrl: await invoiceQr(inv.id) });
}));

app.post('/api/invoices/:id/remind', limit('remind', 40), wrap(async (req, res) => {
  const inv = await ownInvoice(req);
  const body = RemindBody.parse(req.body);
  if (!REMINDABLE.has(inv.status)) throw new HttpError(409, `Invoice ${inv.detail.invoice_number} is ${inv.status.toLowerCase().replace(/_/g, ' ')}; there is nothing to remind.`);
  await sendReminder(inv.id, body.subject, body.note, 'you', body.tone, dayOf(req));
  res.json(summary(await getInvoice(inv.id), dayOf(req)));
}));

app.post('/api/invoices/:id/cancel', limit('cancel', 40), wrap(async (req, res) => {
  const inv = await ownInvoice(req);
  if (inv.status === 'DRAFT') { await deleteDraft(inv.id); res.json({ deleted: true }); return; }
  if (!['SENT', 'UNPAID', 'SCHEDULED'].includes(inv.status)) throw new HttpError(409, `Invoice ${inv.detail.invoice_number} is ${inv.status.toLowerCase().replace(/_/g, ' ')} and cannot be cancelled.`);
  await cancelInvoice(inv.id, 'This invoice was cancelled. Please disregard it.');
  res.json(summary(await getInvoice(inv.id)));
}));

/** Four older invoices at different stages, so the collections agent has something to work on. */
app.post('/api/demo/history', limit('demo', 6), wrap(async (req, res) => {
  const ref = workspace(req);
  const body = z.object({ invoicer: Name }).parse(req.body);
  const day = dayOf(req);
  const samples: Array<{ ago: number; term: TermDays; client: [string, string, string]; email: string; items: Array<[string, string, number, number]>; note: string }> = [
    { ago: 45, term: 15, client: ['Priya', 'Natarajan', 'Cedar Grove Physio'], email: 'accounts@cedargrovephysio.example.com', items: [['Brand Refresh', 'Logo update, colour palette and a one-page brand guide.', 750, 9500]], note: 'Thank you for the brand refresh project.' },
    { ago: 31, term: 15, client: ['Tom', 'Becker', 'Northgate Bakery Co.'], email: 'tom@northgatebakery.example.com', items: [['Online Ordering Page', 'Built the order form, pickup times and payment confirmation.', 540, 12000], ['Menu Photography Edits', 'Retouched and resized 24 menu photos.', 120, 9500]], note: 'Thanks for the online ordering work.' },
    { ago: 20, term: 15, client: ['Ana', 'Lima', 'Lumen Yoga Studio'], email: 'ana@lumenyoga.example.com', items: [['Class Schedule Widget', 'Weekly schedule with filters and booking links.', 390, 12000]], note: 'Thank you for having us build the schedule widget.' },
    { ago: 6, term: 30, client: ['Marcus', 'Hale', 'Hale & Wren Architects'], email: 'billing@halewren.example.com', items: [['Portfolio Site Updates', 'Added six projects and refreshed the team page.', 300, 9500]], note: 'Thanks for the portfolio updates.' }
  ];
  const made: InvoiceSummary[] = [];
  for (const s of samples) {
    const inv = await createInvoice(paypalInvoice({
      lines: s.items.map(([name, description, minutes, rateCents], n) => ({ id: `l${n + 1}`, name, description, minutes, rateCents, entryIds: [] })),
      currency: 'USD', invoicer: { ...body.invoicer, email: config.paypal.invoicerEmail },
      recipient: { givenName: s.client[0], surname: s.client[1], business: s.client[2], email: s.email },
      invoiceDate: addDays(day, -s.ago), termDays: s.term, note: s.note, reference: ref
    }));
    await sendInvoice(inv.id);
    made.push(summary(await getInvoice(inv.id), day));
  }
  res.status(201).json(made);
}));

app.get('/api/agent/run', limit('agent', 20), async (req, res) => {
  let reference: string;
  try { reference = workspace(req); } catch (e) { res.status(400).json({ error: (e as Error).message }); return; }
  const text = (v: unknown, fallback: string) => String(v ?? '').replace(/[^\p{L}\p{N} &'.,-]/gu, '').slice(0, 120) || fallback;
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  const emit = (e: AgentEvent) => res.write(`data: ${JSON.stringify(e)}\n\n`);
  const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
  try {
    if (!aiConfigured()) throw new AiUnavailable('No AI key is set, so the agent cannot run.');
    await runAgent({ reference, business: text(req.query.business, 'your studio'), signer: text(req.query.signer, 'the team'), autopilot: req.query.autopilot === '1', today: dayOf(req), emit });
  } catch (e) {
    emit({ type: 'error', message: e instanceof Error ? e.message : String(e) });
  } finally { clearInterval(ping); res.end(); }
});

// ---------- The web app ----------

const dist = resolve('web/dist');
if (existsSync(dist)) {
  app.use(express.static(dist, { index: false, maxAge: '1h' }));
  app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(join(dist, 'index.html')));
}

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof z.ZodError) { res.status(400).json({ error: `Some fields are not valid: ${err.issues.slice(0, 3).map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}` }); return; }
  if (err instanceof HttpError) { res.status(err.status).json({ error: err.message }); return; }
  if (err instanceof PayPalError) { res.status(err.status >= 500 ? 502 : 400).json({ error: err.message, debugId: err.debugId }); return; }
  console.error(err);
  res.status(500).json({ error: err instanceof Error ? err.message : 'Something went wrong.' });
});

app.listen(config.port, () => {
  const missing = missingSettings();
  console.log(`Logbill on http://localhost:${config.port}${missing.length ? ` (missing: ${missing.join(', ')})` : ''}${aiConfigured() ? '' : ' (no AI key: drafts fall back to one line per project)'}`);
});
