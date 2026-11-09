// The collections agent: watch it read the unpaid invoices, then approve, edit or skip its reminders.

import { useRef, useState } from 'react';
import { api, agentUrl } from './api';
import { shortDate, usdText } from './grid';
import type { Settings } from './App';

interface Proposal {
  invoiceId: string; number: string; client: string; dueAmount: string; currency: string; daysOverdue?: number;
  action: 'remind' | 'none'; tone?: 'friendly' | 'firm' | 'final'; subject?: string; note?: string; reason: string; nextCheck?: string; sent?: boolean;
}
type Step = { kind: string; text: string; at: number };
type Card = Proposal & { state: 'open' | 'sending' | 'sent' | 'skipped'; error?: string };

interface Props { settings: Settings; ai: boolean; toast: (text: string) => void; refreshInvoices: () => void }

const ICON: Record<string, string> = { search: '⌕', read: '▤', history: '↺', think: '…', send: '➤', blocked: '⛔', done: '✓' };

export function Agent({ settings, ai, toast, refreshInvoices }: Props) {
  const [autopilot, setAutopilot] = useState(false);
  const [running, setRunning] = useState(false);
  const [steps, setSteps] = useState<Step[]>([]);
  const [cards, setCards] = useState<Card[]>([]);
  const [summary, setSummary] = useState('');
  const [cost, setCost] = useState<number | undefined>();
  const [error, setError] = useState('');
  const source = useRef<EventSource | null>(null);

  function run() {
    source.current?.close();
    setRunning(true); setSteps([]); setCards([]); setSummary(''); setError(''); setCost(undefined);
    const es = new EventSource(agentUrl({ business: settings.business, signer: settings.givenName, autopilot }));
    source.current = es;
    const started = Date.now();
    es.onmessage = (m) => {
      const e = JSON.parse(m.data) as { type: string; [k: string]: unknown };
      const at = Date.now() - started;
      if (e.type === 'step') setSteps((s) => [...s, { kind: String(e.kind), text: String(e.text), at }]);
      else if (e.type === 'blocked') setSteps((s) => [...s, { kind: 'blocked', text: `Rules stopped a reminder for ${String(e.number)}: ${String(e.reason)}`, at }]);
      else if (e.type === 'proposal') {
        const p = e.proposal as Proposal;
        setCards((c) => [...c.filter((x) => x.invoiceId !== p.invoiceId), { ...p, state: p.sent ? 'sent' : 'open' }]);
        if (p.sent) toast(`The agent sent a ${p.tone} reminder for invoice ${p.number}.`);
      } else if (e.type === 'done') {
        setSummary(String(e.summary)); setCost((e.usage as { cost?: number } | undefined)?.cost);
        setSteps((s) => [...s, { kind: 'done', text: 'Finished', at }]);
        setRunning(false); es.close(); refreshInvoices();
      } else if (e.type === 'error') { setError(String(e.message)); setRunning(false); es.close(); }
    };
    es.onerror = () => { if (es.readyState === EventSource.CLOSED) return; setError('The connection to the agent dropped.'); setRunning(false); es.close(); };
  }

  async function approve(card: Card) {
    setCards((c) => c.map((x) => (x.invoiceId === card.invoiceId ? { ...x, state: 'sending', error: undefined } : x)));
    try {
      await api.remind(card.invoiceId, { subject: card.subject ?? '', note: card.note ?? '', ...(card.tone ? { tone: card.tone } : {}) });
      setCards((c) => c.map((x) => (x.invoiceId === card.invoiceId ? { ...x, state: 'sent' } : x)));
      toast(`Reminder sent for invoice ${card.number}.`); refreshInvoices();
    } catch (e) { setCards((c) => c.map((x) => (x.invoiceId === card.invoiceId ? { ...x, state: 'open', error: (e as Error).message } : x))); }
  }

  const edit = (id: string, patch: Partial<Card>) => setCards((c) => c.map((x) => (x.invoiceId === id ? { ...x, ...patch } : x)));
  const reminders = cards.filter((c) => c.action === 'remind');
  const quiet = cards.filter((c) => c.action === 'none');

  return (
    <div className="flow">
      <section className="card">
        <header className="card-head"><span className="step agent">AI</span><div><h2>Collections agent</h2>
          <p>The agent reads this workspace's unpaid invoices with <b>PayPal's Agent Toolkit</b>, checks which reminders already went out, and writes each reminder in a tone that fits how late the invoice is. You approve each one, or put it on autopilot.</p></div></header>
        <div className="rules">
          <div><b>Rules it cannot break</b> (Logbill checks them before anything is sent)</div>
          <ul>
            <li>Only unpaid invoices in this workspace; nothing before it is due, apart from a heads-up within two days.</li>
            <li>Friendly up to 13 days late, firm from 14, a final polite notice from 30.</li>
            <li>At most one reminder per invoice every 3 days, and 3 in total; then it asks you to call.</li>
            <li>It cannot add recipients, change amounts or cancel anything.</li>
          </ul>
        </div>
        <div className="actions">
          <button className="btn btn-primary" onClick={run} disabled={running || !ai}>{running ? 'The agent is working…' : cards.length ? 'Run the agent again' : 'Run the agent'}</button>
          <label className="toggle"><input type="checkbox" checked={autopilot} onChange={(e) => setAutopilot(e.target.checked)} disabled={running} /><span>Autopilot: let it send reminders itself, within the rules</span></label>
          {running ? <span className="spinner" /> : null}
        </div>
        {!ai ? <div className="banner banner-warn">No AI key is set on this server, so the agent cannot run.</div> : null}
        {error ? <div className="banner banner-bad">{error}</div> : null}
      </section>

      {steps.length ? (
        <div className="agent-grid">
          <section className="card trace">
            <h3>What it did</h3>
            <ol>{steps.map((s, n) => <li key={n} className={`t-${s.kind}`}><span className="ticon">{ICON[s.kind] ?? '•'}</span><span>{s.text}</span><time>{(s.at / 1000).toFixed(1)} s</time></li>)}</ol>
            {summary ? <p className="agent-summary">{summary}</p> : null}
            {cost !== undefined ? <p className="hint">Model cost for this run: ${cost.toFixed(4)}</p> : null}
          </section>
          <section className="proposals">
            {reminders.map((c) => (
              <article key={c.invoiceId} className={`proposal tone-${c.tone ?? 'friendly'} ${c.state}`}>
                <header>
                  <div><b>{c.client}</b><span className="sub">Invoice {c.number} · {usdText(c.dueAmount)} due{c.daysOverdue !== undefined ? ` · ${c.daysOverdue > 0 ? `${c.daysOverdue} days late` : c.daysOverdue === 0 ? 'due today' : `due in ${-c.daysOverdue} days`}` : ''}</span></div>
                  <span className={`chip chip-tone-${c.tone}`}>{c.tone}</span>
                </header>
                <p className="why">{c.reason}</p>
                <label className="field"><span>Subject</span><input value={c.subject ?? ''} disabled={c.state !== 'open'} onChange={(e) => edit(c.invoiceId, { subject: e.target.value })} /></label>
                <label className="field"><span>Note</span><textarea rows={6} value={c.note ?? ''} disabled={c.state !== 'open'} onChange={(e) => edit(c.invoiceId, { note: e.target.value })} /></label>
                {c.error ? <div className="banner banner-bad">{c.error}</div> : null}
                <div className="actions end">
                  {c.state === 'open' ? <><button className="btn" onClick={() => edit(c.invoiceId, { state: 'skipped' })}>Skip</button><button className="btn btn-paypal" onClick={() => approve(c)}>Send reminder with PayPal</button></> : null}
                  {c.state === 'sending' ? <span className="hint">Sending…</span> : null}
                  {c.state === 'sent' ? <span className="done">✓ Sent{c.sent ? ' by the agent on autopilot' : ''}</span> : null}
                  {c.state === 'skipped' ? <span className="hint">Skipped</span> : null}
                </div>
              </article>
            ))}
            {quiet.length ? (
              <article className="proposal quiet">
                <header><b>No reminder needed</b></header>
                <ul className="items">{quiet.map((c) => <li key={c.invoiceId}><div className="item-main"><span className="item-title">{c.client} · invoice {c.number} · {usdText(c.dueAmount)}</span><span className="reason">{c.reason}{c.nextCheck ? ` Next look: ${shortDate(c.nextCheck)}.` : ''}</span></div></li>)}</ul>
              </article>
            ) : null}
          </section>
        </div>
      ) : null}
    </div>
  );
}
