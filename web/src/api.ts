// Talks to Logbill's server. Every call carries this browser's workspace id.

import type { DraftRequest, DraftResponse, Health, InvoiceSummary, RemindRequest, SendRequest } from '../../shared/api';

const SESSION_KEY = 'logbill.session';
const VALID = /^[a-z0-9-]{8,64}$/;

// A workspace link (?ws=<id>) opens the same workspace in another browser; the id is then
// taken out of the address bar.
(() => {
  const url = new URL(location.href);
  const ws = (url.searchParams.get('ws') ?? '').toLowerCase();
  if (!ws) return;
  if (VALID.test(ws)) localStorage.setItem(SESSION_KEY, ws);
  url.searchParams.delete('ws');
  history.replaceState(null, '', url.pathname + url.search + url.hash);
})();

/** A link that opens this workspace elsewhere. */
export const workspaceLink = (): string => `${location.origin}/?ws=${sessionId()}${location.hash}`;

export function sessionId(): string {
  let id = localStorage.getItem(SESSION_KEY);
  if (!id || !VALID.test(id)) { id = crypto.randomUUID().toLowerCase(); localStorage.setItem(SESSION_KEY, id); }
  return id;
}
export function newWorkspace(): void { localStorage.setItem(SESSION_KEY, crypto.randomUUID().toLowerCase()); }

/** The browser's own date, so "overdue" means the same thing on screen as in the user's day. */
export const localToday = (): string => {
  const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json', 'x-logbill-session': sessionId(), 'x-logbill-today': localToday() },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {})
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string; debugId?: string };
  if (!res.ok) throw new Error((data.error ?? `Request failed (${res.status})`) + (data.debugId ? ` (PayPal debug id ${data.debugId})` : ''));
  return data;
}

export const api = {
  health: () => call<Health>('GET', '/api/health'),
  draft: (body: DraftRequest) => call<DraftResponse>('POST', '/api/draft', body),
  invoices: () => call<InvoiceSummary[]>('GET', '/api/invoices'),
  send: (body: SendRequest) => call<InvoiceSummary>('POST', '/api/invoices', body),
  qr: (id: string) => call<{ dataUrl: string }>('GET', `/api/invoices/${encodeURIComponent(id)}/qr`),
  remind: (id: string, body: RemindRequest) => call<InvoiceSummary>('POST', `/api/invoices/${encodeURIComponent(id)}/remind`, body),
  cancel: (id: string) => call<InvoiceSummary | { deleted: true }>('POST', `/api/invoices/${encodeURIComponent(id)}/cancel`, {}),
  demoHistory: (invoicer: { givenName: string; surname: string; business?: string }) => call<InvoiceSummary[]>('POST', '/api/demo/history', { invoicer })
};

export function agentUrl(opts: { business: string; signer: string; autopilot: boolean }): string {
  const q = new URLSearchParams({ session: sessionId(), today: localToday(), business: opts.business, signer: opts.signer, autopilot: opts.autopilot ? '1' : '0' });
  return `/api/agent/run?${q}`;
}
