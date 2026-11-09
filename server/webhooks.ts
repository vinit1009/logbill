// PayPal webhooks. Logbill registers one webhook for its public URL (Webhooks API), checks every
// delivery's signature, and pushes invoice events to the browsers of the workspace the invoice belongs
// to, so a payment shows up the moment PayPal confirms it. The 15-second poll stays as a fallback.

import { createVerify } from 'node:crypto';
import { crc32 } from 'node:zlib';
import type { Request, Response } from 'express';
import { config } from './config.js';
import { getInvoice, paypal } from './paypal.js';

export const EVENTS = ['INVOICING.INVOICE.PAID', 'INVOICING.INVOICE.CANCELLED', 'INVOICING.INVOICE.REFUNDED', 'INVOICING.INVOICE.UPDATED'];

export interface InvoiceEvent { type: 'invoice'; event: string; invoiceId: string; number: string; status: string; at: string }

let webhookId: string | undefined;
export const webhookUrl = (): string | undefined => (config.publicUrl ? `${config.publicUrl}/api/paypal/webhook` : undefined);

/** Finds or creates the webhook for this server's public URL. */
export async function ensureWebhook(): Promise<string | undefined> {
  const url = webhookUrl();
  if (!url) return undefined;
  const list = await paypal<{ webhooks?: Array<{ id: string; url: string }> }>('GET', '/v1/notifications/webhooks');
  const found = list.webhooks?.find((w) => w.url === url);
  webhookId = found?.id ?? (await paypal<{ id: string }>('POST', '/v1/notifications/webhooks', { url, event_types: EVENTS.map((name) => ({ name })) })).id;
  return webhookId;
}

// ---------- Signature checks ----------

const certs = new Map<string, string>();
async function cert(url: string): Promise<string> {
  const u = new URL(url);
  // Only PayPal's own certificate hosts are trusted.
  if (u.protocol !== 'https:' || !(u.hostname === 'api.paypal.com' || u.hostname === 'api.sandbox.paypal.com' || u.hostname.endsWith('.paypal.com'))) throw new Error('untrusted certificate URL');
  if (!certs.has(url)) {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`certificate download failed (${res.status})`);
    certs.set(url, await res.text());
  }
  return certs.get(url)!;
}

/** PayPal signs "<transmission id>|<time>|<webhook id>|<crc32 of the raw body>" with SHA256withRSA. */
export async function verifyLocally(raw: Buffer, h: (name: string) => string, id: string): Promise<boolean> {
  if (!/SHA256withRSA/i.test(h('paypal-auth-algo'))) return false;
  const message = `${h('paypal-transmission-id')}|${h('paypal-transmission-time')}|${id}|${crc32(raw) >>> 0}`;
  const verifier = createVerify('RSA-SHA256');
  verifier.update(message);
  return verifier.verify(await cert(h('paypal-cert-url')), Buffer.from(h('paypal-transmission-sig'), 'base64'));
}

async function verifyWithPayPal(event: unknown, h: (name: string) => string, id: string): Promise<boolean> {
  const res = await paypal<{ verification_status?: string }>('POST', '/v1/notifications/verify-webhook-signature', {
    auth_algo: h('paypal-auth-algo'), cert_url: h('paypal-cert-url'), transmission_id: h('paypal-transmission-id'),
    transmission_sig: h('paypal-transmission-sig'), transmission_time: h('paypal-transmission-time'), webhook_id: id, webhook_event: event
  });
  return res.verification_status === 'SUCCESS';
}

// ---------- Delivery to browsers ----------

const listeners = new Map<string, Set<Response>>();
const recent: Array<InvoiceEvent & { reference: string }> = [];

/** Streams this workspace's invoice events to one browser (Server-Sent Events). */
export function subscribe(reference: string, res: Response): void {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write(`data: ${JSON.stringify({ type: 'hello', webhooks: Boolean(webhookId) })}\n\n`);
  const set = listeners.get(reference) ?? new Set<Response>();
  set.add(res); listeners.set(reference, set);
  const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
  res.on('close', () => { clearInterval(ping); set.delete(res); if (!set.size) listeners.delete(reference); });
}

function publish(reference: string, e: InvoiceEvent): void {
  recent.push({ ...e, reference }); if (recent.length > 200) recent.shift();
  for (const res of listeners.get(reference) ?? []) res.write(`data: ${JSON.stringify(e)}\n\n`);
}

/** The route PayPal calls. Answers 200 once the signature checks out, then looks the invoice up. */
export async function receive(req: Request, res: Response): Promise<void> {
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
  const h = (name: string) => String(req.header(name) ?? '');
  let event: { event_type?: string; resource?: { id?: string; invoice?: { id?: string } } };
  try { event = JSON.parse(raw.toString('utf8')); } catch { res.status(400).end(); return; }
  if (!webhookId) { res.status(503).end(); return; }
  let ok = false;
  try { ok = await verifyLocally(raw, h, webhookId); } catch { ok = false; }
  if (!ok) { try { ok = await verifyWithPayPal(event, h, webhookId); } catch { ok = false; } }
  if (!ok) { console.warn('webhook signature rejected', h('paypal-transmission-id')); res.status(400).end(); return; }
  res.status(200).end();
  const invoiceId = event.resource?.invoice?.id ?? event.resource?.id;
  if (!invoiceId || !String(event.event_type ?? '').startsWith('INVOICING.INVOICE.')) return;
  try {
    const inv = await getInvoice(invoiceId);
    if (!inv.detail.reference?.startsWith('logbill-')) return;
    publish(inv.detail.reference, { type: 'invoice', event: String(event.event_type), invoiceId: inv.id, number: inv.detail.invoice_number ?? '', status: inv.status, at: new Date().toISOString() });
  } catch (e) { console.warn('webhook lookup failed', e instanceof Error ? e.message : e); }
}

export const webhookStatus = () => ({ registered: Boolean(webhookId), url: webhookUrl() ?? null });
