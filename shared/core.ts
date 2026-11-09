// Pure rules shared by the server and the browser: timesheet parsing, invoice lines, money and the
// PayPal invoice payload. Money is held in integer cents and only turned into "123.45" at the edge.

export interface TimeEntry {
  id: string;
  date: string; // YYYY-MM-DD
  client: string;
  project: string;
  description: string;
  person: string;
  minutes: number;
  /** False when the time tracker already marked the entry non-billable. */
  billable: boolean;
  /** Hourly rate from the timesheet, when it has one. */
  rateCents?: number;
}

export interface InvoiceLine {
  id: string;
  name: string; // short item name shown on the invoice, e.g. "Design"
  description: string; // client-friendly summary of the work
  minutes: number;
  rateCents: number; // per hour
  entryIds: string[];
}

export interface Exclusion { entryId: string; reason: string }
export interface Flag { entryId: string; note: string }

export interface Draft {
  lines: InvoiceLine[];
  excluded: Exclusion[];
  /** Entries that are billed but worth a second look, e.g. a 12-hour day. */
  flags: Flag[];
  /** One or two sentences the invoice note can carry. */
  summary: string;
  /** Where the draft came from, so the screen can say so. */
  source: 'ai' | 'rules';
  /** What the checks after the AI changed, in plain words. */
  fixes: string[];
}

/** What the model is asked for: groupings and words only, never hours, rates or money. */
export interface RawDraft {
  lines: Array<{ name: string; description: string; entryIds: string[]; group?: string }>;
  excluded: Exclusion[];
  flags: Flag[];
  summary: string;
}

export const lineCents = (l: Pick<InvoiceLine, 'minutes' | 'rateCents'>): number => Math.round((Number(hours(l.minutes)) * l.rateCents));
export const totalCents = (lines: Array<Pick<InvoiceLine, 'minutes' | 'rateCents'>>): number => lines.reduce((s, l) => s + lineCents(l), 0);
/** Hours to two decimals, the quantity PayPal multiplies by the rate. */
export const hours = (minutes: number): string => (Math.round((minutes / 60) * 100) / 100).toFixed(2);
export const amount = (cents: number): string => (cents / 100).toFixed(2);
export const money = (cents: number, currency = 'USD'): string =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(cents / 100);
export const toCents = (text: string | number): number => {
  const n = typeof text === 'number' ? text : Number(String(text).replace(/[^0-9.,-]/g, '').replace(',', '.'));
  return Number.isFinite(n) ? Math.round(n * 100) : NaN;
};

// ---------- Timesheet CSV ----------

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const pick = (row: Record<string, string>, names: string[], prefixes: string[] = []): string => {
  for (const key of Object.keys(row)) {
    const k = norm(key);
    if (names.includes(k) || prefixes.some((p) => k.startsWith(p))) return String(row[key] ?? '').trim();
  }
  return '';
};

/** "1:30", "1:30:00", "1.5", "90m", "1h 30m" -> minutes. */
export function parseDuration(text: string): number {
  const t = text.trim().toLowerCase();
  if (!t) return 0;
  let m = t.match(/^(\d+):(\d{1,2})(?::(\d{1,2}))?$/);
  if (m) return Number(m[1]) * 60 + Number(m[2]) + Math.round(Number(m[3] ?? 0) / 60);
  m = t.match(/^(?:(\d+(?:\.\d+)?)\s*h)?\s*(?:(\d+)\s*m)?$/);
  if (m && (m[1] || m[2])) return Math.round(Number(m[1] ?? 0) * 60) + Number(m[2] ?? 0);
  const n = Number(t.replace(',', '.'));
  return Number.isFinite(n) ? Math.round(n * 60) : NaN;
}

/** Accepts YYYY-MM-DD, MM/DD/YYYY and Jira/Toggl timestamps; returns YYYY-MM-DD or ''. */
export function parseDate(text: string): string {
  const t = text.trim();
  let m = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return `${m[3]}-${m[1]!.padStart(2, '0')}-${m[2]!.padStart(2, '0')}`;
  return '';
}

const BILLABLE_NO = new Set(['no', 'false', '0', 'n', 'nonbillable']);

