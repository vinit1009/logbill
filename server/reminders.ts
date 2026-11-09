// The reminder log and the rules every reminder must pass, whoever sends it (you or the agent).

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.js';
import type { PayPalInvoice } from './paypal.js';
import { addDays, daysBetween } from '../shared/core.js';

export type Tone = 'friendly' | 'firm' | 'final';
/** `day` is the sender's local date, so the three-day spacing matches their calendar. */
export interface Reminder { at: string; day?: string; subject: string; tone?: Tone; by: 'you' | 'agent' }

const file = () => join(config.dataDir, 'reminders.json');
let log: Record<string, Reminder[]> | undefined;

function load(): Record<string, Reminder[]> {
  if (log) return log;
  try { log = JSON.parse(readFileSync(file(), 'utf8')) as Record<string, Reminder[]>; } catch { log = {}; }
  return log;
}

export const remindersFor = (invoiceId: string): Reminder[] => load()[invoiceId] ?? [];

export function record(invoiceId: string, r: Reminder): void {
  const all = load();
  all[invoiceId] = [...(all[invoiceId] ?? []), r];
  try { mkdirSync(config.dataDir, { recursive: true }); writeFileSync(file(), JSON.stringify(all)); } catch { /* the log is a convenience; PayPal is the record */ }
}

export const COOLDOWN_DAYS = 3;
export const MAX_REMINDERS = 3;
export const REMINDABLE = new Set(['SENT', 'UNPAID', 'PARTIALLY_PAID']);

export const today = (): string => new Date().toISOString().slice(0, 10);

/** Days past the due date (negative before it), or undefined without a due date. */
export function overdueDays(inv: PayPalInvoice, on = today()): number | undefined {
  const due = inv.detail.payment_term?.due_date;
  return due ? daysBetween(due, on) : undefined;
}

/** The tone the rules call for at this many days overdue. */
export const toneFor = (days: number): Tone => (days >= 30 ? 'final' : days >= 14 ? 'firm' : 'friendly');

/**
 * Whether the agent may send a reminder now: the invoice is unpaid and due (or due within two days with
 * no reminder yet), no reminder went out in the last three days, and fewer than three were sent.
 */
export function agentMayRemind(inv: PayPalInvoice, on = today()): { ok: true } | { ok: false; reason: string } {
  if (!REMINDABLE.has(inv.status)) return { ok: false, reason: `The invoice is ${inv.status.toLowerCase().replace(/_/g, ' ')}, so no reminder is needed.` };
  const days = overdueDays(inv, on);
  const sent = remindersFor(inv.id);
  if (days === undefined) return { ok: false, reason: 'The invoice has no due date.' };
  if (days < -2 || (days < 0 && sent.length)) return { ok: false, reason: `It is not due until ${inv.detail.payment_term?.due_date}.` };
  if (sent.length >= MAX_REMINDERS) return { ok: false, reason: `${MAX_REMINDERS} reminders were already sent; a person should follow up now.` };
  const last = sent[sent.length - 1];
  if (last) {
    const lastDay = last.day ?? last.at.slice(0, 10);
    const next = addDays(lastDay, COOLDOWN_DAYS);
    if (next > on) return { ok: false, reason: `A reminder went out on ${lastDay}; the next one can go on ${next}.` };
  }
  return { ok: true };
}
