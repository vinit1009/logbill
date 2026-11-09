import { describe, expect, it } from 'vitest';
import Papa from 'papaparse';
import { readFileSync } from 'node:fs';
import {
  auditDraft, buildDraft, draftProblems, duplicates, entriesFromRows, hours, lineCents, longDays, moveEntry, parseDate,
  parseDuration, paypalInvoice, rateGroups, rulesDraft, titleCase, totalCents, type RawDraft, type TimeEntry
} from '../shared/core';

const entry = (id: string, over: Partial<TimeEntry> = {}): TimeEntry => ({
  id, date: '2026-10-01', client: 'Acme', project: 'Site', description: `work ${id}`, person: 'Maya', minutes: 60, billable: true, ...over
});

describe('timesheet parsing', () => {
  it('reads durations in every common format', () => {
    expect(parseDuration('1:30')).toBe(90);
    expect(parseDuration('01:30:00')).toBe(90);
    expect(parseDuration('1.5')).toBe(90);
    expect(parseDuration('1,25')).toBe(75);
    expect(parseDuration('1h 30m')).toBe(90);
    expect(parseDuration('45m')).toBe(45);
    expect(parseDuration('2h')).toBe(120);
    expect(parseDuration('')).toBe(0);
    expect(parseDuration('soon')).toBeNaN();
  });

  it('reads ISO, US and timestamp dates', () => {
    expect(parseDate('2026-10-05')).toBe('2026-10-05');
    expect(parseDate('10/05/2026')).toBe('2026-10-05');
    expect(parseDate('3/7/2026')).toBe('2026-03-07');
    expect(parseDate('2026-10-05T09:30:00+02:00')).toBe('2026-10-05');
    expect(parseDate('next week')).toBe('');
  });

  it('maps a Clockify export, rates included', () => {
    const csv = readFileSync('web/public/sample-timesheet.csv', 'utf8');
    const rows = Papa.parse<Record<string, string>>(csv, { header: true, skipEmptyLines: true }).data;
    const { entries, skipped } = entriesFromRows(rows);
    expect(skipped).toBe(0);
    expect(entries).toHaveLength(35);
    expect(entries[0]).toMatchObject({ date: '2026-10-01', person: 'Maya Ortiz', client: 'Juniper Lane Dental', minutes: 60, rateCents: 9500, billable: true });
    expect(entries.find((e) => e.description.startsWith('Lunch'))?.billable).toBe(false);
    expect(hours(entries.reduce((s, e) => s + e.minutes, 0))).toBe('88.17');
  });

  it('maps Toggl, Harvest and Jira style columns and skips rows it cannot read', () => {
    const toggl = entriesFromRows([{ 'Start date': '2026-10-02', Duration: '02:15:00', Description: 'Wireframes', Project: 'Site', Client: 'Acme', User: 'Ana' }]);
    expect(toggl.entries[0]).toMatchObject({ minutes: 135, person: 'Ana', project: 'Site' });
    const harvest = entriesFromRows([{ Date: '2026-10-03', Hours: '1.75', Notes: 'Call', 'Billable?': 'No', 'Billable Rate': '$120.00', Client: 'Acme', Project: 'Site', 'First Name': 'Jo' }]);
    expect(harvest.entries[0]).toMatchObject({ minutes: 105, billable: false, rateCents: 12000 });
    const jira = entriesFromRows([{ 'Work date': '2026-10-04', 'Time Spent (seconds)': '5400', 'Issue Key': 'WEB-12', Comment: 'Fix nav', Author: 'Lee' }]);
    expect(jira.entries[0]).toMatchObject({ minutes: 90, project: 'WEB-12', person: 'Lee', description: 'Fix nav' });
    const bad = entriesFromRows([{ Date: '', Hours: '2' }, { Date: '2026-10-01', Hours: '0' }, { Date: '2026-10-01', Hours: 'lots' }]);
    expect(bad).toEqual({ entries: [], skipped: 3 });
  });
});