/**
 * Maps rows from Toggl, Clockify, Harvest or a Jira worklog export to time entries. Unknown columns are
 * ignored; rows without a date or a positive duration are counted as skipped instead of guessed.
 */
export function entriesFromRows(rows: Array<Record<string, string>>): { entries: TimeEntry[]; skipped: number } {
  const entries: TimeEntry[] = []; let skipped = 0;
  rows.forEach((row, n) => {
    const date = parseDate(pick(row, ['date', 'startdate', 'spentdate', 'started', 'workdate', 'day']));
    // Decimal hours ("1.5") and clock durations ("01:30:00", "1h 30m") both go through parseDuration.
    const durationText = pick(row, ['durationdecimal', 'hours', 'decimalhours', 'timespenthours']) || pick(row, ['durationh', 'duration', 'durationhhmmss', 'time', 'timespent']);
    const secondsText = pick(row, ['timespentseconds', 'seconds']);
    const minutes = durationText ? parseDuration(durationText) : secondsText ? Math.round(Number(secondsText) / 60) : NaN;
    if (!date || !Number.isFinite(minutes) || minutes <= 0) { skipped++; return; }
    const billableText = pick(row, ['billable', 'isbillable']);
    const rateText = pick(row, ['rate', 'hourlyrate'], ['billablerate']);
    const rateCents = rateText ? toCents(rateText) : NaN;
    entries.push({
      id: `e${n + 1}`,
      date,
      client: pick(row, ['client', 'clientname', 'customer', 'company']) || 'Client',
      project: pick(row, ['project', 'projectname', 'issue', 'issuekey', 'epic']) || 'General',
      description: pick(row, ['description', 'notes', 'task', 'comment', 'worklogcomment', 'summary']).slice(0, 300),
      person: pick(row, ['user', 'member', 'person', 'name', 'author', 'teammember']) || '',
      minutes,
      billable: billableText ? !BILLABLE_NO.has(norm(billableText)) : true,
      ...(Number.isFinite(rateCents) && rateCents > 0 ? { rateCents } : {})
    });
  });
  return { entries, skipped };
}

export function span(entries: Array<Pick<TimeEntry, 'date'>>): string {
  const dates = entries.map((e) => e.date).sort();
  if (!dates.length) return 'this period';
  return dates[0] === dates[dates.length - 1] ? dates[0]! : `${dates[0]} to ${dates[dates.length - 1]}`;
}

// ---------- Checks that need no AI ----------

const key = (e: TimeEntry) => [e.person.toLowerCase(), e.date, e.minutes, e.description.toLowerCase().replace(/\s+/g, ' ').trim()].join('|');

/** Entries that repeat an earlier entry exactly (same person, day, duration and note): id -> earlier id. */
export function duplicates(entries: TimeEntry[]): Map<string, string> {
  const first = new Map<string, string>(); const out = new Map<string, string>();
  for (const e of entries) {
    if (!e.description.trim()) continue;
    const k = key(e); const seen = first.get(k);
    if (seen) out.set(e.id, seen); else first.set(k, e.id);
  }
  return out;
}

export const LONG_DAY_MINUTES = 600;

/** Flags every entry of a person's day when that day adds up to more than ten hours. */
export function longDays(entries: TimeEntry[]): Flag[] {
  const days = new Map<string, TimeEntry[]>();
  for (const e of entries) if (e.billable) { const k = `${e.person}|${e.date}`; days.set(k, [...(days.get(k) ?? []), e]); }
  const flags: Flag[] = [];
  for (const list of days.values()) {
    const total = list.reduce((s, e) => s + e.minutes, 0);
    if (total > LONG_DAY_MINUTES) for (const e of list) flags.push({ entryId: e.id, note: `${e.person || 'One person'} logged ${hours(total)} h on ${e.date}; check nothing was logged twice` });
  }
  return flags;
}

export interface RateGroup { key: string; rateCents?: number; people: string[]; ids: string[] }

/** Entries split by hourly rate (A, B, ...), so each invoice line can stay within one rate. */
export function rateGroups(entries: TimeEntry[]): RateGroup[] {
  const by = new Map<string, RateGroup>();
  for (const e of entries) {
    const k = String(e.rateCents ?? 'none');
    const g = by.get(k) ?? { key: '', ...(e.rateCents ? { rateCents: e.rateCents } : {}), people: [], ids: [] };
    if (e.person && !g.people.includes(e.person)) g.people.push(e.person);
    g.ids.push(e.id); by.set(k, g);
  }
  return [...by.values()].map((g, n) => ({ ...g, key: String.fromCharCode(65 + (n % 26)) + (n >= 26 ? String(Math.floor(n / 26)) : '') }));
}

