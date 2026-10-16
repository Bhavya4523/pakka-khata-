import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { BrowserRouter, NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { ScanPage, CustomerListPage, CustomerDetailPage } from './components/Phase3Screens';
import {
  db, clearLocalData, customerBalance, formatRupees, getShop, getSnapshot, makeId,
  saveShop, totalOutstanding,
  type CustomerRecord, type EntryRecord, type ReminderLanguage, type ShopRecord, type UiLanguage,
} from './lib/db';
import { translate as t } from './lib/i18n';
import { buildBackupPayload, decryptBackup, encryptBackup, hashPin, makeLedgerCsv, nextPinLockout, planBackupMerge, reminderLanguageForUi, verifyPin } from './lib/security';

type Snapshot = { shop?: ShopRecord; customers: CustomerRecord[]; entries: EntryRecord[] };
const initialSnapshot: Snapshot = { shop: undefined, customers: [], entries: [] };
const DELETE_CONFIRMATION = 'DELETE';

function Icon({ name }: { name: 'home' | 'scan' | 'people' | 'settings' | 'lock' | 'book' | 'download' | 'shield' }) {
  const paths: Record<string, ReactNode> = {
    home: <><path d="m3 10 9-7 9 7"/><path d="M5 9v11h14V9M9 20v-6h6v6"/></>,
    scan: <><path d="M4 8V4h4M16 4h4v4M20 16v4h-4M8 20H4v-4"/><path d="M6 12h12"/></>,
    people: <><circle cx="9" cy="8" r="3"/><path d="M3 20v-1a6 6 0 0 1 12 0v1M16 5a3 3 0 0 1 0 6M18 14a5 5 0 0 1 3 5v1"/></>,
    settings: <><circle cx="12" cy="12" r="3"/><path d="m19.4 15 .1.1 1.2 1-1.4 2.4-1.5-.6a8 8 0 0 1-1.7 1l-.2 1.7h-2.8l-.3-1.7a8 8 0 0 1-1.7-1l-1.5.6-1.4-2.4 1.3-1.1a7 7 0 0 1 0-2l-1.3-1.1 1.4-2.4 1.5.6a8 8 0 0 1 1.7-1l.3-1.7h2.8l.2 1.7a8 8 0 0 1 1.7 1l1.5-.6 1.4 2.4-1.2 1a7 7 0 0 1 0 2Z" transform="translate(-1 -1) scale(1.05)"/></>,
    lock: <><rect x="4" y="10" width="16" height="11" rx="1"/><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3"/></>,
    book: <><path d="M4 4h12a4 4 0 0 1 4 4v12H8a4 4 0 0 1-4-4z"/><path d="M8 20V8a4 4 0 0 1 4-4"/><path d="M11 9h5M11 13h5"/></>,
    download: <><path d="M12 3v12m-5-5 5 5 5-5"/><path d="M4 17v4h16v-4"/></>,
    shield: <><path d="M12 3 20 6v5c0 5-3.5 8.5-8 10-4.5-1.5-8-5-8-10V6z"/><path d="m8 12 3 3 5-6"/></>,
  };
  return <svg className="icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>;
}

function App() {
  const [snapshot, setSnapshot] = useState<Snapshot>(initialSnapshot);
  const [loaded, setLoaded] = useState(false);
  const [locked, setLocked] = useState(false);
  const [online, setOnline] = useState(navigator.onLine);
  const refresh = useCallback(async () => {
    const fresh = await getSnapshot();
    setSnapshot(fresh);
    return fresh;
  }, []);

  useEffect(() => {
    let active = true;
    getSnapshot().then((fresh) => {
      if (!active) return;
      setSnapshot(fresh);
      setLocked(Boolean(fresh.shop?.pin_hash));
      setLoaded(true);
    }).catch(() => setLoaded(true));
    const onlineHandler = () => setOnline(true);
    const offlineHandler = () => setOnline(false);
    window.addEventListener('online', onlineHandler);
    window.addEventListener('offline', offlineHandler);
    return () => {
      active = false;
      window.removeEventListener('online', onlineHandler);
      window.removeEventListener('offline', offlineHandler);
    };
  }, []);

  useEffect(() => {
    let hiddenAt: number | null = null;
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') hiddenAt = Date.now();
      else if (hiddenAt !== null) {
        if (Date.now() - hiddenAt >= 5 * 60 * 1000 && snapshot.shop?.pin_hash) setLocked(true);
        hiddenAt = null;
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [snapshot.shop?.pin_hash]);

  const lang = snapshot.shop?.preferred_language ?? 'en';
  useEffect(() => { document.documentElement.lang = lang === 'hi' ? 'hi' : lang === 'mr' ? 'mr' : 'en'; }, [lang]);
  const msg = (key: Parameters<typeof t>[1]) => t(lang, key);
  if (!loaded) return <div className="startup"><span className="book-seal"><Icon name="book" /></span>{t('en', 'loading')}</div>;
  if (!snapshot.shop) return <FirstRun onComplete={async (shop) => { await saveShop(shop); await refresh(); setLocked(false); }} />;
  if (locked && snapshot.shop.pin_hash && snapshot.shop.pin_salt) return <LockScreen shop={snapshot.shop} onUnlock={() => setLocked(false)} />;

  return <div className="app-root">
    {!online && <div className="offline-banner" role="status">{msg('offline')}</div>}
    <div className="app-frame">
      <aside className="desktop-rail">
        <Brand lang={lang} />
        <Navigation lang={lang} />
        <div className="rail-bottom"><div className="shop-chip"><span className="shop-initial">{snapshot.shop.name.slice(0, 1).toLocaleUpperCase()}</span><span>{snapshot.shop.name}</span></div><NavLink className="settings-link" to="/settings"><Icon name="settings" />{msg('settings')}</NavLink></div>
      </aside>
      <div className="app-content">
        <header className="mobile-header"><Brand lang={lang} /><NavLink aria-label={msg('settings')} className="icon-button" to="/settings"><Icon name="settings" /></NavLink></header>
        <Routes>
          <Route path="/" element={<HomePage snapshot={snapshot} refresh={refresh} />} />
          <Route path="/scan" element={<ScanPage shop={snapshot.shop} customers={snapshot.customers} refresh={refresh} />} />
          <Route path="/customers" element={<CustomerListPage snapshot={snapshot} refresh={refresh} />} />
          <Route path="/customers/:customerId" element={<CustomerDetailPage snapshot={snapshot} refresh={refresh} />} />
          <Route path="/settings" element={<SettingsPage snapshot={snapshot} refresh={refresh} onDelete={async () => { await clearLocalData(); setSnapshot(initialSnapshot); setLocked(false); }} />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </div>
      <nav className="mobile-nav" aria-label={msg('menu')}>
        <NavLink to="/" end><Icon name="home" /><span>{msg('home')}</span></NavLink>
        <NavLink to="/scan" className="scan-tab"><Icon name="scan" /><span>{msg('scan')}</span></NavLink>
        <NavLink to="/customers"><Icon name="people" /><span>{msg('customers')}</span></NavLink>
      </nav>
    </div>
  </div>;
}

function Brand({ lang }: { lang: UiLanguage }) {
  return <div className="brand-lockup"><span className="brand-mark"><Icon name="book" /></span><span><strong>{t(lang, 'appName')}</strong><small>पक्का खाता · {t(lang, 'subtitle')}</small></span></div>;
}
function Navigation({ lang }: { lang: UiLanguage }) {
  return <nav className="desktop-nav" aria-label={t(lang, 'menu')}>
    <NavLink to="/" end><Icon name="home" />{t(lang, 'home')}</NavLink>
    <NavLink to="/scan"><Icon name="scan" />{t(lang, 'scan')}</NavLink>
    <NavLink to="/customers"><Icon name="people" />{t(lang, 'customers')}</NavLink>
  </nav>;
}

function FirstRun({ onComplete }: { onComplete: (shop: ShopRecord) => Promise<void> }) {
  const [name, setName] = useState('');
  const [language, setLanguage] = useState<UiLanguage>('en');
  const [pin, setPin] = useState('');
  const [pinConfirm, setPinConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const c = (key: Parameters<typeof t>[1]) => t(language, key);
  const submit = async (event: FormEvent, skipPin = false) => {
    event.preventDefault();
    setError('');
    if (!name.trim()) { setError(c('shopName')); return; }
    if (!skipPin && pin && !/^\d{4}$/.test(pin)) { setError(c('optionalPin')); return; }
    if (!skipPin && pin && pin !== pinConfirm) { setError(c('pinMismatch')); return; }
    setBusy(true);
    try {
      let persistResult: boolean | null = null;
      // Request persistence early in the user-initiated action, before the PIN KDF work.
      try { persistResult = navigator.storage?.persist ? await navigator.storage.persist() : false; } catch { persistResult = false; }
      let pinHash: string | null = null;
      let pinSalt: string | null = null;
      if (!skipPin && pin) {
        const result = await hashPin(pin);
        pinHash = result.hash;
        pinSalt = result.salt;
      }
      const newShop: ShopRecord = {
        id: 'primary', name: name.trim(), preferred_language: language,
        reminder_language: reminderLanguageForUi(language), created_at: new Date().toISOString(),
        last_backup_at: null, last_backup_entry_count: 0, pin_hash: pinHash, pin_salt: pinSalt,
        storage_persisted: persistResult, backup_prompt_dismissed_until: null,
      };
      await onComplete(newShop);
    } catch (e) {
      setError(e instanceof Error ? e.message : c('errorGeneric'));
    } finally { setBusy(false); }
  };
  return <main className="setup-screen">
    <div className="setup-paper">
      <Brand lang={language} />
      <p className="eyebrow">{c('modernLabel')}</p>
      <h1>{c('setupTitle')}</h1>
      <p className="lead">{c('setupSubtitle')}</p>
      <p className="privacy-promise"><Icon name="shield" />{c('privacyPromise')}</p>
      <form onSubmit={(event) => void submit(event)} className="form-stack">
        <label>{c('shopName')}<input value={name} onChange={(event) => setName(event.target.value)} placeholder={c('shopNamePlaceholder')} autoComplete="organization" required maxLength={160} /></label>
        <label>{c('uiLanguage')}<select value={language} onChange={(event) => { const nextLanguage = event.target.value as UiLanguage; setLanguage(nextLanguage); document.documentElement.lang = nextLanguage === 'hi' ? 'hi' : nextLanguage === 'mr' ? 'mr' : 'en'; }}><option value="en">English</option><option value="hi">हिन्दी</option><option value="mr">मराठी</option></select></label>
        <div className="paper-rule" />
        <h2>{c('protectTitle')}</h2>
        <p className="muted">{c('protectHelp')}</p>
        <label>{c('optionalPin')}<input value={pin} onChange={(event) => setPin(event.target.value.replace(/\D/g, '').slice(0, 4))} placeholder={c('pinPlaceholder')} inputMode="numeric" autoComplete="off" type="password" pattern="\d{4}" maxLength={4} /></label>
        <label>{c('confirmPin')}<input value={pinConfirm} onChange={(event) => setPinConfirm(event.target.value.replace(/\D/g, '').slice(0, 4))} placeholder={c('pinPlaceholder')} inputMode="numeric" autoComplete="off" type="password" maxLength={4} /></label>
        {error && <p className="error-message" role="alert">{error}</p>}
        <button className="primary-button" type="submit" disabled={busy}>{busy ? c('loading') : c('saveAndProtect')}</button>
        <button className="text-button" type="button" disabled={busy} onClick={(event) => void submit(event as unknown as FormEvent, true)}>{c('continueWithoutPin')}</button>
      </form>
    </div>
  </main>;
}

function LockScreen({ shop, onUnlock }: { shop: ShopRecord; onUnlock: () => void }) {
  const lang = shop.preferred_language;
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [secondsLeft, setSecondsLeft] = useState(0);
  const c = (key: Parameters<typeof t>[1]) => t(lang, key);
  useEffect(() => {
    const readLockout = () => {
      try { const v = JSON.parse(sessionStorage.getItem('pk-pin-failures') ?? '{}') as { until?: number }; setSecondsLeft(Math.max(0, Math.ceil(((v.until ?? 0) - Date.now()) / 1000))); } catch { setSecondsLeft(0); }
    };
    readLockout();
    const timer = window.setInterval(readLockout, 500);
    return () => window.clearInterval(timer);
  }, []);
  const unlock = async (event: FormEvent) => {
    event.preventDefault();
    setError('');
    if (secondsLeft > 0) { setError(c('tooManyPin')); return; }
    if (shop.pin_hash && shop.pin_salt && await verifyPin(pin, shop.pin_hash, shop.pin_salt)) {
      sessionStorage.removeItem('pk-pin-failures');
      onUnlock();
      return;
    }
    let failures = { attempts: 0, until: 0 };
    try { failures = { ...failures, ...(JSON.parse(sessionStorage.getItem('pk-pin-failures') ?? '{}') as typeof failures) }; } catch { /* ignore invalid local lockout metadata */ }
    const lockout = nextPinLockout(failures.attempts);
    failures.attempts = lockout.attempts;
    if (lockout.durationMs > 0) failures.until = Date.now() + lockout.durationMs;
    sessionStorage.setItem('pk-pin-failures', JSON.stringify(failures));
    setPin('');
    setError(failures.until > Date.now() ? c('tooManyPin') : c('wrongPin'));
  };
  return <main className="lock-screen"><div className="lock-cover"><div className="lock-cover-mark"><Icon name="book" /></div><p className="eyebrow">पक्का खाता</p><h1>{shop.name}</h1><p className="muted">{c('enterPin')}</p><form onSubmit={(event) => void unlock(event)} className="form-stack"><input aria-label={c('enterPin')} autoFocus value={pin} onChange={(event) => setPin(event.target.value.replace(/\D/g, '').slice(0, 4))} inputMode="numeric" type="password" pattern="\d{4}" maxLength={4} required /><div className="pin-dots" aria-hidden="true">{[0, 1, 2, 3].map((n) => <span className={pin.length > n ? 'filled' : ''} key={n} />)}</div>{error && <p role="alert" className="error-message">{error}{secondsLeft > 0 ? ` (${secondsLeft}s)` : ''}</p>}<button className="primary-button" disabled={pin.length !== 4 || secondsLeft > 0}>{c('unlock')}</button></form><p className="small-note">{c('appLockHelp')}</p></div></main>;
}

async function addSampleLedger() {
  await db.transaction('rw', db.customers, db.entries, async () => {
    await db.entries.filter((entry) => entry.is_sample).delete();
    await db.customers.filter((customer) => customer.is_sample).delete();
    const customerId = makeId();
    const now = new Date().toISOString();
    const customer: CustomerRecord = { id: customerId, name: 'Ramesh Kumar · SAMPLE', phone: null, notes: 'Bundled sample ledger. Not real customer data.', created_at: now, is_sample: true };
    const rows: Array<{ date: string; items: string; amount: number; type: 'credit' | 'payment' }> = [
      { date: '2026-10-01', items: 'Opening balance (Balance B/F)', amount: 1250, type: 'credit' },
      { date: '2026-10-03', items: '5kg Aashirvaad Atta', amount: 230, type: 'credit' },
      { date: '2026-10-03', items: '1L Fortune Sunlite Oil', amount: 145, type: 'credit' },
      { date: '2026-10-05', items: 'Cash received', amount: 1000, type: 'payment' },
      { date: '2026-10-08', items: '2kg Tata Salt + 1 packet tea', amount: 180, type: 'credit' },
      { date: '2026-10-12', items: 'Dairy Milk & biscuits', amount: 95, type: 'credit' },
    ];
    await db.customers.add(customer);
    await db.entries.bulkAdd(rows.map((row) => ({ ...row, id: makeId(), customer_id: customerId, source: 'sample' as const, confidence: 1, raw_text: null, created_at: now, is_sample: true })));
  });
}

function HomePage({ snapshot, refresh }: { snapshot: Snapshot; refresh: () => Promise<unknown> }) {
  const shop = snapshot.shop!;
  const lang = shop.preferred_language;
  const c = (key: Parameters<typeof t>[1]) => t(lang, key);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const total = totalOutstanding(snapshot.entries);
  const balances = useMemo(() => snapshot.customers.map((customer) => ({ customer, balance: customerBalance(customer.id, snapshot.entries), latest: snapshot.entries.filter((entry) => entry.customer_id === customer.id).sort((a, b) => b.date.localeCompare(a.date))[0]?.date ?? '' })).filter((item) => item.balance > 0).sort((a, b) => b.balance - a.balance), [snapshot.customers, snapshot.entries]);
  const backupDue = snapshot.entries.length > 0 && (!shop.last_backup_at || (Date.now() - Date.parse(shop.last_backup_at)) >= 7 * 86400_000 || snapshot.entries.length - shop.last_backup_entry_count >= 20);
  const dismissed = shop.backup_prompt_dismissed_until && Date.parse(shop.backup_prompt_dismissed_until) > Date.now();
  const sampleCount = snapshot.entries.filter((entry) => entry.is_sample).length;
  const daysSinceBackup = shop.last_backup_at ? Math.max(0, Math.floor((Date.now() - Date.parse(shop.last_backup_at)) / 86400_000)) : null;
  const loadSample = async () => {
    setBusy(true);
    try { await addSampleLedger(); await refresh(); setNotice(c('sampleAdded')); }
    catch { setNotice(c('errorGeneric')); }
    finally { setBusy(false); }
  };
  const removeSample = async () => {
    await db.transaction('rw', db.customers, db.entries, async () => {
      await db.entries.filter((entry) => entry.is_sample).delete();
      await db.customers.filter((customer) => customer.is_sample).delete();
    });
    await refresh(); setNotice(c('sampleRemoved'));
  };
  const dismissBackup = async () => {
    await saveShop({ ...shop, backup_prompt_dismissed_until: new Date(Date.now() + 86400_000).toISOString() });
    await refresh();
  };
  return <main className="screen-content">
    <section className="page-heading"><div><p className="eyebrow">{c('todayAccount')}</p><h1>{shop.name}</h1><p className="muted">{new Date().toLocaleDateString(lang === 'hi' ? 'hi-IN' : lang === 'mr' ? 'mr-IN' : 'en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</p></div><span className="paper-stamp"><Icon name="shield" />{c('localOnly')}</span></section>
    {backupDue && !dismissed && <section className="backup-reminder" role="status"><strong>{c('backupReminder')}</strong><div className="inline-actions"><NavLink className="text-action" to="/settings">{c('backupNow')}</NavLink><button className="text-button compact" onClick={() => void dismissBackup()}>{c('dismiss24')}</button></div></section>}
    {sampleCount > 0 && <div className="sample-ribbon"><strong>{c('sampleLabel')}</strong><span>{c('sampleMarker')}</span><button onClick={() => void removeSample()}>{c('removeSample')}</button></div>}
    <section className="ledger-summary" aria-label={c('outstanding')}><div className="summary-primary"><span className="section-label">{c('outstanding')} / बकाया</span><strong>{formatRupees(total)}</strong><span className="summary-foot">{balances.length} {c('customersOwing').toLocaleLowerCase()}</span></div><div className="summary-stats"><div><span>{c('customersOwing')}</span><strong>{balances.length}</strong></div><div><span>{c('entries')}</span><strong>{snapshot.entries.length}</strong></div></div></section>
    <div className="home-primary-actions"><NavLink className="primary-button scan-home-button" to="/scan"><Icon name="scan" />{c('scanPage')}</NavLink></div>
    <section className="ledger-section"><div className="section-heading"><div><p className="eyebrow">{c('sectionUdhaar')}</p><h2>{c('topOwing')}</h2></div><NavLink className="text-action" to="/customers">{c('customers')} ↗</NavLink></div>
      {balances.length === 0 ? <div className="empty-ledger"><div className="empty-book"><Icon name="book" /></div><p>{c('noCustomers')}</p><div className="empty-sample"><img src="/sample-khata.svg" alt={c('sampleMarker')} /><button className="primary-button" onClick={() => void loadSample()} disabled={busy}>{busy ? c('loading') : c('trySample')}</button><small>{c('sampleMarker')}</small></div></div> : <div className="ledger-list">{balances.slice(0, 5).map(({ customer, balance, latest }, index) => <article className="ledger-row" key={customer.id}><span className="row-index">{String(index + 1).padStart(2, '0')}</span><div className="row-main"><strong>{customer.name}</strong><span>{latest ? new Date(`${latest}T00:00:00`).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : c('never')}</span></div><strong className="amount-due">{formatRupees(balance)}</strong></article>)}</div>}
    </section>
    {snapshot.entries.length > 0 && sampleCount === 0 && <button className="secondary-button" onClick={() => void loadSample()} disabled={busy}>{c('trySample')}</button>}
    <section className="backup-status"><Icon name="shield" /><div><strong>{c('lastBackup')}: {daysSinceBackup === null ? c('never') : daysSinceBackup === 0 ? c('today') : `${daysSinceBackup} ${c('daysAgo')}`}</strong><span>{shop.last_backup_at ? c('backupHelp') : c('backupAgeUnknown')}</span></div><NavLink to="/settings" aria-label={c('settings')}>↗</NavLink></section>
    {notice && <p className="success-message" role="status">{notice}</p>}
  </main>;
}

function SettingsPage({ snapshot, refresh, onDelete }: { snapshot: Snapshot; refresh: () => Promise<unknown>; onDelete: () => Promise<void> }) {
  const shop = snapshot.shop!;
  const c = (key: Parameters<typeof t>[1]) => t(shop.preferred_language, key);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [pin, setPin] = useState('');
  const [pinConfirm, setPinConfirm] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [passphraseConfirm, setPassphraseConfirm] = useState('');
  const [restorePassphrase, setRestorePassphrase] = useState('');
  const [restoreFile, setRestoreFile] = useState<File | null>(null);
  const [restoreMode, setRestoreMode] = useState<'replace' | 'merge'>('replace');
  const [deleteText, setDeleteText] = useState('');
  const [shopName, setShopName] = useState(shop.name);
  useEffect(() => setShopName(shop.name), [shop.name]);
  const update = async (patch: Partial<ShopRecord>) => { await saveShop({ ...shop, ...patch }); await refresh(); };
  const sayError = (message: string) => { setNotice(''); setError(message); };
  const sayNotice = (message: string) => { setError(''); setNotice(message); };
  const createBackup = async () => {
    setBusy(true); setError(''); setNotice('');
    try {
      if (passphrase.length < 8) throw new Error(c('passphraseShort'));
      if (passphrase !== passphraseConfirm) throw new Error(c('passphraseMismatch'));
      const payload = buildBackupPayload(shop, snapshot.customers, snapshot.entries);
      const blob = await encryptBackup(payload, passphrase);
      const filename = `pakka-khata-backup-${new Date().toISOString().slice(0, 10)}.pkb`;
      const file = new File([blob], filename, { type: blob.type });
      let shared = false;
      try {
        if (navigator.share && navigator.canShare?.({ files: [file] })) {
          await navigator.share({ files: [file], title: 'Pakka Khata encrypted backup' });
          shared = true;
        }
      } catch (shareError) {
        // If the user cancels the native share sheet, don't force a second download.
        if (!(shareError instanceof DOMException && shareError.name === 'AbortError')) {
          // Some browsers expose share but reject file sharing; fall through to download.
        } // A cancelled share also falls back to a direct download.
      }
      if (!shared) downloadBlob(blob, filename);
      const updated: ShopRecord = { ...shop, last_backup_at: new Date().toISOString(), last_backup_entry_count: snapshot.entries.length, backup_prompt_dismissed_until: null };
      await saveShop(updated); await refresh(); setPassphrase(''); setPassphraseConfirm('');
      sayNotice(c('backupSuccess'));
    } catch (e) { sayError(e instanceof Error ? e.message : c('errorGeneric')); }
    finally { setBusy(false); }
  };
  const restore = async () => {
    setBusy(true); setError(''); setNotice('');
    try {
      if (!restoreFile) throw new Error(c('noBackupFile'));
      const payload = await decryptBackup(await restoreFile.text(), restorePassphrase);
      if (restoreMode === 'replace') {
        await db.transaction('rw', db.shop, db.customers, db.entries, async () => {
          await db.entries.clear(); await db.customers.clear();
          const localShop = await db.shop.get('primary');
          await db.shop.put({
            ...(localShop ?? shop), ...payload.shop, id: 'primary',
            last_backup_at: new Date().toISOString(), last_backup_entry_count: payload.entries.length,
            // Preserve this device's PIN and storage-protection result; these are not part of backups.
            pin_hash: localShop?.pin_hash ?? null, pin_salt: localShop?.pin_salt ?? null,
            storage_persisted: localShop?.storage_persisted ?? null,
            backup_prompt_dismissed_until: null,
          });
          await db.customers.bulkAdd(payload.customers);
          await db.entries.bulkAdd(payload.entries);
        });
      } else {
        await db.transaction('rw', db.shop, db.customers, db.entries, async () => {
          const existingCustomers = await db.customers.toArray();
          const existingEntries = await db.entries.toArray();
          const { customersToAdd, entriesToAdd } = planBackupMerge(
            existingCustomers, existingEntries, payload.customers, payload.entries,
          );
          if (customersToAdd.length) await db.customers.bulkAdd(customersToAdd);
          if (entriesToAdd.length) await db.entries.bulkAdd(entriesToAdd);
          const latestShop = await db.shop.get('primary') ?? shop;
          await db.shop.put({ ...latestShop, last_backup_at: new Date().toISOString(), last_backup_entry_count: (await db.entries.count()), backup_prompt_dismissed_until: null });
        });
      }
      await refresh(); setRestorePassphrase(''); setRestoreFile(null); sayNotice(c('restoreSuccess'));
    } catch (e) { sayError(e instanceof Error ? e.message : c('errorGeneric')); }
    finally { setBusy(false); }
  };
  const exportCsv = () => {
    const csv = makeLedgerCsv(snapshot.customers, snapshot.entries);
    downloadBlob(new Blob([csv], { type: 'text/csv;charset=utf-8' }), `pakka-khata-readable-${new Date().toISOString().slice(0, 10)}.csv`);
  };
  const setNewPin = async () => {
    if (!/^\d{4}$/.test(pin)) return sayError(c('optionalPin'));
    if (pin !== pinConfirm) return sayError(c('pinMismatch'));
    const result = await hashPin(pin);
    await update({ pin_hash: result.hash, pin_salt: result.salt });
    setPin(''); setPinConfirm(''); sayNotice(c('pinSaved'));
  };
  const removePin = async () => {
    await update({ pin_hash: null, pin_salt: null }); setPin(''); setPinConfirm(''); sayNotice(c('pinRemoved'));
  };
  const requestPersistence = async () => {
    try { const result = navigator.storage?.persist ? await navigator.storage.persist() : false; await update({ storage_persisted: result }); sayNotice(c('storageProtected')); }
    catch { await update({ storage_persisted: false }); sayError(c('errorGeneric')); }
  };
  const deleteData = async () => {
    if (deleteText !== DELETE_CONFIRMATION) return sayError(c('confirmDelete'));
    await onDelete();
  };
  return <main className="screen-content settings-screen"><section className="page-heading"><div><p className="eyebrow">04 / {c('sectionKeepSafe')}</p><h1>{c('settings')}</h1><p className="muted">{shop.name}</p></div></section>
    <section className="settings-section"><div className="settings-title"><Icon name="book" /><div><h2>{c('shopName')}</h2><p>{c('language')}</p></div></div><label>{c('shopName')}<input value={shopName} maxLength={160} onChange={(event) => setShopName(event.target.value)} /></label><button className="secondary-button" onClick={() => { if (shopName.trim()) void update({ name: shopName.trim() }); }}>{c('save')}</button><label>{c('language')}<select value={shop.preferred_language} onChange={(event) => { const language = event.target.value as UiLanguage; void update({ preferred_language: language, reminder_language: reminderLanguageForUi(language) }); }}><option value="en">English</option><option value="hi">हिन्दी</option><option value="mr">मराठी</option></select></label><label>{c('reminderLanguage')}<select value={shop.reminder_language} onChange={(event) => void update({ reminder_language: event.target.value as ReminderLanguage })}><option value="english">English</option><option value="hindi">हिन्दी</option><option value="marathi">मराठी</option><option value="hinglish">Hinglish</option></select></label></section>
    <section className="settings-section privacy-card"><div className="settings-title"><Icon name="shield" /><div><h2>{c('privacy')}</h2><p>{c('privacyCard')}</p></div></div><div className="storage-line"><span>{c('storageStatus')}</span><strong>{shop.storage_persisted === true ? c('yes') : shop.storage_persisted === false ? c('no') : c('unknown')}</strong></div><button className="secondary-button" onClick={() => void requestPersistence()}>{c('protectTitle')}</button><small className="muted">{c('storageDisclaimer')}</small></section>
    <section className="settings-section"><div className="settings-title"><Icon name="lock" /><div><h2>{c('appLock')}</h2><p>{c('appLockHelp')}</p></div></div>{shop.pin_hash ? <div className="pin-active"><strong>••••</strong><button className="secondary-button" onClick={() => void removePin()}>{c('removePin')}</button></div> : <><label>{c('optionalPin')}<input value={pin} onChange={(event) => setPin(event.target.value.replace(/\D/g, '').slice(0, 4))} type="password" inputMode="numeric" autoComplete="off" placeholder={c('pinPlaceholder')} /></label><label>{c('confirmPin')}<input value={pinConfirm} onChange={(event) => setPinConfirm(event.target.value.replace(/\D/g, '').slice(0, 4))} type="password" inputMode="numeric" autoComplete="off" placeholder={c('pinPlaceholder')} /></label><button className="secondary-button" onClick={() => void setNewPin()}>{c('setPin')}</button></>}</section>
    <section className="settings-section"><div className="settings-title"><Icon name="download" /><div><h2>{c('backupRestore')}</h2><p>{c('backupHelp')}</p></div></div><label>{c('backupPassphrase')}<input value={passphrase} onChange={(event) => setPassphrase(event.target.value)} type="password" autoComplete="new-password" /></label><label>{c('repeatPassphrase')}<input value={passphraseConfirm} onChange={(event) => setPassphraseConfirm(event.target.value)} type="password" autoComplete="new-password" /></label><button className="primary-button" onClick={() => void createBackup()} disabled={busy}>{busy ? c('loading') : c('createBackup')}</button><div className="paper-rule"/><label>{c('restoreFile')}<input type="file" accept=".pkb,application/json" onChange={(event) => setRestoreFile(event.target.files?.[0] ?? null)} /></label><label>{c('restorePassphrase')}<input value={restorePassphrase} onChange={(event) => setRestorePassphrase(event.target.value)} type="password" autoComplete="current-password" /></label><label>{c('restoreMode')}<select value={restoreMode} onChange={(event) => setRestoreMode(event.target.value as 'replace' | 'merge')}><option value="replace">{c('replace')}</option><option value="merge">{c('merge')}</option></select></label><button className="secondary-button" onClick={() => void restore()} disabled={busy || !restoreFile}>{busy ? c('loading') : c('restore')}</button></section>
    <section className="settings-section"><div className="settings-title"><Icon name="download" /><div><h2>{c('exportCsv')}</h2><p>{c('csvWarning')}</p></div></div><button className="secondary-button" onClick={exportCsv}>{c('exportCsv')}</button></section>
    <section className="settings-section danger-zone"><div className="settings-title"><span className="danger-symbol">!</span><div><h2>{c('deleteAll')}</h2><p>{c('deleteHelp')}</p></div></div><label>{c('typeDelete')}<input value={deleteText} onChange={(event) => setDeleteText(event.target.value)} autoComplete="off" /></label><button className="danger-button" onClick={() => void deleteData()}>{c('deleteConfirm')}</button></section>
    {error && <p role="alert" className="error-message settings-feedback">{error}</p>}{notice && <p role="status" className="success-message settings-feedback">{notice}</p>}
  </main>;
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url; anchor.download = filename; anchor.style.display = 'none';
  document.body.appendChild(anchor); anchor.click(); anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function RootApp() {
  return <BrowserRouter><App /></BrowserRouter>;
}