describe('checks that need no AI', () => {
  it('finds exact duplicates but not similar entries', () => {
    const list = [entry('e1'), entry('e2', { description: 'WORK  e1' }), entry('e3', { minutes: 30, description: 'work e1' }), entry('e4', { person: 'Jo', description: 'work e1' })];
    expect([...duplicates(list)]).toEqual([['e2', 'e1']]);
  });

  it('flags every entry of a day over ten hours', () => {
    const flags = longDays([entry('e1', { minutes: 400 }), entry('e2', { minutes: 300 }), entry('e3', { person: 'Jo', minutes: 500 })]);
    expect(flags.map((f) => f.entryId)).toEqual(['e1', 'e2']);
    expect(flags[0]!.note).toContain('11.67 h');
  });

  it('groups entries by rate', () => {
    const g = rateGroups([entry('e1', { rateCents: 9500 }), entry('e2', { rateCents: 12000, person: 'Jo' }), entry('e3', { rateCents: 9500 })]);
    expect(g).toEqual([{ key: 'A', rateCents: 9500, people: ['Maya'], ids: ['e1', 'e3'] }, { key: 'B', rateCents: 12000, people: ['Jo'], ids: ['e2'] }]);
  });
});

describe('building a draft the numbers can be trusted on', () => {
  const entries = [
    entry('e1', { minutes: 90, rateCents: 9500 }),
    entry('e2', { minutes: 60, rateCents: 9500 }),
    entry('e3', { minutes: 45, rateCents: 12000, person: 'Jo' }),
    entry('e4', { minutes: 30, billable: false, description: 'Lunch' }),
    entry('e5', { minutes: 20, description: 'Invoice prep' }),
    entry('e6', { minutes: 90, rateCents: 9500, description: 'work e1' }) // exact duplicate of e1
  ];

  it('repairs what the model gets wrong and never changes the hours', () => {
    const raw: RawDraft = {
      lines: [
        { name: 'Design and Build', description: 'Designed and built the site.', entryIds: ['e1', 'e3', 'e99', 'e6'] },
        { name: 'Extra', description: 'Lunch.', entryIds: ['e1', 'e4', 'e5'] }
      ],
      excluded: [{ entryId: 'e5', reason: 'Internal admin' }],
      flags: [{ entryId: 'e3', note: 'Check this' }, { entryId: 'e6', note: 'Duplicate?' }],
      summary: 'Thanks!'
    };
    const d = buildDraft(raw, entries, 10000);
    expect(auditDraft(d, entries)).toEqual([]);
    // Mixed rates are split; the unknown id, the repeat, the duplicate and the non-billable entry are dropped from lines.
    expect(d.lines.map((l) => [l.name, l.entryIds, l.minutes, l.rateCents])).toEqual([
      ['Design and Build ($95.00/h)', ['e1', 'e2'], 150, 9500],
      ['Design and Build ($120.00/h)', ['e3'], 45, 12000],
      ['Extra', ['e5'], 20, 10000]
    ]);
    expect(d.excluded.map((x) => x.entryId).sort()).toEqual(['e4', 'e6']);
    expect(d.excluded.find((x) => x.entryId === 'e6')!.reason).toContain('duplicate of e1');
    // e5 was billed and excluded: billed wins, with a flag; e2 was missed and placed on the closest line.
    expect(d.flags.map((f) => f.entryId).sort()).toEqual(['e2', 'e3', 'e5']);
    expect(d.fixes.join(' ')).toMatch(/Ignored 1 entry reference/);
    expect(d.fixes.join(' ')).toMatch(/exact duplicate/);
    expect(totalCents(d.lines)).toBe(lineCents(d.lines[0]!) + lineCents(d.lines[1]!) + lineCents(d.lines[2]!));
  });

  it('puts missed entries on "Other work" when no line fits', () => {
    const d = buildDraft({ lines: [{ name: 'Design', description: '', entryIds: ['e1'] }], excluded: [], flags: [], summary: '' }, [entry('e1', { rateCents: 9500 }), entry('e2', { rateCents: 12000, project: 'Other' })], 10000);
    expect(d.lines.map((l) => l.name)).toEqual(['Design', 'Other work']);
    expect(d.flags[0]!.note).toContain('Other work');
  });

  it('tidies names and keeps them distinct', () => {
    expect(titleCase('Discovery And Sitemap For The Site')).toBe('Discovery and Sitemap for the Site');
    const d = buildDraft({ lines: [{ name: 'Kickoff', description: '', entryIds: ['a'] }, { name: 'Kickoff', description: '', entryIds: ['b'] }], excluded: [], flags: [], summary: '' },
      [entry('a', { rateCents: 9500 }), entry('b', { rateCents: 12000, person: 'Jo' })], 10000);
    expect(d.lines.map((l) => l.name)).toEqual(['Kickoff ($95.00/h)', 'Kickoff ($120.00/h)']);
  });

  it('words rule breaks so the model can fix them', () => {
    const p = draftProblems({ lines: [{ name: 'A', description: '', entryIds: ['e1', 'e3'] }, { name: 'a', description: '', entryIds: ['e1', 'zz'] }], excluded: [], flags: [], summary: '' }, entries);
    expect(p.join('\n')).toMatch(/mixes hourly rates.*group A: e1; group B: e3/);
    expect(p.join('\n')).toMatch(/zz, which is not in the timesheet/);
    expect(p.join('\n')).toMatch(/e1 is on more than one line/);
    expect(p.join('\n')).toMatch(/used twice/);
    expect(p.join('\n')).toMatch(/neither on a line nor excluded: e2, e4, e5/);
  });

  it('makes a rules-only draft when there is no AI', () => {
    const d = rulesDraft(entries, 10000);
    expect(d.source).toBe('rules');
    expect(auditDraft(d, entries)).toEqual([]);
    expect(d.lines.map((l) => [l.name, l.entryIds])).toEqual([['Site ($95.00/h)', ['e1', 'e2']], ['Site ($120.00/h)', ['e3']], ['Site ($100.00/h)', ['e5']]]);
  });

  it('moves entries between lines, to new lines and off the invoice', () => {
    let d = buildDraft({ lines: [{ name: 'Design', description: '', entryIds: ['e1', 'e2'] }], excluded: [], flags: [], summary: '' }, entries.slice(0, 2), 10000);
    d = moveEntry(d, entries, 'e2', { newLine: 'Brand', rateCents: 9500 });
    expect(d.lines.map((l) => [l.name, l.minutes])).toEqual([['Design', 90], ['Brand', 60]]);
    d = moveEntry(d, entries, 'e2', { exclude: 'Not this month' });
    expect(d.lines.map((l) => l.name)).toEqual(['Design']);
    expect(d.excluded).toEqual([{ entryId: 'e2', reason: 'Not this month' }]);
    d = moveEntry(d, entries, 'e2', { lineId: d.lines[0]!.id });
    expect(d.lines[0]!.minutes).toBe(150);
    expect(d.excluded).toEqual([]);
  });
});