// ---------- Drafts ----------

/** A plain draft without AI: one line per project, non-billable entries left off. */
export function rulesDraft(entries: TimeEntry[], rateCents: number): Draft {
  const byProject = new Map<string, TimeEntry[]>();
  const excluded: Exclusion[] = [];
  for (const e of entries) {
    if (!e.billable) { excluded.push({ entryId: e.id, reason: 'Marked non-billable in the timesheet' }); continue; }
    byProject.set(e.project, [...(byProject.get(e.project) ?? []), e]);
  }
  const raw: RawDraft = {
    lines: [...byProject.entries()].map(([project, list]) => ({
      name: project, description: [...new Set(list.map((e) => e.description).filter(Boolean))].slice(0, 6).join('; '), entryIds: list.map((e) => e.id)
    })),
    excluded, flags: [], summary: `Work from ${span(entries)}.`
  };
  return { ...buildDraft(raw, entries, rateCents), source: 'rules', fixes: [] };
}

const clip = (s: unknown, n: number) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

const SMALL = new Set(['a', 'an', 'and', 'as', 'at', 'by', 'for', 'from', 'in', 'of', 'on', 'or', 'the', 'to', 'with', 'via']);
/** "Discovery And Sitemap" -> "Discovery and Sitemap"; leaves other capitals alone. */
export const titleCase = (name: string): string =>
  name.split(' ').map((w, i) => (i > 0 && SMALL.has(w.toLowerCase()) ? w.toLowerCase() : w)).join(' ');

/** Rule breaks in a model's draft, worded so the model can fix them in one more call. */
export function draftProblems(raw: RawDraft, entries: TimeEntry[]): string[] {
  const byId = new Map(entries.map((e) => [e.id, e]));
  const problems: string[] = [];
  const seen = new Set<string>();
  const dupes = duplicates(entries);
  const groupOf = new Map(rateGroups(entries).flatMap((g) => g.ids.map((id) => [id, g.key] as const)));
  for (const l of raw.lines) {
    const rates = new Set(l.entryIds.map((id) => byId.get(id)?.rateCents).filter((r): r is number => r !== undefined));
    if (rates.size > 1) {
      const split = [...new Set(l.entryIds.filter((id) => byId.has(id)).map((id) => groupOf.get(id)))].map((g) => `group ${g}: ${l.entryIds.filter((id) => groupOf.get(id) === g).join(', ')}`);
      problems.push(`Line "${l.name}" mixes hourly rates (${[...rates].map((r) => money(r)).join(' and ')}). Split it into one line per rate group (${split.join('; ')}), each named by the work done in it.`);
    }
    for (const id of l.entryIds) {
      if (!byId.has(id)) problems.push(`Line "${l.name}" lists ${id}, which is not in the timesheet.`);
      else if (seen.has(id)) problems.push(`${id} is on more than one line.`);
      seen.add(id);
    }
  }
  const names = raw.lines.map((l) => l.name.trim().toLowerCase());
  const twice = [...new Set(names.filter((n, i) => names.indexOf(n) !== i))];
  if (twice.length) problems.push(`Each line needs its own name; these names are used twice: ${twice.map((n) => `"${raw.lines.find((l) => l.name.trim().toLowerCase() === n)!.name}"`).join(', ')}. Name each by the work done in its group.`);
  for (const x of raw.excluded) seen.add(x.entryId);
  const missing = entries.filter((e) => !seen.has(e.id) && !dupes.has(e.id)).map((e) => e.id);
  if (missing.length) problems.push(`These entries are neither on a line nor excluded: ${missing.join(', ')}.`);
  return problems;
}

/**
 * Turns the model's grouping into a draft the numbers can be trusted on. The model only decides which
 * entries go together and how to word them; this decides hours, rates and money, and repairs anything
 * the model got wrong (unknown or repeated entries, missed entries, mixed rates, non-billable time).
 */
