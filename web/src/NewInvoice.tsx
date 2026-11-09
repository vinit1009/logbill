// New invoice: load a timesheet, let the AI draft the lines, check them in the grid, send with PayPal.

import { useMemo, useState, type DragEvent } from 'react';
import Papa from 'papaparse';
import { AgGridReact } from 'ag-grid-react';
import type { CellValueChangedEvent, ColDef, ValueFormatterParams } from 'ag-grid-community';
import { entriesFromRows, hours, lineCents, moveEntry, span, toCents, totalCents, type Draft, type InvoiceLine, type TermDays, type TimeEntry } from '../../shared/core';
import type { DraftResponse, InvoiceSummary } from '../../shared/api';
import { api, localToday } from './api';
import { gridTheme, shortDate, usd } from './grid';
import type { Settings } from './App';

interface Props { settings: Settings; ai: boolean; model: string; onSent: (inv: InvoiceSummary) => void; goInvoices: () => void }
interface Recipient { givenName: string; surname: string; email: string; business: string }

const OFF = 'off';
const NEW = '__new';
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 30) || 'client';
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const TERMS: Array<{ days: TermDays; label: string }> = [
  { days: 0, label: 'Due on receipt' }, { days: 10, label: 'Net 10' }, { days: 15, label: 'Net 15' }, { days: 30, label: 'Net 30' }, { days: 45, label: 'Net 45' }, { days: 60, label: 'Net 60' }
];

