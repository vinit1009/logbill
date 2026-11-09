// The shapes the browser and the server exchange.

import type { Draft, InvoiceLine, Party, TermDays, TimeEntry } from './core.js';

export interface Health {
  ok: boolean;
  paypal: boolean;
  ai: boolean;
  model: string;
  missing: string[];
  invoicerEmail: string;
  demoRecipient: string;
  recipientDomains: string[];
  /** True when PayPal webhooks reach this server, so payments show up at once. */
  webhooks: boolean;
}

export interface DraftRequest { entries: TimeEntry[]; rateCents: number; client: string; business: string }
export interface DraftResponse {
  draft: Draft;
  /** Should always be empty: the checks after the AI make every entry add up. */
  problems: string[];
  /** Why the AI was not used, when the draft fell back to one line per project. */
  aiError?: string;
  ms: number;
  cost?: number;
}

export interface SendRequest {
  lines: InvoiceLine[];
  currency: string;
  invoicer: Omit<Party, 'email'>;
  recipient: Party;
  invoiceDate: string;
  termDays: TermDays;
  note: string;
}

export interface ReminderView { at: string; day?: string; subject: string; tone?: 'friendly' | 'firm' | 'final'; by: 'you' | 'agent' }

export interface InvoiceSummary {
  id: string;
  number: string;
  status: string;
  client: string;
  contact: string;
  email: string;
  currency: string;
  total: string;
  due: string;
  paid: string;
  invoiceDate: string;
  dueDate: string;
  /** Days past the due date; negative before it; null without a due date. */
  daysOverdue: number | null;
  payerUrl: string;
  reminders: ReminderView[];
  items: Array<{ name: string; hours: string; rate: string }>;
  created: string;
}

export interface RemindRequest { subject: string; note: string; tone?: 'friendly' | 'firm' | 'final' }
