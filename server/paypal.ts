// A small client for the PayPal REST APIs Logbill uses: OAuth and Invoicing v2 (create, send, read,
// search, remind, cancel, QR code). Errors come back as readable messages with PayPal's debug id.

import { config } from './config.js';

export class PayPalError extends Error {
  constructor(message: string, readonly status: number, readonly debugId?: string, readonly issues: string[] = []) { super(message); }
}

let token: { value: string; expires: number } | undefined;

async function accessToken(): Promise<string> {
  if (token && token.expires > Date.now() + 60_000) return token.value;
  const basic = Buffer.from(`${config.paypal.clientId}:${config.paypal.clientSecret}`).toString('base64');
  const res = await fetch(`${config.paypal.baseUrl}/v1/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials'
  });
  if (!res.ok) throw new PayPalError(`PayPal sign-in failed (${res.status}). Check PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET.`, res.status);
  const body = (await res.json()) as { access_token: string; expires_in: number };
  token = { value: body.access_token, expires: Date.now() + body.expires_in * 1000 };
  return token.value;
}

export async function paypal<T = unknown>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  const send = async () => fetch(`${config.paypal.baseUrl}${path}`, {
    method,
    headers: { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/json', ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {})
  });
  let res = await send();
  if (res.status === 401) { token = undefined; res = await send(); }
  const text = await res.text();
  if (!res.ok) {
    let parsed: { name?: string; message?: string; debug_id?: string; details?: Array<{ issue?: string; description?: string; field?: string }> } = {};
    try { parsed = JSON.parse(text); } catch { /* not JSON */ }
    const issues = (parsed.details ?? []).map((d) => [d.field?.replace(/^\//, ''), d.description ?? d.issue].filter(Boolean).join(': '));
    throw new PayPalError(`PayPal: ${issues[0] ?? parsed.message ?? (text.slice(0, 200) || res.statusText)}`, res.status, parsed.debug_id, issues);
  }
  return (text ? JSON.parse(text) : undefined) as T;
}

// ---------- Invoices ----------

export interface Money { currency_code: string; value: string }
export interface PayPalInvoice {
  id: string;
  status: 'DRAFT' | 'SENT' | 'SCHEDULED' | 'PAID' | 'MARKED_AS_PAID' | 'CANCELLED' | 'REFUNDED' | 'PARTIALLY_PAID' | 'PARTIALLY_REFUNDED' | 'MARKED_AS_REFUNDED' | 'UNPAID' | 'PAYMENT_PENDING';
  detail: {
    invoice_number?: string; reference?: string; invoice_date?: string; currency_code: string; note?: string;
    payment_term?: { term_type?: string; due_date?: string };
    metadata?: { create_time?: string; last_update_time?: string; recipient_view_url?: string; invoicer_view_url?: string; first_sent_time?: string; last_sent_time?: string };
  };
  primary_recipients?: Array<{ billing_info?: { name?: { given_name?: string; surname?: string; full_name?: string }; business_name?: string; email_address?: string } }>;
  amount?: Money & { breakdown?: unknown };
  due_amount?: Money;
  payments?: { paid_amount?: Money; transactions?: Array<{ payment_date?: string; amount?: Money; method?: string }> };
  items?: Array<{ name: string; description?: string; quantity: string; unit_amount: Money }>;
}

export const createInvoice = (body: Record<string, unknown>) =>
  paypal<PayPalInvoice>('POST', '/v2/invoicing/invoices', body, { Prefer: 'return=representation' });

export const sendInvoice = (id: string, note?: string) =>
  paypal<{ href?: string; links?: Array<{ href: string; rel: string }> }>('POST', `/v2/invoicing/invoices/${encodeURIComponent(id)}/send`,
    { send_to_invoicer: false, send_to_recipient: true, ...(note ? { note: note.slice(0, 4000) } : {}) });

export const getInvoice = (id: string) => paypal<PayPalInvoice>('GET', `/v2/invoicing/invoices/${encodeURIComponent(id)}`);

export const deleteDraft = (id: string) => paypal('DELETE', `/v2/invoicing/invoices/${encodeURIComponent(id)}`);

/** Every invoice carrying this reference, newest first (PayPal pages at 100). */
export async function invoicesFor(reference: string): Promise<PayPalInvoice[]> {
  const out: PayPalInvoice[] = [];
  for (let page = 1; page <= 5; page++) {
    const res = await paypal<{ items?: PayPalInvoice[]; total_pages?: number }>('POST', `/v2/invoicing/search-invoices?page=${page}&page_size=100&total_required=true`, { reference });
    out.push(...(res.items ?? []).filter((i) => i.detail.reference === reference));
    if (!res.total_pages || page >= res.total_pages) break;
  }
  return out.sort((a, b) => String(b.detail.metadata?.create_time ?? '').localeCompare(String(a.detail.metadata?.create_time ?? '')));
}

export const remindInvoice = (id: string, subject: string, note: string) =>
  paypal('POST', `/v2/invoicing/invoices/${encodeURIComponent(id)}/remind`,
    { subject: subject.slice(0, 4000), note: note.slice(0, 4000), send_to_invoicer: false, send_to_recipient: true });

export const cancelInvoice = (id: string, note: string) =>
  paypal('POST', `/v2/invoicing/invoices/${encodeURIComponent(id)}/cancel`,
    { subject: 'Invoice cancelled', note: note.slice(0, 4000), send_to_invoicer: false, send_to_recipient: true });

/** A PNG QR code that opens the invoice's payment page, as a data URL. */
export async function invoiceQr(id: string): Promise<string> {
  const res = await fetch(`${config.paypal.baseUrl}/v2/invoicing/invoices/${encodeURIComponent(id)}/generate-qr-code`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ width: 240, height: 240, action: 'pay' })
  });
  const text = await res.text();
  if (!res.ok) throw new PayPalError(`PayPal could not make a QR code (${res.status}).`, res.status);
  // The body is the base64 PNG inside a small multipart envelope; the PNG starts with "iVBOR".
  const start = text.indexOf('iVBOR');
  const b64 = start < 0 ? '' : (text.slice(start).match(/^[A-Za-z0-9+/=\s]+/)?.[0] ?? '').replace(/\s+/g, '');
  if (!b64) throw new PayPalError('PayPal returned an empty QR code.', 502);
  return `data:image/png;base64,${b64}`;
}

export const payerLink = (inv: PayPalInvoice): string | undefined => inv.detail.metadata?.recipient_view_url;