export function NewInvoice({ settings, ai, model, onSent, goInvoices }: Props) {
  const [all, setAll] = useState<TimeEntry[]>([]);
  const [source, setSource] = useState('');
  const [skipped, setSkipped] = useState(0);
  const [client, setClient] = useState('');
  const [rate, setRate] = useState(String(settings.defaultRate));
  const [draft, setDraft] = useState<Draft | null>(null);
  const [meta, setMeta] = useState<Omit<DraftResponse, 'draft'> | null>(null);
  const [busy, setBusy] = useState<'draft' | 'send' | null>(null);
  const [error, setError] = useState('');
  const [recipient, setRecipient] = useState<Recipient>({ givenName: '', surname: '', email: '', business: '' });
  const [invoiceDate, setInvoiceDate] = useState(localToday());
  const [term, setTerm] = useState<TermDays>(15);
  const [note, setNote] = useState('');
  const [sent, setSent] = useState<{ inv: InvoiceSummary; qr?: string } | null>(null);
  const [dragging, setDragging] = useState(false);

  const clients = useMemo(() => {
    const mins = new Map<string, number>();
    for (const e of all) mins.set(e.client, (mins.get(e.client) ?? 0) + e.minutes);
    return [...mins.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c);
  }, [all]);
  const entries = useMemo(() => all.filter((e) => e.client === client), [all, client]);
  const rateCents = Math.max(0, toCents(rate) || 0);

  function load(text: string, name: string, sample = false) {
    setError(''); setDraft(null); setMeta(null); setSent(null);
    const parsed = Papa.parse<Record<string, string>>(text, { header: true, skipEmptyLines: true });
    const { entries: list, skipped: n } = entriesFromRows(parsed.data);
    if (!list.length) { setError('No time entries found. The CSV needs a date and a duration or hours column.'); return; }
    setAll(list); setSkipped(n); setSource(name);
    const top = [...new Set(list.map((e) => e.client))][0] ?? '';
    const mins = new Map<string, number>();
    for (const e of list) mins.set(e.client, (mins.get(e.client) ?? 0) + e.minutes);
    const first = [...mins.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? top;
    setClient(first);
    setRecipient(sample
      ? { givenName: 'Dana', surname: 'Whitfield', email: 'billing@juniperlanedental.example.com', business: first }
      : { givenName: '', surname: '', email: `billing@${slug(first)}.example.com`, business: first });
  }

  async function useSample() {
    const text = await (await fetch('/sample-timesheet.csv')).text();
    load(text, 'Sample timesheet: Ortiz Studio, October 2026 (Clockify export)', true);
  }

  function readFile(file: File | undefined) {
    if (!file) return;
    if (file.size > 2_000_000) { setError('That file is over 2 MB; export a shorter period.'); return; }
    file.text().then((t) => load(t, file.name));
  }

  async function runDraft() {
    setBusy('draft'); setError(''); setSent(null);
    try {
      const res = await api.draft({ entries, rateCents: rateCents || 10000, client, business: settings.business });
      const { draft: d, ...rest } = res;
      setDraft(d); setMeta(rest); setNote(d.summary ? `${d.summary}\n\nThank you,\n${settings.givenName}` : '');
    } catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  }

  async function send() {
    if (!draft) return;
    setBusy('send'); setError('');
    try {
      const inv = await api.send({
        lines: draft.lines, currency: 'USD',
        invoicer: { givenName: settings.givenName, surname: settings.surname, business: settings.business },
        recipient, invoiceDate, termDays: term, note
      });
      setSent({ inv }); onSent(inv);
      api.qr(inv.id).then((q) => setSent({ inv, qr: q.dataUrl })).catch(() => undefined);
    } catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  }

  // ---------- Placement of entries ----------

  const placement = useMemo(() => {
    const m = new Map<string, string>();
    for (const l of draft?.lines ?? []) for (const id of l.entryIds) m.set(id, l.id);
    for (const x of draft?.excluded ?? []) m.set(x.entryId, OFF);
    return m;
  }, [draft]);
  const flagOf = useMemo(() => new Map((draft?.flags ?? []).map((f) => [f.entryId, f.note])), [draft]);
  const reasonOf = useMemo(() => new Map((draft?.excluded ?? []).map((x) => [x.entryId, x.reason])), [draft]);
  const lineNames = useMemo(() => Object.fromEntries([...(draft?.lines ?? []).map((l) => [l.id, l.name]), [OFF, 'Left off the invoice'], [NEW, '+ New line…']]), [draft]);

  function move(entryId: string, to: string) {
    if (!draft) return;
    const e = entries.find((x) => x.id === entryId);
    if (to === NEW) {
      const name = window.prompt('Name the new invoice line', e?.project ?? 'Work');
      if (!name) { setDraft({ ...draft }); return; }
      setDraft(moveEntry(draft, entries, entryId, { newLine: name, rateCents: e?.rateCents ?? (rateCents || 10000) }));
    } else if (to === OFF) setDraft(moveEntry(draft, entries, entryId, { exclude: 'Left off by you' }));
    else setDraft(moveEntry(draft, entries, entryId, { lineId: to }));
  }

  // ---------- Grids ----------

  const entryCols = useMemo<ColDef<TimeEntry>[]>(() => [
    { field: 'date', headerName: 'Date', width: 120, valueFormatter: (p: ValueFormatterParams<TimeEntry>) => shortDate(String(p.value ?? '')) },
    { field: 'person', headerName: 'Person', width: 130 },
    { field: 'description', headerName: 'Note', flex: 2, minWidth: 240, tooltipField: 'description' },
    { headerName: 'Hours', width: 90, type: 'rightAligned', cellClass: 'num', valueGetter: (p) => (p.data ? hours(p.data.minutes) : '') },
    { field: 'rateCents', headerName: 'Rate', width: 95, type: 'rightAligned', cellClass: 'num', valueFormatter: (p) => (p.value ? usd(Number(p.value)) : '-') },
    { field: 'billable', headerName: 'Billable', width: 95, valueFormatter: (p) => (p.value ? 'Yes' : 'No') },
    ...(draft ? [{
      colId: 'line', headerName: 'On the invoice', flex: 1.4, minWidth: 220, editable: true, singleClickEdit: true,
      valueGetter: (p: { data?: TimeEntry }) => (p.data ? placement.get(p.data.id) ?? OFF : ''),
      valueSetter: (p: { data: TimeEntry; newValue: string }) => { move(p.data.id, String(p.newValue)); return false; },
      refData: lineNames,
      cellEditor: 'agSelectCellEditor',
      cellEditorParams: { values: [...draft.lines.map((l) => l.id), OFF, NEW] },
      cellClassRules: { 'cell-off': (p: { value?: string }) => p.value === OFF },
      tooltipValueGetter: (p: { data?: TimeEntry }) => (p.data ? reasonOf.get(p.data.id) ?? 'Click to move this entry to another line or off the invoice' : '')
    } as ColDef<TimeEntry>, {
      colId: 'flag', headerName: '', width: 52, cellClass: 'flag-cell',
      valueGetter: (p: { data?: TimeEntry }) => (p.data && flagOf.has(p.data.id) ? '⚑' : ''),
      tooltipValueGetter: (p: { data?: TimeEntry }) => (p.data ? flagOf.get(p.data.id) ?? '' : '')
    } as ColDef<TimeEntry>] : [])
  // move is recreated each render but only reads current state through draft; the grid gets fresh defs when draft changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [draft, placement, flagOf, reasonOf, lineNames]);

  interface LineRow extends InvoiceLine { amountCents: number; count: number; pinned?: boolean }
  const lineRows: LineRow[] = (draft?.lines ?? []).map((l) => ({ ...l, amountCents: lineCents(l), count: l.entryIds.length }));
  const total = draft ? totalCents(draft.lines) : 0;
  const totalMinutes = (draft?.lines ?? []).reduce((s, l) => s + l.minutes, 0);
  const pinned: LineRow[] = draft ? [{ id: 'total', name: 'Total', description: '', minutes: totalMinutes, rateCents: 0, entryIds: [], amountCents: total, count: lineRows.reduce((s, l) => s + l.count, 0), pinned: true }] : [];

  const lineCols = useMemo<ColDef<LineRow>[]>(() => [
    { field: 'name', headerName: 'Invoice line', flex: 1.3, minWidth: 210, editable: (p) => !p.node.rowPinned, wrapText: true, autoHeight: true, cellClass: (p) => (p.node.rowPinned ? 'total-cell' : 'line-name wrap-cell') },
    { field: 'description', headerName: 'What the client reads', flex: 3, minWidth: 320, editable: (p) => !p.node.rowPinned, wrapText: true, autoHeight: true, cellEditor: 'agLargeTextCellEditor', cellEditorPopup: true, cellEditorParams: { maxLength: 1000, rows: 6, cols: 60 }, cellClass: 'wrap-cell' },
    { headerName: 'Hours', width: 95, type: 'rightAligned', cellClass: 'num', valueGetter: (p) => (p.data ? hours(p.data.minutes) : '') },
    { field: 'rateCents', headerName: 'Rate / h', width: 115, type: 'rightAligned', cellClass: 'num', editable: (p) => !p.node.rowPinned,
      valueFormatter: (p) => (p.node?.rowPinned ? '' : usd(Number(p.value ?? 0))), valueParser: (p) => { const c = toCents(String(p.newValue)); return Number.isFinite(c) && c >= 0 ? c : p.oldValue; } },
    { field: 'amountCents', headerName: 'Amount', width: 130, type: 'rightAligned', cellClass: (p) => (p.node.rowPinned ? 'num total-cell' : 'num'), valueFormatter: (p) => usd(Number(p.value ?? 0)), enableCellChangeFlash: true },
    { field: 'count', headerName: 'Entries', width: 95, type: 'rightAligned', cellClass: 'num' }
  ], []);

  function editLine(e: CellValueChangedEvent<LineRow>) {
    if (!draft || !e.data || e.node.rowPinned) return;
    const { id } = e.data;
    setDraft({ ...draft, lines: draft.lines.map((l) => (l.id === id ? { ...l, name: String(e.data!.name ?? '').slice(0, 120) || l.name, description: String(e.data!.description ?? '').slice(0, 1000), rateCents: Number(e.data!.rateCents) } : l)) });
  }

  const billed = draft ? draft.lines.reduce((s, l) => s + l.entryIds.length, 0) : 0;
  const offList = (draft?.excluded ?? []).map((x) => ({ x, e: entries.find((e) => e.id === x.entryId) })).filter((r) => r.e);
  const flagList = (draft?.flags ?? []).map((f) => ({ f, e: entries.find((e) => e.id === f.entryId) })).filter((r) => r.e && placement.get(r.f.entryId) !== OFF);
  const recipientOk = recipient.givenName.trim() && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(recipient.email);

  return (
    <div className="flow">
      {/* 1. Timesheet */}
      <section className="card">
        <header className="card-head"><span className="step">1</span><div><h2>Timesheet</h2><p>Export the period from Toggl, Clockify, Harvest or Jira as CSV. Logbill reads the dates, people, notes, hours and rates.</p></div></header>
        {!all.length ? (
          <div className="start">
            <label className={`drop ${dragging ? 'drop-on' : ''}`} onDragOver={(e: DragEvent) => { e.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={(e: DragEvent) => { e.preventDefault(); setDragging(false); readFile(e.dataTransfer.files[0]); }}>
              <input type="file" accept=".csv,text/csv" onChange={(e) => readFile(e.target.files?.[0])} hidden />
              <strong>Drop a timesheet CSV here</strong><span>or click to choose a file</span>
            </label>
            <div className="or">or</div>
            <button className="btn btn-primary" onClick={useSample}>Use the sample timesheet</button>
            <p className="hint">The sample is a small studio's October: 35 entries for one client, including a few that should not be billed.</p>
          </div>
        ) : (
          <>
            <div className="facts">
              <span className="fact"><b>{plural(entries.length, 'entry', 'entries')}</b></span>
              <span className="fact"><b>{hours(entries.reduce((s, e) => s + e.minutes, 0))} h</b> logged</span>
              <span className="fact">{span(entries).replace(/(\d{4}-\d{2}-\d{2})/g, (d) => shortDate(d))}</span>
              {skipped ? <span className="fact warn">{plural(skipped, 'row')} without a date or duration skipped</span> : null}
              <span className="fact muted">{source}</span>
              <button className="link" onClick={() => { setAll([]); setDraft(null); setMeta(null); setSent(null); }}>Use another file</button>
            </div>
            <div className="row-fields">
              <label className="field"><span>Client</span>
                <select value={client} onChange={(e) => { setClient(e.target.value); setDraft(null); setMeta(null); setRecipient((r) => ({ ...r, business: e.target.value, email: `billing@${slug(e.target.value)}.example.com` })); }}>
                  {clients.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </label>
              <label className="field small"><span>Rate when the CSV has none ($/h)</span><input value={rate} onChange={(e) => setRate(e.target.value)} inputMode="decimal" /></label>
            </div>
            <div className="grid-wrap" style={{ height: draft ? 430 : 360 }}>
              <AgGridReact<TimeEntry> theme={gridTheme} rowData={entries} columnDefs={entryCols} getRowId={(p) => p.data.id} tooltipShowDelay={250} defaultColDef={{ sortable: true, resizable: true }} />
            </div>
            {draft ? <p className="hint">Click a cell under <b>On the invoice</b> to move an entry to another line, a new line, or off the invoice. Hours always come from the timesheet.</p> : null}
          </>
        )}
      </section>

      {/* 2. Draft */}
      {all.length ? (
        <section className="card">
          <header className="card-head"><span className="step">2</span><div><h2>Invoice lines</h2><p>{ai ? `${model} groups the entries into lines a client understands, words them, and suggests what to leave off. Logbill then checks that every entry is billed once or left off with a reason, and does all the maths itself.` : 'No AI key is set on this server, so the draft has one line per project.'}</p></div></header>
          {!draft ? (
            <div className="actions"><button className="btn btn-primary" disabled={busy === 'draft' || !entries.length} onClick={runDraft}>{busy === 'draft' ? `Drafting ${plural(entries.length, 'entry', 'entries')}…` : 'Draft the invoice lines with AI'}</button>{busy === 'draft' ? <span className="spinner" /> : null}</div>
          ) : (
            <>
              <div className={`banner ${meta?.problems.length ? 'banner-bad' : meta?.aiError ? 'banner-warn' : 'banner-ok'}`}>
                {meta?.problems.length ? <><b>Check these before sending:</b> {meta.problems.join('; ')}</>
                  : <><b>Every entry is accounted for.</b> {plural(billed, 'entry', 'entries')} billed on {plural(draft.lines.length, 'line')}, {offList.length} left off, {flagList.length} to check.</>}
                {meta?.aiError ? <div>{meta.aiError} This draft has one line per project instead.</div> : null}
                {draft.source === 'ai' && meta ? <div className="banner-meta">Drafted by {model} in {(meta.ms / 1000).toFixed(1)} s{meta.cost !== undefined ? ` for $${meta.cost.toFixed(4)}` : ''}.{draft.fixes.length ? ` Logbill corrected: ${draft.fixes.join(' ')}` : ''}</div> : null}
              </div>
              <div className="grid-wrap auto">
                <AgGridReact<LineRow> theme={gridTheme} rowData={lineRows} pinnedBottomRowData={pinned} columnDefs={lineCols} getRowId={(p) => p.data.id} domLayout="autoHeight" onCellValueChanged={editLine} stopEditingWhenCellsLoseFocus defaultColDef={{ resizable: true }} />
              </div>
              <p className="hint">Click a line's name, wording or rate to edit it. Press Enter to save a description.</p>
              <div className="two-col">
                <div>
                  <h3>Left off the invoice <span className="count">{offList.length}</span></h3>
                  {offList.length ? <ul className="items">{offList.map(({ x, e }) => (
                    <li key={x.entryId}>
                      <div className="item-main"><span className="item-title">{e!.description || e!.project}</span><span className="item-sub">{shortDate(e!.date)} · {e!.person} · {hours(e!.minutes)} h</span><span className="reason">{x.reason}</span></div>
                      <select className="mini" value="" onChange={(ev) => ev.target.value && move(x.entryId, ev.target.value)}>
                        <option value="">Bill it on…</option>
                        {draft.lines.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                        <option value={NEW}>+ New line…</option>
                      </select>
                    </li>))}</ul> : <p className="hint">Nothing left off.</p>}
                </div>
                <div>
                  <h3>Worth a second look <span className="count">{flagList.length}</span></h3>
                  {flagList.length ? <ul className="items">{flagList.map(({ f, e }) => (
                    <li key={f.entryId + f.note}>
                      <div className="item-main"><span className="item-title">{e!.description || e!.project}</span><span className="item-sub">{shortDate(e!.date)} · {e!.person} · {hours(e!.minutes)} h · on “{lineNames[placement.get(f.entryId) ?? ''] ?? ''}”</span><span className="reason flag">⚑ {f.note}</span></div>
                      <div className="item-actions">
                        <button className="btn btn-quiet" onClick={() => setDraft({ ...draft, flags: draft.flags.filter((x) => x !== f) })}>It's fine</button>
                        <button className="btn btn-quiet" onClick={() => move(f.entryId, OFF)}>Leave off</button>
                      </div>
                    </li>))}</ul> : <p className="hint">Nothing flagged.</p>}
                </div>
              </div>
              <div className="actions"><button className="btn" onClick={runDraft} disabled={busy === 'draft'}>{busy === 'draft' ? 'Drafting again…' : 'Draft again'}</button></div>
            </>
          )}
        </section>
      ) : null}

      {/* 3. Send */}
      {draft && draft.lines.length ? (
        <section className="card">
          <header className="card-head"><span className="step">3</span><div><h2>Send with PayPal</h2><p>Logbill creates the invoice with PayPal's Invoicing API and PayPal emails it. Your client pays by card, PayPal or Venmo from PayPal's invoice page.</p></div></header>
          {sent ? (
            <div className="sent">
              <div>
                <div className="sent-title">Invoice {sent.inv.number} is on its way to {sent.inv.contact || sent.inv.email}</div>
                <p>{usd(toCents(sent.inv.total))} · due {shortDate(sent.inv.dueDate)} · status: {sent.inv.status.toLowerCase()}</p>
                <div className="actions">
                  {sent.inv.payerUrl ? <a className="btn btn-paypal" href={sent.inv.payerUrl} target="_blank" rel="noreferrer">Open it as your client sees it</a> : null}
                  <button className="btn" onClick={goInvoices}>Track it in Invoices</button>
                </div>
                <p className="hint">This is PayPal's sandbox: pay it with a sandbox personal account (see the README for a test login). No real money moves.</p>
              </div>
              {sent.qr ? <figure className="qr"><img src={sent.qr} alt={`QR code to pay invoice ${sent.inv.number}`} width={150} height={150} /><figcaption>Scan to pay</figcaption></figure> : null}
            </div>
          ) : (
            <>
              <div className="form-grid">
                <label className="field"><span>Client contact first name</span><input value={recipient.givenName} onChange={(e) => setRecipient({ ...recipient, givenName: e.target.value })} /></label>
                <label className="field"><span>Last name</span><input value={recipient.surname} onChange={(e) => setRecipient({ ...recipient, surname: e.target.value })} /></label>
                <label className="field"><span>Email</span><input value={recipient.email} onChange={(e) => setRecipient({ ...recipient, email: e.target.value })} /></label>
                <label className="field"><span>Business</span><input value={recipient.business} onChange={(e) => setRecipient({ ...recipient, business: e.target.value })} /></label>
                <label className="field"><span>Invoice date</span><input type="date" value={invoiceDate} onChange={(e) => setInvoiceDate(e.target.value)} /></label>
                <label className="field"><span>Payment terms</span>
                  <select value={term} onChange={(e) => setTerm(Number(e.target.value) as TermDays)}>{TERMS.map((t) => <option key={t.days} value={t.days}>{t.label}</option>)}</select>
                </label>
                <label className="field wide"><span>Note to the client</span><textarea rows={4} value={note} onChange={(e) => setNote(e.target.value)} /></label>
              </div>
              <p className="hint">Sandbox demo: invoices can only go to example.com addresses, the kind PayPal sandbox accounts use, so no real person is emailed.</p>
              <div className="send-bar">
                <div className="total"><span>Total</span><b>{usd(total)}</b><small>{hours(totalMinutes)} h on {plural(draft.lines.length, 'line')}</small></div>
                <button className="btn btn-paypal big" disabled={busy === 'send' || !recipientOk} onClick={send}>{busy === 'send' ? 'Creating the PayPal invoice…' : 'Create and send with PayPal'}</button>
              </div>
            </>
          )}
        </section>
      ) : null}
      {error ? <div className="banner banner-bad">{error}</div> : null}
    </div>
  );
}
