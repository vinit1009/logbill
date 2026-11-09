// Calls the language model through any OpenAI-compatible chat endpoint (OpenRouter by default) and
// drafts invoice lines from time entries. The model groups and words; it never sets hours or money.

import { z } from 'zod';
import { config } from './config.js';
import type { RawDraft, TimeEntry } from '../shared/core.js';
import { draftProblems, duplicates, rateGroups, span } from '../shared/core.js';

export interface ToolCall { id: string; type: 'function'; function: { name: string; arguments: string } }
export type Message =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };
export interface Tool { type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }
export interface Usage { prompt_tokens?: number; completion_tokens?: number; cost?: number }

export class AiUnavailable extends Error {}

let day = ''; let calls = 0;
function count(): void {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== day) { day = today; calls = 0; }
  if (calls >= config.ai.dailyLimit) throw new AiUnavailable('The AI has reached its daily limit on this demo. Try again tomorrow.');
  calls++;
}

export const aiConfigured = (): boolean => Boolean(config.ai.apiKey);

export async function chat(messages: Message[], options: { tools?: Tool[]; toolChoice?: string; maxTokens?: number; temperature?: number } = {}): Promise<{ message: Extract<Message, { role: 'assistant' }>; usage: Usage }> {
  if (!aiConfigured()) throw new AiUnavailable('No AI key is set (AI_API_KEY).');
  count();
  const res = await fetch(`${config.ai.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.ai.apiKey}`, 'Content-Type': 'application/json', 'HTTP-Referer': 'https://github.com/vinit1009/logbill', 'X-Title': 'Logbill' },
    body: JSON.stringify({
      model: config.ai.model,
      messages,
      max_tokens: options.maxTokens ?? 4000,
      temperature: options.temperature ?? 0.2,
      ...(options.tools ? { tools: options.tools } : {}),
      ...(options.toolChoice ? { tool_choice: options.toolChoice === 'auto' || options.toolChoice === 'required' ? options.toolChoice : { type: 'function', function: { name: options.toolChoice } } } : {})
    }),
    signal: AbortSignal.timeout(90_000)
  });
  const body = (await res.json().catch(() => ({}))) as { choices?: Array<{ message?: Extract<Message, { role: 'assistant' }> }>; usage?: Usage; error?: { message?: string } };
  if (!res.ok || !body.choices?.[0]?.message) throw new AiUnavailable(`The AI did not answer (${res.status}${body.error?.message ? `: ${body.error.message}` : ''}).`);
  return { message: body.choices[0].message, usage: body.usage ?? {} };
}

// ---------- Drafting invoice lines ----------

const RawDraftSchema = z.object({
  lines: z.array(z.object({ group: z.string().optional(), name: z.string(), description: z.string().default(''), entryIds: z.array(z.string()) })).default([]),
  excluded: z.array(z.object({ entryId: z.string(), reason: z.string().default('') })).default([]),
  flags: z.array(z.object({ entryId: z.string(), note: z.string() })).default([]),
  summary: z.string().default('')
});

const SUBMIT_DRAFT: Tool = {
  type: 'function',
  function: {
    name: 'submit_draft',
    description: 'Submit the invoice lines, the entries to leave off, the entries to flag, and the invoice note.',
    parameters: {
      type: 'object',
      properties: {
        lines: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              group: { type: 'string', description: 'The rate group of every entry on this line (when the timesheet has rateGroups).' },
              name: { type: 'string', description: '2 to 5 words, Title Case: what the client paid for.' },
              description: { type: 'string', description: 'One or two plain past-tense sentences a client understands.' },
              entryIds: { type: 'array', items: { type: 'string' } }
            },
            required: ['name', 'description', 'entryIds']
          }
        },
        excluded: { type: 'array', items: { type: 'object', properties: { entryId: { type: 'string' }, reason: { type: 'string', description: 'Short reason the freelancer will read.' } }, required: ['entryId', 'reason'] } },
        flags: { type: 'array', items: { type: 'object', properties: { entryId: { type: 'string' }, note: { type: 'string' } }, required: ['entryId', 'note'] } },
        summary: { type: 'string', description: 'One or two sentences for the invoice note, to the client; no amounts.' }
      },
      required: ['lines', 'excluded', 'flags', 'summary']
    }
  }
};