export function buildDraft(raw: RawDraft, entries: TimeEntry[], defaultRateCents: number): Draft {
  const byId = new Map(entries.map((e) => [e.id, e]));
  const fixes: string[] = [];
  const placed = new Map<string, string>(); // entry id -> line name or 'excluded'
  const flags: Flag[] = [];
  const excluded: Exclusion[] = [];
  const reasons = new Map<string, string>();
  // Exact duplicates are left off whatever the model said; the user can still bill one back.
  const dupes = duplicates(entries);
  for (const [id, of] of dupes) { reasons.set(id, `Exact duplicate of ${of}: same person, day, duration and note`); placed.set(id, 'excluded'); }
  for (const x of raw.excluded ?? []) if (byId.has(x.entryId) && !reasons.has(x.entryId)) reasons.set(x.entryId, clip(x.reason, 200) || 'Left off by the AI');

  // 1. Lines: keep known entries, each once; billed wins over a suggested exclusion.
  let unknown = 0; let repeats = 0; let alsoExcluded = 0; let nonBillable = 0; let dupBilled = 0;
  const groups: Array<{ name: string; description: string; ids: string[] }> = [];
  for (const l of raw.lines ?? []) {
    const ids: string[] = [];
    for (const id of l.entryIds ?? []) {
      const e = byId.get(id);
      if (!e) { unknown++; continue; }
      if (dupes.has(id)) { dupBilled++; continue; }
      if (placed.has(id)) { repeats++; continue; }
      if (!e.billable) { nonBillable++; continue; }
      if (reasons.has(id)) { alsoExcluded++; flags.push({ entryId: id, note: `Billed, but the AI also suggested leaving it off: ${reasons.get(id)}` }); reasons.delete(id); }
      placed.set(id, l.name); ids.push(id);
    }
    if (ids.length) groups.push({ name: clip(l.name, 120) || 'Work', description: clip(l.description, 900), ids });
  }
  if (unknown) fixes.push(`Ignored ${unknown} entry reference${unknown === 1 ? '' : 's'} the timesheet does not have.`);
  if (repeats) fixes.push(`Removed ${repeats} entr${repeats === 1 ? 'y' : 'ies'} the AI put on two lines, so nothing is billed twice.`);
  if (alsoExcluded) fixes.push(`${alsoExcluded} entr${alsoExcluded === 1 ? 'y was' : 'ies were'} both billed and suggested for leaving off; kept billed and flagged.`);
  if (dupBilled) fixes.push(`Left off ${dupBilled} exact duplicate${dupBilled === 1 ? '' : 's'} the AI had billed.`);
  if (nonBillable) fixes.push(`Left off ${nonBillable} entr${nonBillable === 1 ? 'y' : 'ies'} the timesheet marks non-billable.`);

  // 2. Exclusions: duplicates, the model's reasons, and anything the timesheet marks non-billable.
  for (const [id] of dupes) excluded.push({ entryId: id, reason: reasons.get(id)! });
  for (const e of entries) {
    if (placed.has(e.id)) continue;
    if (!e.billable) { excluded.push({ entryId: e.id, reason: reasons.get(e.id) ?? 'Marked non-billable in the timesheet' }); placed.set(e.id, 'excluded'); continue; }
    const reason = reasons.get(e.id);
    if (reason) { excluded.push({ entryId: e.id, reason }); placed.set(e.id, 'excluded'); }
  }

  // 3. Anything still unplaced is billed on the closest line (same project and rate, else same rate) or on
  //    "Other work", and flagged, so no time silently disappears.
  const missed = entries.filter((e) => !placed.has(e.id));
  const leftovers: TimeEntry[] = [];
  for (const e of missed) {
    const rateOf = (id: string) => byId.get(id)!.rateCents ?? defaultRateCents;
    // A line fits when it has entries at the same rate (lines are split by rate below) from the same project.
    const score = (g: { ids: string[] }) => {
      const same = g.ids.filter((id) => rateOf(id) === (e.rateCents ?? defaultRateCents));
      return same.length ? 1 + same.filter((id) => byId.get(id)!.project === e.project).length : 0;
    };
    const best = [...groups].sort((a, b) => score(b) - score(a))[0];
    if (best && score(best) > 1) {
      best.ids.push(e.id); placed.set(e.id, best.name);
      flags.push({ entryId: e.id, note: `The AI did not place this entry; Logbill put it on "${best.name}"` });
    } else leftovers.push(e);
  }
  if (leftovers.length) {
    groups.push({ name: 'Other work', description: [...new Set(leftovers.map((e) => e.description).filter(Boolean))].slice(0, 6).join('; '), ids: leftovers.map((e) => e.id) });
    for (const e of leftovers) { placed.set(e.id, 'Other work'); flags.push({ entryId: e.id, note: 'The AI did not place this entry; it is billed under Other work' }); }
  }
  if (missed.length) fixes.push(`Placed ${missed.length} entr${missed.length === 1 ? 'y' : 'ies'} the AI missed on the closest line.`);

  // 4. Rates and hours come from the timesheet; a line never mixes rates.
  const lines: InvoiceLine[] = [];
  let split = 0;
  for (const g of groups) {
    const byRate = new Map<number, string[]>();
    for (const id of g.ids) { const r = byId.get(id)!.rateCents ?? defaultRateCents; byRate.set(r, [...(byRate.get(r) ?? []), id]); }
    if (byRate.size > 1) split++;
    for (const [rate, ids] of byRate) {
      lines.push({
        id: `l${lines.length + 1}`,
        name: byRate.size > 1 ? clip(`${g.name} (${money(rate)}/h)`, 120) : g.name,
        description: g.description,
        minutes: ids.reduce((s, id) => s + byId.get(id)!.minutes, 0),
        rateCents: rate,
        entryIds: ids
      });
    }
  }
  if (split) fixes.push(`Split ${split} line${split === 1 ? '' : 's'} that mixed different hourly rates.`);
  const counts = new Map<string, number>();
  for (const l of lines) { l.name = titleCase(l.name); counts.set(l.name.toLowerCase(), (counts.get(l.name.toLowerCase()) ?? 0) + 1); }
  for (const l of lines) if ((counts.get(l.name.toLowerCase()) ?? 0) > 1) l.name = clip(`${l.name} (${money(l.rateCents)}/h)`, 120);

  // Flags: the checks that need no AI first, then the model's, one per entry, none on entries left off.
  for (const f of longDays(entries)) if (placed.get(f.entryId) !== 'excluded') flags.push(f);
  const flagged = new Set(flags.map((f) => f.entryId));
  for (const f of raw.flags ?? []) {
    if (!byId.has(f.entryId) || flagged.has(f.entryId) || placed.get(f.entryId) === 'excluded' || !clip(f.note, 200)) continue;
    flags.push({ entryId: f.entryId, note: clip(f.note, 200) }); flagged.add(f.entryId);
  }
  return { lines, excluded, flags, summary: clip(raw.summary, 600) || `Work from ${span(entries)}.`, source: 'ai', fixes };
}

