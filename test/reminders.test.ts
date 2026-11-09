import { beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PayPalInvoice } from '../server/paypal';

let rules: typeof import('../server/reminders');

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'logbill-'));
  rules = await import('../server/reminders');
});

const invoice = (id: string, status: PayPalInvoice['status'], due: string): PayPalInvoice =>
  ({ id, status, detail: { currency_code: 'USD', invoice_number: id, payment_term: { due_date: due } } });

describe('the rules every agent reminder must pass', () => {
  it('picks the tone from how late the invoice is', () => {
    expect(rules.toneFor(1)).toBe('friendly');
    expect(rules.toneFor(13)).toBe('friendly');
    expect(rules.toneFor(14)).toBe('firm');
    expect(rules.toneFor(30)).toBe('final');
  });

  it('only reminds unpaid invoices that are due or nearly due', () => {
    expect(rules.agentMayRemind(invoice('a', 'PAID', '2026-10-01'), '2026-11-08')).toMatchObject({ ok: false });
    expect(rules.agentMayRemind(invoice('b', 'PAYMENT_PENDING', '2026-10-01'), '2026-11-08')).toMatchObject({ ok: false });
    expect(rules.agentMayRemind(invoice('c', 'SENT', '2026-11-20'), '2026-11-08')).toMatchObject({ ok: false });
    expect(rules.agentMayRemind(invoice('d', 'SENT', '2026-11-10'), '2026-11-08')).toEqual({ ok: true }); // heads-up two days before
    expect(rules.agentMayRemind(invoice('e', 'UNPAID', '2026-10-01'), '2026-11-08')).toEqual({ ok: true });
    expect(rules.overdueDays(invoice('e', 'UNPAID', '2026-10-01'), '2026-11-08')).toBe(38);
  });

  it('waits three days between reminders and stops after three', () => {
    const inv = invoice('f', 'SENT', '2026-10-01');
    rules.record('f', { at: '2026-11-08T20:00:00Z', day: '2026-11-08', subject: 'one', by: 'agent' });
    expect(rules.agentMayRemind(inv, '2026-11-10')).toMatchObject({ ok: false, reason: expect.stringContaining('2026-11-11') });
    expect(rules.agentMayRemind(inv, '2026-11-11')).toEqual({ ok: true });
    rules.record('f', { at: '2026-11-11T20:00:00Z', day: '2026-11-11', subject: 'two', by: 'you' });
    rules.record('f', { at: '2026-11-14T20:00:00Z', day: '2026-11-14', subject: 'three', by: 'agent' });
    expect(rules.agentMayRemind(inv, '2026-12-01')).toMatchObject({ ok: false, reason: expect.stringContaining('3 reminders') });
    // No reminder before the due date once one was sent.
    rules.record('g', { at: '2026-11-08T20:00:00Z', day: '2026-11-08', subject: 'heads-up', by: 'agent' });
    expect(rules.agentMayRemind(invoice('g', 'SENT', '2026-11-10'), '2026-11-09')).toMatchObject({ ok: false });
  });
});