describe('the PayPal invoice', () => {
  const line = { id: 'l1', name: 'Design', description: 'Homepage', minutes: 100, rateCents: 9500, entryIds: ['e1'] };
  const input = {
    lines: [line, { ...line, id: 'l2', minutes: 0 }], currency: 'USD',
    invoicer: { givenName: 'Maya', surname: 'Ortiz', email: 'merchant@business.example.com', business: 'Ortiz Studio' },
    recipient: { givenName: 'Dana', surname: 'Whitfield', email: 'billing@client.example.com' },
    invoiceDate: '2026-11-08', termDays: 30 as const, note: 'Thanks', reference: 'logbill-abc'
  };

  it('bills hours to two decimals at the hourly rate, as PayPal multiplies them', () => {
    const body = paypalInvoice(input) as { items: Array<{ quantity: string; unit_amount: { value: string }; unit_of_measure: string }>; detail: Record<string, unknown> };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({ quantity: '1.67', unit_amount: { value: '95.00' }, unit_of_measure: 'HOURS' });
    expect(lineCents(line)).toBe(Math.round(1.67 * 9500));
    expect(body.detail).toMatchObject({ payment_term: { term_type: 'NET_30' }, reference: 'logbill-abc', invoice_date: '2026-11-08' });
  });

  it('refuses an invoice with nothing to bill', () => {
    expect(() => paypalInvoice({ ...input, lines: [{ ...line, minutes: 0 }] })).toThrow(/no billable lines/);
  });
});
