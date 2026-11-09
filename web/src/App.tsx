// The shell: header, tabs, the "billing as" settings and toasts.

import { useEffect, useState } from 'react';
import type { Health, InvoiceSummary } from '../../shared/api';
import { api, newWorkspace, workspaceLink } from './api';
import { NewInvoice } from './NewInvoice';
import { Invoices } from './Invoices';
import { Agent } from './Agent';

export interface Settings { givenName: string; surname: string; business: string; defaultRate: number }
const DEFAULTS: Settings = { givenName: 'Maya', surname: 'Ortiz', business: 'Ortiz Studio', defaultRate: 100 };
const KEY = 'logbill.settings';

type Tab = 'new' | 'invoices' | 'agent';
const tabFromHash = (): Tab => (location.hash === '#/invoices' ? 'invoices' : location.hash === '#/agent' ? 'agent' : 'new');

export function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [tab, setTabState] = useState<Tab>(tabFromHash());
  const [settings, setSettings] = useState<Settings>(() => { try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') }; } catch { return DEFAULTS; } });
  const [editing, setEditing] = useState(false);
  const [invoices, setInvoices] = useState<InvoiceSummary[]>([]);
  const [toasts, setToasts] = useState<Array<{ id: number; text: string }>>([]);

  useEffect(() => { api.health().then(setHealth).catch(() => setHealth(null)); }, []);
  useEffect(() => { const f = () => setTabState(tabFromHash()); window.addEventListener('hashchange', f); return () => window.removeEventListener('hashchange', f); }, []);
  useEffect(() => { localStorage.setItem(KEY, JSON.stringify(settings)); }, [settings]);

  const setTab = (t: Tab) => { location.hash = t === 'new' ? '#/' : `#/${t}`; setTabState(t); };
  const toast = (text: string) => { const id = Date.now() + Math.random(); setToasts((t) => [...t, { id, text }]); setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 6000); };
  const refreshInvoices = () => { api.invoices().then(setInvoices).catch(() => undefined); };
  const overdue = invoices.filter((i) => ['SENT', 'UNPAID', 'PARTIALLY_PAID'].includes(i.status) && (i.daysOverdue ?? 0) > 0).length;
  const model = (health?.model ?? '').replace(/^[^/]+\//, '').replace(/-/g, ' ').replace(/\b(\w)/g, (c) => c.toUpperCase()).replace(/ (\d)/, ' $1') || 'The AI';

  return (
    <div className="app">
      <header className="top">
        <div className="brand">
          <svg width="30" height="30" viewBox="0 0 64 64" aria-hidden="true"><rect width="64" height="64" rx="14" fill="#14213D" /><circle cx="32" cy="32" r="19" fill="none" stroke="#FBF8F3" strokeWidth="5" /><path d="M23 33l6 6 12-14" fill="none" stroke="#F2B544" strokeWidth="5.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
          <div><b>Logbill</b><span>timesheet to paid</span></div>
          <span className="pill">PayPal sandbox</span>
        </div>
        <nav className="tabs" aria-label="Sections">
          <button className={tab === 'new' ? 'on' : ''} onClick={() => setTab('new')}>New invoice</button>
          <button className={tab === 'invoices' ? 'on' : ''} onClick={() => setTab('invoices')}>Invoices{invoices.length ? <span className="badge">{invoices.length}</span> : null}</button>
          <button className={tab === 'agent' ? 'on' : ''} onClick={() => setTab('agent')}>Collections agent{overdue ? <span className="badge late">{overdue}</span> : null}</button>
        </nav>
        <div className="me">
          <button className="link" onClick={() => setEditing(!editing)}>Billing as <b>{settings.business}</b> ▾</button>
          {editing ? (
            <div className="pop" role="dialog" aria-label="Your details">
              <label className="field"><span>Business name</span><input value={settings.business} onChange={(e) => setSettings({ ...settings, business: e.target.value })} /></label>
              <div className="row-fields">
                <label className="field"><span>First name</span><input value={settings.givenName} onChange={(e) => setSettings({ ...settings, givenName: e.target.value })} /></label>
                <label className="field"><span>Last name</span><input value={settings.surname} onChange={(e) => setSettings({ ...settings, surname: e.target.value })} /></label>
              </div>
              <label className="field"><span>Default rate ($/h)</span><input value={String(settings.defaultRate)} inputMode="decimal" onChange={(e) => setSettings({ ...settings, defaultRate: Number(e.target.value) || 0 })} /></label>
              <p className="hint">Invoices go out from the sandbox business account {health?.invoicerEmail ? <code>{health.invoicerEmail}</code> : null} under this name.</p>
              <p className="hint">Open this workspace in another browser: <button className="link" onClick={() => { navigator.clipboard?.writeText(workspaceLink()); }}>copy its link</button></p>
              <div className="actions end">
                <button className="btn btn-quiet" onClick={() => { if (window.confirm('Start a fresh workspace? Invoices from this one stay in PayPal but disappear from this browser.')) { newWorkspace(); location.reload(); } }}>Start a fresh workspace</button>
                <button className="btn" onClick={() => setEditing(false)}>Done</button>
              </div>
            </div>
          ) : null}
        </div>
      </header>

      {health && !health.ok ? <div className="banner banner-bad wide">This server is missing settings: {health.missing.join(', ')}. See the README.</div> : null}

      <main>
        {tab === 'new' ? <NewInvoice settings={settings} ai={health?.ai ?? false} model={model} onSent={(inv) => setInvoices((list) => [inv, ...list.filter((x) => x.id !== inv.id)])} goInvoices={() => setTab('invoices')} /> : null}
        {tab === 'invoices' ? <Invoices settings={settings} invoices={invoices} setInvoices={setInvoices} toast={toast} goAgent={() => setTab('agent')} /> : null}
        {tab === 'agent' ? <Agent settings={settings} ai={health?.ai ?? false} toast={toast} refreshInvoices={refreshInvoices} /> : null}
      </main>

      <footer className="foot">PayPal sandbox only: no real money moves and no real person is emailed. <a href="https://github.com/vinit1009/logbill" target="_blank" rel="noreferrer">Source on GitHub</a> (MIT).</footer>

      <div className="toasts" aria-live="polite">{toasts.map((t) => <div key={t.id} className="toast">{t.text}</div>)}</div>
    </div>
  );
}