/**
 * Checks a draft against its entries: every entry is billed once or left off with a reason, nothing is
 * invented, and each line's minutes equal the sum of its entries. Returns the problems found.
 */
export function auditDraft(draft: Pick<Draft, 'lines' | 'excluded'>, entries: TimeEntry[]): string[] {
  const problems: string[] = [];
  const byId = new Map(entries.map((e) => [e.id, e]));
  const seen = new Map<string, string>();
  for (const l of draft.lines) {
    let sum = 0;
    for (const id of l.entryIds) {
      const e = byId.get(id);
      if (!e) { problems.push(`${l.name}: unknown entry ${id}`); continue; }
      if (seen.has(id)) problems.push(`${id} is billed twice (${seen.get(id)} and ${l.name})`);
      seen.set(id, l.name); sum += e.minutes;
    }
    if (sum !== l.minutes) problems.push(`${l.name}: ${hours(l.minutes)} h on the line but its entries add up to ${hours(sum)} h`);
    if (!(l.rateCents >= 0)) problems.push(`${l.name}: no rate`);
  }
  for (const x of draft.excluded) {
    if (!byId.has(x.entryId)) problems.push(`excluded entry ${x.entryId} does not exist`);
    else if (seen.has(x.entryId)) problems.push(`${x.entryId} is both billed and left off`);
    else seen.set(x.entryId, 'excluded');
  }
  for (const e of entries) if (!seen.has(e.id)) problems.push(`${e.id} (${e.description || e.project}) is neither billed nor left off`);
  return problems;
}

