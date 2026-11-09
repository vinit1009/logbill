// Invoices: everything this workspace sent with PayPal, refreshed from PayPal every 15 seconds.

import { useEffect, useMemo, useRef, useState } from 'react';
import { AgGridReact } from 'ag-grid-react';
import type { ColDef, ICellRendererParams } from 'ag-grid-community';
import type { InvoiceSummary } from '../../shared/api';
import { api, sessionId } from './api';
import { gridTheme, shortDate, StatusChip, statusLabel, usdText } from './grid';
import type { Settings } from './App';

interface Props { settings: Settings; invoices: InvoiceSummary[]; setInvoices: (list: InvoiceSummary[]) => void; toast: (text: string) => void; goAgent: () => void }

const OPEN = new Set(['SENT', 'UNPAID', 'PARTIALLY_PAID']);
const isPaid = (s: string) => s === 'PAID' || s === 'MARKED_AS_PAID';
const NOTEWORTHY = new Set(['PAID', 'MARKED_AS_PAID', 'PARTIALLY_PAID', 'PAYMENT_PENDING', 'CANCELLED', 'REFUNDED', 'PARTIALLY_REFUNDED']);

export function Invoices({ settings, invoices, setInvoices, toast, goAgent }: Props) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('');
  const [remind, setRemind] = useState<{ inv: InvoiceSummary; subject: string; note: string } | null>(null);
  const [busy, setBusy] = useState('');
  const last = useRef(new Map<string, string>());

  async function refresh(quiet = false) {
    if (!quiet) setLoading(true);
    try {
      const list = await api.invoices();
      for (const inv of list) {
        const before = last.current.get(inv.id);
        // Only news worth interrupting for: money arriving, or an invoice closing.
        if (before && before !== inv.status && NOTEWORTHY.has(inv.status)) toast(`Invoice ${inv.number} for ${inv.client} is now ${statusLabel(inv.status).toLowerCase()}.`);
        last.current.set(inv.id, inv.status);
      }
      setInvoices(list); setError('');
    } catch (e) { setError((e as Error).message); } finally { setLoading(false); }
  }

  const [live, setLive] = useState(false);
  useEffect(() => {
    for (const inv of invoices) last.current.set(inv.id, inv.status);
    refresh();
    const t = setInterval(() => refresh(true), 15_000);
    // PayPal webhooks push invoice events at once; the poll above is the fallback.
    const es = new EventSource(`/api/events?session=${encodeURIComponent(sessionId())}`);
    es.onmessage = (m) => {
      const e = JSON.parse(m.data) as { type: string; webhooks?: boolean };
      if (e.type === 'hello') setLive(Boolean(e.webhooks));
      else if (e.type === 'invoice') refresh(true);
    };
    es.onerror = () => setLive(false);
    return () => { clearInterval(t); es.close(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function demo() {
    setBusy('demo');
    try { await api.demoHistory({ givenName: settings.givenName, surname: settings.surname, business: settings.business }); await refresh(); toast('Added four older invoices to work with.'); }
    catch (e) { setError((e as Error).message); } finally { setBusy(''); }
  }

  function openRemind(inv: InvoiceSummary) {
    const first = inv.contact.split(' ')[0] || 'there';
    const late = inv.daysOverdue !== null && inv.daysOverdue > 0;
    setRemind({
      inv,
      subject: `Reminder: invoice ${inv.number} from ${settings.business}`,
      note: `Hi ${first},\n\nA quick reminder that invoice ${inv.number} for ${usdText(inv.due)} ${late ? `was due on ${shortDate(inv.dueDate)}` : `is due on ${shortDate(inv.dueDate)}`}. You can pay it from the PayPal invoice by card, PayPal or Venmo.\n\nThank you,\n${settings.givenName}`
    });
  }

  async function sendRemind() {
    if (!remind) return;
    setBusy(`remind:${remind.inv.id}`);
    try { await api.remind(remind.inv.id, { subject: remind.subject, note: remind.note }); toast(`Reminder sent for invoice ${remind.inv.number}.`); setRemind(null); await refresh(true); }
    catch (e) { setError((e as Error).message); } finally { setBusy(''); }
  }

  async function cancel(inv: InvoiceSummary) {
    if (!window.confirm(`Cancel invoice ${inv.number} for ${inv.client}? PayPal tells the client it was cancelled.`)) return;
    setBusy(`cancel:${inv.id}`);
    try { await api.cancel(inv.id); toast(`Invoice ${inv.number} cancelled.`); await refresh(true); }
    catch (e) { setError((e as Error).message); } finally { setBusy(''); }
  }

  const totals = useMemo(() => {
    let outstanding = 0; let overdue = 0; let paid = 0; let late = 0;
    for (const i of invoices) {
      if (OPEN.has(i.status)) { outstanding += Number(i.due); if ((i.daysOverdue ?? 0) > 0) { overdue += Number(i.due); late++; } }
      if (isPaid(i.status)) paid += Number(i.total);
      else if (i.status === 'PARTIALLY_PAID') paid += Number(i.paid);
    }
    return { outstanding, overdue, paid, late };
  }, [invoices]);

  const cols = useMemo<ColDef<InvoiceSummary>[]>(() => [
    { field: 'number', headerName: 'Invoice', width: 105, cellClass: 'num strong' },
    { field: 'client', headerName: 'Client', flex: 1.3, minWidth: 180 },
    { field: 'status', headerName: 'Status', width: 130, enableCellChangeFlash: true, cellRenderer: (p: ICellRendererParams<InvoiceSummary>) => (p.data ? <StatusChip status={p.data.status} overdue={OPEN.has(p.data.status) ? p.data.daysOverdue : null} /> : null) },
    { field: 'total', headerName: 'Total', width: 115, type: 'rightAligned', cellClass: 'num', valueFormatter: (p) => usdText(String(p.value ?? 0)), comparator: (a, b) => Number(a) - Number(b) },
    { field: 'due', headerName: 'Still due', width: 115, type: 'rightAligned', cellClass: 'num', enableCellChangeFlash: true, valueGetter: (p) => (p.data && OPEN.has(p.data.status) ? Number(p.data.due) : 0), valueFormatter: (p) => (Number(p.value) ? usdText(String(p.value)) : '-') },
    { field: 'dueDate', headerName: 'Due', width: 120, valueFormatter: (p) => shortDate(String(p.value ?? '')) },
    { field: 'daysOverdue', headerName: 'Late by', width: 100, type: 'rightAligned', cellClass: 'num',
      valueGetter: (p) => (p.data && OPEN.has(p.data.status) && (p.data.daysOverdue ?? 0) > 0 ? p.data.daysOverdue : null),
      valueFormatter: (p) => (p.value ? `${p.value} day${p.value === 1 ? '' : 's'}` : ''),
      cellClassRules: { 'late-1': (p) => Number(p.value) > 0 && Number(p.value) < 14, 'late-2': (p) => Number(p.value) >= 14 && Number(p.value) < 30, 'late-3': (p) => Number(p.value) >= 30 } },
    { headerName: 'Reminders', width: 140, valueGetter: (p) => p.data?.reminders.length ?? 0,
      valueFormatter: (p) => { const r = p.data?.reminders ?? []; const l = r[r.length - 1]; return r.length ? `${r.length}, last ${shortDate(l!.day ?? l!.at)}` : 'None'; },
      tooltipValueGetter: (p) => (p.data?.reminders ?? []).map((r) => `${shortDate(r.day ?? r.at)} (${r.by === 'agent' ? 'agent' : 'you'}${r.tone ? `, ${r.tone}` : ''}): ${r.subject}`).join('\n') },
    { headerName: '', colId: 'actions', width: 215, pinned: 'right', sortable: false, resizable: false, cellClass: 'actions-cell',
      cellRenderer: (p: ICellRendererParams<InvoiceSummary>) => {
        const inv = p.data; if (!inv) return null;
        return (
          <div className="cell-actions">
            {inv.payerUrl ? <a className="btn btn-quiet sm" href={inv.payerUrl} target="_blank" rel="noreferrer">Open</a> : null}
            {OPEN.has(inv.status) ? <button className="btn btn-quiet sm" onClick={() => openRemind(inv)}>Remind</button> : null}
            {['SENT', 'UNPAID', 'DRAFT'].includes(inv.status) ? <button className="btn btn-quiet sm danger" onClick={() => cancel(inv)}>Cancel</button> : null}
          </div>
        );
      } }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [settings]);

  return (
    <div className="flow">
      <section className="tiles">
        <div className="tile"><span>Outstanding</span><b>{usdText(totals.outstanding)}</b></div>
        <div className={`tile ${totals.overdue ? 'tile-late' : ''}`}><span>Overdue</span><b>{usdText(totals.overdue)}</b><small>{totals.late ? `${totals.late} invoice${totals.late === 1 ? '' : 's'}` : 'nothing late'}</small></div>
        <div className="tile tile-paid"><span>Collected</span><b>{usdText(totals.paid)}</b></div>
        <div className="tile tile-cta">
          <span>Collections agent</span>
          <small>{totals.late ? `${totals.late} overdue invoice${totals.late === 1 ? '' : 's'} could use a reminder.` : 'Reads your unpaid invoices and drafts reminders.'}</small>
          <button className="btn btn-primary sm" onClick={goAgent}>Open the agent</button>
        </div>
      </section>
      <section className="card">
        <div className="toolbar">
          <h2>Invoices</h2>
          <input className="search" placeholder="Filter by client, number, status…" value={filter} onChange={(e) => setFilter(e.target.value)} />
          <button className="btn" onClick={() => refresh()} disabled={loading}>{loading ? 'Refreshing…' : 'Refresh'}</button>
          {invoices.length < 3 ? <button className="btn" onClick={demo} disabled={busy === 'demo'}>{busy === 'demo' ? 'Adding…' : 'Add demo history'}</button> : null}
        </div>
        <p className="hint">{live ? <span className="live">● Live</span> : null} Straight from PayPal: {live ? 'PayPal webhooks update this the moment a client pays, with a check every 15 seconds as a fallback.' : 'refreshed every 15 seconds.'} Statuses change here when a client pays on PayPal's invoice page. {invoices.length < 3 ? '“Add demo history” creates four older sandbox invoices, some overdue, for the collections agent to work on.' : ''}</p>
        <div className="grid-wrap auto">
          <AgGridReact<InvoiceSummary> theme={gridTheme} rowData={invoices} columnDefs={cols} getRowId={(p) => p.data.id} domLayout="autoHeight" quickFilterText={filter} tooltipShowDelay={200}
            overlayNoRowsTemplate="No invoices yet. Send one from New invoice, or add the demo history." defaultColDef={{ sortable: true, resizable: true }} />
        </div>
        {error ? <div className="banner banner-bad">{error}</div> : null}
      </section>

      {remind ? (
        <div className="modal-back" onClick={() => setRemind(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={`Remind ${remind.inv.client}`}>
            <h3>Remind {remind.inv.client} about invoice {remind.inv.number}</h3>
            <p className="hint">PayPal emails this to {remind.inv.email} with a button to pay {usdText(remind.inv.due)}.</p>
            <label className="field"><span>Subject</span><input value={remind.subject} onChange={(e) => setRemind({ ...remind, subject: e.target.value })} /></label>
            <label className="field"><span>Note</span><textarea rows={7} value={remind.note} onChange={(e) => setRemind({ ...remind, note: e.target.value })} /></label>
            <div className="actions end">
              <button className="btn" onClick={() => setRemind(null)}>Close</button>
              <button className="btn btn-paypal" disabled={busy.startsWith('remind')} onClick={sendRemind}>{busy.startsWith('remind') ? 'Sending…' : 'Send reminder with PayPal'}</button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