const DRAFT_RULES = `You prepare invoice lines from time entries logged by a freelancer or a small agency.

Group the entries into a few client-ready invoice lines (usually 2 to 7) by deliverable or kind of work, not by day or by person.
For each line:
- name: 2 to 5 words in Title Case naming what the client paid for, e.g. "Homepage Design" or "Booking API Integration".
- description: one or two plain past-tense sentences a client's manager understands. Mention concrete outcomes found in the entries. No ticket numbers, no people's names, no internal jargon, no complaints, and never work that is not in the entries.
- entryIds: the ids of the entries on that line.

Leave an entry off the invoice (in "excluded", with a short reason the freelancer will read) only when it is clearly not billable to this client: internal admin or bookkeeping, preparing this invoice, personal items, learning unrelated to the client, work for a different client, an entry whose note says it is free, not billable or a courtesy, or an exact duplicate of another entry (same person, same day, same duration, same text). Entries with "billable": false must be left off.
Flag (in "flags") entries worth a second look: vague notes such as "stuff" or "misc", or anything ambiguous. A flagged entry is still billed, so it must also be in a line's entryIds (put a vague entry on the line of the same project and rate). Keep each flag under 15 words. The app itself flags long days and duplicates.
When the timesheet has rateGroups (A, B, ...; each a different hourly rate), every line belongs to exactly one group: set the line's "group" and list only entries of that group on it. When similar work happened in two groups (for example a kickoff call attended by a designer and a developer), make one line per group and name each by the work done in it, e.g. "Kickoff and Planning: Design" and "Kickoff and Planning: Development". Work out the groups' lines one group at a time.
Entries with a "duplicateOf" field repeat another entry exactly; the app leaves them off, so put them in "excluded".
Every entry goes in exactly one place: one line, or excluded. Do not compute hours, rates or money; the app does that.
summary: one or two sentences for the invoice note, addressed to the client, thanking them and summarizing the work of the period. No amounts, no sign-off.
Answer only by calling submit_draft.`;

export async function draftLines(entries: TimeEntry[], ctx: { client: string; business: string }): Promise<{ raw: RawDraft; usage: Usage }> {
  const dupes = duplicates(entries);
  const groups = rateGroups(entries);
  const multi = groups.length > 1;
  const groupOf = new Map(groups.flatMap((g) => g.ids.map((id) => [id, g.key] as const)));
  const payload = {
    from: ctx.business, client: ctx.client, period: span(entries),
    ...(multi ? { rateGroups: groups.map((g) => ({ group: g.key, ...(g.rateCents ? { hourlyRate: g.rateCents / 100 } : {}), people: g.people, entries: g.ids.length })) } : {}),
    entries: entries.map((e) => ({
      id: e.id, date: e.date, person: e.person || undefined, project: e.project, minutes: e.minutes, billable: e.billable,
      ...(multi ? { group: groupOf.get(e.id) } : {}), ...(dupes.has(e.id) ? { duplicateOf: dupes.get(e.id) } : {}), note: e.description
    }))
  };
  const messages: Message[] = [{ role: 'system', content: DRAFT_RULES }, { role: 'user', content: JSON.stringify(payload) }];
  const total: Usage = { prompt_tokens: 0, completion_tokens: 0, cost: 0 };
  const add = (u: Usage) => { total.prompt_tokens! += u.prompt_tokens ?? 0; total.completion_tokens! += u.completion_tokens ?? 0; total.cost! += u.cost ?? 0; };
  let best: { raw: RawDraft; problems: string[] } | undefined;
  let lastError = '';
  // Up to three calls: a draft, then one correction if the draft breaks a rule, with one retry for an unreadable answer.
  for (let attempt = 0; attempt < 3; attempt++) {
    const { message, usage } = await chat(messages, { tools: [SUBMIT_DRAFT], toolChoice: 'submit_draft', maxTokens: 6000 });
    add(usage);
    const call = message.tool_calls?.find((c) => c.function.name === 'submit_draft');
    let raw: RawDraft | undefined;
    try {
      if (!call) throw new Error('no submit_draft call');
      raw = RawDraftSchema.parse(JSON.parse(call.function.arguments));
    } catch (e) { lastError = e instanceof Error ? e.message.slice(0, 200) : 'unreadable'; }
    if (!raw) { messages.push({ role: 'user', content: `Your answer could not be read (${lastError}). Call submit_draft again with valid arguments.` }); continue; }
    const problems = draftProblems(raw, entries);
    if (!best || problems.length < best.problems.length) best = { raw, problems };
    if (!problems.length || attempt >= 1) break;
    messages.push({ role: 'assistant', content: null, tool_calls: [call!] });
    messages.push({ role: 'tool', tool_call_id: call!.id, content: `The draft breaks these rules:\n- ${problems.join('\n- ')}\nCall submit_draft again with the complete corrected draft (all lines, exclusions, flags and the summary).` });
  }
  if (best) return { raw: best.raw, usage: total };
  throw new AiUnavailable(`The AI's draft could not be read (${lastError}).`);
}