/**
 * Moves one entry to another line, to a new line or off the invoice, and recomputes the minutes, so
 * the screen can never show hours that differ from the timesheet. Empty lines disappear.
 */
export function moveEntry(draft: Draft, entries: TimeEntry[], entryId: string, to: { lineId: string } | { newLine: string; rateCents: number } | { exclude: string }): Draft {
  const byId = new Map(entries.map((e) => [e.id, e]));
  if (!byId.has(entryId)) return draft;
  let lines = draft.lines.map((l) => ({ ...l, entryIds: l.entryIds.filter((id) => id !== entryId) }));
  let excluded = draft.excluded.filter((x) => x.entryId !== entryId);
  if ('lineId' in to) lines = lines.map((l) => (l.id === to.lineId ? { ...l, entryIds: [...l.entryIds, entryId] } : l));
  else if ('newLine' in to) {
    const next = Math.max(0, ...lines.map((l) => Number(l.id.slice(1)) || 0)) + 1;
    lines.push({ id: `l${next}`, name: clip(to.newLine, 120) || 'Work', description: byId.get(entryId)!.description, minutes: 0, rateCents: to.rateCents, entryIds: [entryId] });
  } else excluded = [...excluded, { entryId, reason: clip(to.exclude, 200) || 'Left off by you' }];
  lines = lines.filter((l) => l.entryIds.length).map((l) => ({ ...l, minutes: l.entryIds.reduce((s, id) => s + (byId.get(id)?.minutes ?? 0), 0) }));
  return { ...draft, lines, excluded, flags: draft.flags };
}

// ---------- PayPal invoice ----------

export interface Party { givenName: string; surname: string; email: string; business?: string }
export type TermDays = 0 | 10 | 15 | 30 | 45 | 60 | 90;
export interface InvoiceInput {
  lines: InvoiceLine[];
  currency: string;
  invoicer: Party;
  recipient: Party;
  invoiceNumber?: string;
  invoiceDate: string; // YYYY-MM-DD
  termDays: TermDays;
  note: string;
  /** Tags the invoice so a session only sees its own invoices. */
  reference?: string;
}

export const TERM: Record<TermDays, string> = { 0: 'DUE_ON_RECEIPT', 10: 'NET_10', 15: 'NET_15', 30: 'NET_30', 45: 'NET_45', 60: 'NET_60', 90: 'NET_90' };

/** The body of POST /v2/invoicing/invoices. Quantities are hours to two decimals, rates per hour. */
export function paypalInvoice(input: InvoiceInput): Record<string, unknown> {
  const items = input.lines.filter((l) => l.minutes > 0).map((l) => ({
    name: l.name.slice(0, 200),
    ...(l.description ? { description: l.description.slice(0, 1000) } : {}),
    quantity: hours(l.minutes),
    unit_amount: { currency_code: input.currency, value: amount(l.rateCents) },
    unit_of_measure: 'HOURS'
  }));
  if (!items.length) throw new Error('The invoice has no billable lines.');
  const name = (p: Party) => ({ given_name: p.givenName.slice(0, 140), surname: p.surname.slice(0, 140) });
  return {
    detail: {
      currency_code: input.currency,
      ...(input.invoiceNumber ? { invoice_number: input.invoiceNumber.slice(0, 25) } : {}),
      ...(input.reference ? { reference: input.reference.slice(0, 120) } : {}),
      invoice_date: input.invoiceDate,
      payment_term: { term_type: TERM[input.termDays] },
      note: input.note.slice(0, 4000)
    },
    invoicer: { name: name(input.invoicer), email_address: input.invoicer.email, ...(input.invoicer.business ? { business_name: input.invoicer.business.slice(0, 300) } : {}) },
    primary_recipients: [{ billing_info: { name: name(input.recipient), email_address: input.recipient.email, ...(input.recipient.business ? { business_name: input.recipient.business.slice(0, 300) } : {}) } }],
    items,
    configuration: { allow_tip: false, tax_calculated_after_discount: true, tax_inclusive: false }
  };
}

/** Adds days to a YYYY-MM-DD date. */
export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10);
}
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000);
}
