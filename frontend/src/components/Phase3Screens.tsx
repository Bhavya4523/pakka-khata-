import { useEffect, useMemo, useRef, useState, type FormEvent, type ChangeEvent } from 'react';
import { Link, NavLink, Navigate, useNavigate, useParams } from 'react-router-dom';
import {
  db, customerBalance, formatRupees, makeId,
  type CustomerRecord, type EntryRecord, type ReminderLanguage, type ShopRecord, type UiLanguage,
} from '../lib/db';
import { p3, type Phase3Key } from '../lib/phase3-i18n';
import { translate as baseT } from '../lib/i18n';
import { normalizeCustomerName, suggestCustomers } from '../lib/customer-matching';

type Snapshot = { shop?: ShopRecord; customers: CustomerRecord[]; entries: EntryRecord[] };
type ApiRow = {
  customer_name: string;
  date: string | null;
  items: string | null;
  amount: number;
  type: 'credit' | 'payment';
  confidence: number;
  raw_text: string;
};
type ReviewRow = ApiRow & { rowKey: string; matchedCustomerId?: string };
type ScanPayload = { page_title: string | null; rows: ApiRow[]; warnings: string[]; demo: boolean };

const todayISO = () => { const value = new Date(); return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`; };
const uiLocale = (lang: UiLanguage) => lang === 'hi' ? 'hi-IN' : lang === 'mr' ? 'mr-IN' : 'en-IN';
const tr = (lang: UiLanguage, key: Phase3Key, values?: Record<string, string | number>) => p3(lang, key, values);

async function prepareImage(file: File): Promise<Blob> {
  const allowed = new Set(['image/jpeg', 'image/png', 'image/webp']);
  if (!allowed.has(file.type.toLowerCase())) throw new Error('bad-type');
  let bitmap: ImageBitmap | null = null;
  let source: CanvasImageSource;
  let sourceWidth = 0;
  let sourceHeight = 0;
  if ('createImageBitmap' in window) {
    try {
      bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
      source = bitmap;
      sourceWidth = bitmap.width;
      sourceHeight = bitmap.height;
    } catch {
      source = await decodeImageElement(file);
      const img = source as HTMLImageElement;
      sourceWidth = img.naturalWidth;
      sourceHeight = img.naturalHeight;
    }
  } else {
    source = await decodeImageElement(file);
    const img = source as HTMLImageElement;
    sourceWidth = img.naturalWidth;
    sourceHeight = img.naturalHeight;
  }
  try {
    if (!sourceWidth || !sourceHeight) throw new Error('bad-image');
    const scale = Math.min(1, 1600 / Math.max(sourceWidth, sourceHeight));
    const width = Math.max(1, Math.round(sourceWidth * scale));
    const height = Math.max(1, Math.round(sourceHeight * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('canvas-unavailable');
    context.drawImage(source, 0, 0, width, height);
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((result) => result ? resolve(result) : reject(new Error('encode-failed')), 'image/jpeg', 0.85);
    });
    if (blob.size > 8 * 1024 * 1024) throw new Error('too-large');
    return blob;
  } finally {
    bitmap?.close();
  }
}

function decodeImageElement(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => { URL.revokeObjectURL(url); resolve(image); };
    image.onerror = () => { URL.revokeObjectURL(url); reject(new Error('bad-image')); };
    image.src = url;
  });
}

function localReminder(shopName: string, customerName: string, amount: number, language: ReminderLanguage): string {
  const due = formatRupees(amount);
  if (language === 'hindi') return `नमस्ते ${customerName} जी, ${shopName} की ओर से ${due} की बाकी राशि के लिए विनम्र याद दिला रहे हैं। सुविधा होने पर कृपया बता दें। धन्यवाद! 🙏`;
  if (language === 'marathi') return `नमस्कार ${customerName}, ${shopName} कडून ${due} बाकी रकमेची नम्र आठवण. सोयीने कृपया कळवा. धन्यवाद! 🙏`;
  if (language === 'hinglish') return `Namaste ${customerName} ji, ${shopName} ki taraf se ${due} pending amount ki ek gentle reminder. Aapko jab convenient ho tab bata dijiyega. Thank you! 🙏`;
  return `Hello ${customerName}, a gentle reminder from ${shopName} about the pending amount of ${due}. Whenever convenient, please let us know. Thank you!`;
}

export function ScanPage({ shop, customers, refresh }: { shop?: ShopRecord; customers: CustomerRecord[]; refresh: () => Promise<unknown> }) {
  const lang = shop?.preferred_language ?? 'en';
  const c = (key: Phase3Key, values?: Record<string, string | number>) => tr(lang, key, values);
  const navigate = useNavigate();
  const cameraInput = useRef<HTMLInputElement>(null);
  const galleryInput = useRef<HTMLInputElement>(null);
  const controller = useRef<AbortController | null>(null);
  const [photo, setPhoto] = useState<Blob | null>(null);
  const [photoUrl, setPhotoUrl] = useState<string | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState('');
  const [payload, setPayload] = useState<ScanPayload | null>(null);
  const [rows, setRows] = useState<ReviewRow[]>([]);
  const [reviewPane, setReviewPane] = useState<'photo' | 'rows'>('rows');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => {
    if (!photo) { setPhotoUrl(null); return; }
    const url = URL.createObjectURL(photo);
    setPhotoUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [photo]);
  useEffect(() => {
    if (!busy) return;
    const timer = window.setInterval(() => setElapsed((n) => n + 1), 1000);
    return () => window.clearInterval(timer);
  }, [busy]);
  useEffect(() => () => controller.current?.abort(), []);

  const clearCurrent = () => {
    controller.current?.abort();
    controller.current = null;
    setPhoto(null); setPayload(null); setRows([]); setError(''); setSaveError(''); setNotice(''); setElapsed(0); setBusy(false);
  };

  const selectFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setError(''); setSaveError(''); setPayload(null); setRows([]); setNotice('');
    setPreparing(true);
    try {
      const prepared = await prepareImage(file);
      setPhoto(prepared);
    } catch (e) {
      const message = e instanceof Error ? e.message : '';
      setError(message === 'too-large' ? c('errorTooLarge') : message === 'bad-type' || message === 'bad-image' ? c('errorBadPhoto') : c('errorGenericScan'));
      setPhoto(null);
    } finally { setPreparing(false); }
  };

  const scan = async () => {
    if (!photo) { setError(c('selectPhotoFirst')); return; }
    setError(''); setSaveError(''); setPayload(null); setRows([]); setBusy(true); setElapsed(0);
    const aborter = new AbortController();
    controller.current = aborter;
    try {
      const form = new FormData();
      form.append('image', photo, 'khata-page.jpg');
      form.append('language_hint', lang === 'hi' ? 'Hindi / Devanagari' : lang === 'mr' ? 'Marathi / Devanagari' : 'English, Hindi or Marathi as written');
      const response = await fetch('/api/scan', { method: 'POST', body: form, signal: aborter.signal, cache: 'no-store' });
      const body = await response.json().catch(() => ({} as Record<string, unknown>)) as Record<string, unknown>;
      if (!response.ok) {
        const detail = typeof body.detail === 'string' ? body.detail.toLowerCase() : '';
        if (response.status === 413) throw new Error(c('errorTooLarge'));
        if (response.status === 415 || response.status === 400) throw new Error(c('errorBadPhoto'));
        if (detail.includes('too long') || detail.includes('timeout')) throw new Error(c('errorTimeout'));
        if (response.status === 503 || detail.includes('unavailable') || detail.includes('ollama')) throw new Error(c('errorModelOffline'));
        throw new Error(c('errorGenericScan'));
      }
      const parsed = body as unknown as ScanPayload;
      if (!Array.isArray(parsed.rows) || typeof parsed.demo !== 'boolean') throw new Error(c('errorGenericScan'));
      setPayload(parsed);
      setRows(parsed.rows.map((row) => ({ ...row, amount: Math.round(Number(row.amount)), rowKey: makeId() })));
      setReviewPane('rows');
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return;
      setError(e instanceof Error ? e.message : c('errorGenericScan'));
    } finally { setBusy(false); controller.current = null; }
  };

  const reviewTotals = rows.reduce((totals, row) => {
    if (row.type === 'credit') totals.credits += Math.max(0, Number(row.amount) || 0);
    else totals.payments += Math.max(0, Number(row.amount) || 0);
    return totals;
  }, { credits: 0, payments: 0 });
  const estimatedReviewBalance = reviewTotals.credits - reviewTotals.payments;

  const editRow = (rowKey: string, patch: Partial<ReviewRow>) => {
    setRows((current) => current.map((row) => row.rowKey === rowKey ? { ...row, ...patch } : row));
  };
  const setExistingCustomer = (row: ReviewRow, customer: CustomerRecord) => {
    const normalized = normalizeCustomerName(row.customer_name);
    setRows((current) => current.map((item) => normalizeCustomerName(item.customer_name) === normalized ? { ...item, matchedCustomerId: customer.id } : item));
  };
  const addBlankRow = () => setRows((current) => [...current, {
    rowKey: makeId(), customer_name: '', date: todayISO(), items: '', amount: 1, type: 'credit', confidence: 1,
    raw_text: 'Manually added during review',
  }]);

  const saveReviewedRows = async () => {
    setSaveError('');
    if (payload?.demo) { setSaveError(c('demoWarning')); return; }
    if (!rows.length) { setSaveError(c('noRows')); return; }
    if (rows.some((row) => !row.customer_name.trim())) { setSaveError(c('missingName')); return; }
    if (rows.some((row) => !row.date || !/^\d{4}-\d{2}-\d{2}$/.test(row.date))) { setSaveError(c('missingDate')); return; }
    if (rows.some((row) => !Number.isSafeInteger(row.amount) || row.amount <= 0)) { setSaveError(c('invalidAmount')); return; }
    if (!shop) return;
    setSaving(true);
    try {
      await db.transaction('rw', db.customers, db.entries, async () => {
        const existing = await db.customers.toArray();
        const existingIds = new Set(existing.map((item) => item.id));
        const createdByName = new Map<string, string>();
        const newCustomers: CustomerRecord[] = [];
        const newEntries: EntryRecord[] = [];
        const now = new Date().toISOString();
        for (const row of rows) {
          const normalized = normalizeCustomerName(row.customer_name);
          let customerId = row.matchedCustomerId && existingIds.has(row.matchedCustomerId) ? row.matchedCustomerId : createdByName.get(normalized);
          if (!customerId) {
            customerId = makeId();
            createdByName.set(normalized, customerId);
            newCustomers.push({ id: customerId, name: row.customer_name.trim(), phone: null, notes: null, created_at: now, is_sample: false });
          }
          newEntries.push({
            id: makeId(), customer_id: customerId, date: row.date!, items: row.items?.trim() || null,
            amount: Math.round(row.amount), type: row.type, source: 'scan', confidence: row.confidence,
            raw_text: row.raw_text || null, created_at: now, is_sample: false,
          });
        }
        if (newCustomers.length) await db.customers.bulkAdd(newCustomers);
        if (newEntries.length) await db.entries.bulkAdd(newEntries);
      });
      await refresh();
      setNotice(c('scanSaved'));
      setPhoto(null); setPayload(null); setRows([]); setError('');
      navigate('/customers');
    } catch {
      setSaveError(c('errorGenericScan'));
    } finally { setSaving(false); }
  };

  return <main className="screen-content phase3-screen">
    <section className="page-heading"><div><p className="eyebrow">03 / {c('scanTitle')}</p><h1>{c(payload ? 'reviewTitle' : 'scanTitle')}</h1><p className="muted">{c(payload ? 'reviewIntro' : 'scanDescription')}</p></div></section>
    {!payload && <>
      <section className="scan-upload-paper">
        <div className="scan-frame" aria-hidden="true"><span className="scan-line" /><svg className="phase3-scan-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M4 8V4h4M16 4h4v4M20 16v4h-4M8 20H4v-4"/><path d="M8 8h8v8H8z"/></svg></div>
        <p className="scan-guidance">{c('photoGuidance')}</p>
        <input ref={cameraInput} className="visually-hidden" type="file" accept="image/jpeg,image/png,image/webp" capture="environment" onChange={(event) => void selectFile(event)} aria-label={c('cameraPhoto')} />
        <input ref={galleryInput} className="visually-hidden" type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => void selectFile(event)} aria-label={c('galleryPhoto')} />
        <div className="action-row"><button type="button" className="secondary-button" onClick={() => cameraInput.current?.click()} disabled={busy || preparing}>{c('cameraPhoto')}</button><button type="button" className="secondary-button" onClick={() => galleryInput.current?.click()} disabled={busy || preparing}>{c('galleryPhoto')}</button></div>
        {preparing && <p role="status">{baseT(lang, 'loading')}</p>}
        {photoUrl && <div className="selected-photo-box"><div className="scan-photo-heading"><strong>{c('selectedPhoto')}</strong><button type="button" className="text-button" onClick={clearCurrent} disabled={busy}>{c('changePhoto')}</button></div><img src={photoUrl} alt={c('selectedPhoto')} className="selected-photo" /><button type="button" className="primary-button" onClick={() => void scan()} disabled={busy || preparing}>{busy ? c('readingPage') : c('readPage')}</button></div>}
        {busy && <div className="scan-progress" role="status" aria-live="polite"><div className="scan-progress-line" /><strong>{c('readingPage')}</strong><span>{elapsed} {c('elapsed')}</span><button className="text-button" onClick={() => { controller.current?.abort(); clearCurrent(); }} type="button">{c('cancelScan')}</button></div>}
        {error && <div className="error-message" role="alert">{error}<div><button type="button" className="text-button" onClick={() => void scan()} disabled={!photo || busy}>{c('retry')}</button></div></div>}
      </section>
      {notice && <p className="success-message" role="status">{notice}</p>}
    </>}
    {payload && <>
      {payload.demo && <div role="alert" className="demo-scan-warning"><strong>{c('demoWarning')}</strong></div>}
      {!!payload.warnings?.length && <section className="scan-warnings"><h2>{c('modelWarnings')}</h2><ul>{payload.warnings.map((warning, index) => <li key={`${index}-${warning}`}>{warning}</li>)}</ul></section>}
      <section className="scan-warnings review-totals" aria-live="polite"><h2>{c('reviewTotals')}</h2><p><strong>{c('totalCredits')}:</strong> {formatRupees(reviewTotals.credits)} · <strong>{c('totalPayments')}:</strong> {formatRupees(reviewTotals.payments)}</p><p><strong>{c('estimatedBalance')}:</strong> {formatRupees(estimatedReviewBalance)}</p><p>{c('checkTotalsWarning')}</p></section>
      <div className="review-pane-toggle"><button type="button" className={reviewPane === 'photo' ? 'selected' : ''} onClick={() => setReviewPane('photo')}>{c('photo')}</button><button type="button" className={reviewPane === 'rows' ? 'selected' : ''} onClick={() => setReviewPane('rows')}>{c('rows')} ({rows.length})</button></div>
      <div className={`review-layout ${reviewPane === 'photo' ? 'show-photo' : 'show-rows'}`}>
        <aside className="review-photo-pane"><div className="review-subheading"><h2>{c('photo')}</h2><a href={photoUrl ?? undefined} target="_blank" rel="noreferrer">{c('zoomPhoto')} ↗</a></div>{photoUrl && <img src={photoUrl} alt={c('selectedPhoto')} className="review-photo" />}</aside>
        <section className="review-rows-pane"><div className="review-subheading"><h2>{c('rows')} ({rows.length})</h2><button type="button" className="secondary-button compact" onClick={addBlankRow}>{c('addMissingRow')}</button></div>
          {rows.length === 0 && <p className="muted">{c('noRows')}</p>}
          {rows.map((row, index) => {
            const suggestions = suggestCustomers(row.customer_name, customers);
            const confidenceLow = row.confidence < 0.7;
            return <article className={`review-row-card ${confidenceLow ? 'low-confidence' : ''}`} key={row.rowKey}>
              <div className="review-row-title"><span className="row-index">{String(index + 1).padStart(2, '0')}</span><strong>{row.type === 'payment' ? c('payment') : c('credit')}</strong><button type="button" className="text-button compact danger-text" onClick={() => setRows((current) => current.filter((item) => item.rowKey !== row.rowKey))}>{c('removeRow')}</button></div>
              {confidenceLow && <p className="confidence-warning" role="note">⚑ {c('needsCheck')} · {c('confidence')}: {Math.round(row.confidence * 100)}%</p>}
              <label>{c('customerName')}<input value={row.customer_name} maxLength={160} onChange={(event) => editRow(row.rowKey, { customer_name: event.target.value, matchedCustomerId: undefined })} required /></label>
              {suggestions.length > 0 && !row.matchedCustomerId && <div className="match-suggestions"><span>{c('confirmMatch')}</span>{suggestions.map((customer) => <button type="button" key={customer.id} onClick={() => setExistingCustomer(row, customer)}>{c('useExisting')}: {customer.name}</button>)}</div>}
              {row.matchedCustomerId && <p className="match-confirmed">{c('useExisting')}: {customers.find((item) => item.id === row.matchedCustomerId)?.name ?? ''} <button type="button" className="text-button compact" onClick={() => editRow(row.rowKey, { matchedCustomerId: undefined })}>{c('createNewCustomerInstead')}</button></p>}
              <div className="review-row-grid"><label>{c('date')}<input type="date" value={row.date ?? ''} onChange={(event) => editRow(row.rowKey, { date: event.target.value || null })} required /></label><label>{c('amount')}<input type="number" min="1" step="1" value={row.amount || ''} onChange={(event) => editRow(row.rowKey, { amount: event.target.value === '' ? 0 : Number(event.target.value) })} required /></label></div>
              <label>{c('items')}<input value={row.items ?? ''} maxLength={500} onChange={(event) => editRow(row.rowKey, { items: event.target.value || null })} /></label>
              <label>{c('type')}<select value={row.type} onChange={(event) => editRow(row.rowKey, { type: event.target.value as 'credit' | 'payment' })}><option value="credit">{c('credit')}</option><option value="payment">{c('payment')}</option></select></label>
              <details className="raw-text-details"><summary>{c('rawText')}</summary><p>{row.raw_text}</p></details>
            </article>;
          })}
        </section>
      </div>
      {saveError && <p role="alert" className="error-message">{saveError}</p>}
      <div className="sticky-save-bar"><button type="button" className="secondary-button" onClick={clearCurrent} disabled={saving}>{c('cancel')}</button><button type="button" className="primary-button" onClick={() => void saveReviewedRows()} disabled={saving || rows.length === 0 || payload.demo}>{saving ? baseT(lang, 'loading') : tr(lang, 'saveEntriesCount', { count: rows.length })}</button></div>
    </>}
  </main>;
}

export function CustomerListPage({ snapshot, refresh }: { snapshot: Snapshot; refresh: () => Promise<unknown> }) {
  const shop = snapshot.shop!;
  const lang = shop.preferred_language;
  const c = (key: Phase3Key, values?: Record<string, string | number>) => tr(lang, key, values);
  const [query, setQuery] = useState('');
  const [sortMode, setSortMode] = useState<'due' | 'recent'>('due');
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const customers = useMemo(() => snapshot.customers.map((customer) => {
    const entries = snapshot.entries.filter((entry) => entry.customer_id === customer.id);
    const balance = customerBalance(customer.id, snapshot.entries);
    const latest = entries.reduce((value, entry) => entry.date > value ? entry.date : value, '');
    return { customer, balance, latest };
  }).filter(({ customer }) => normalizeCustomerName(`${customer.name} ${customer.phone ?? ''} ${customer.notes ?? ''}`).includes(normalizeCustomerName(query)))
    .sort((a, b) => sortMode === 'due' ? b.balance - a.balance : b.latest.localeCompare(a.latest)), [snapshot.customers, snapshot.entries, query, sortMode]);

  const addCustomer = async (event: FormEvent) => {
    event.preventDefault(); setError(''); setNotice('');
    if (!name.trim()) { setError(c('missingName')); return; }
    if (snapshot.customers.some((customer) => normalizeCustomerName(customer.name) === normalizeCustomerName(name))) {
      setError(c('confirmMatch')); return;
    }
    const newCustomer: CustomerRecord = { id: makeId(), name: name.trim(), phone: phone.trim() || null, notes: notes.trim() || null, created_at: new Date().toISOString(), is_sample: false };
    await db.customers.add(newCustomer);
    await refresh(); setName(''); setPhone(''); setNotes(''); setAdding(false); setNotice(c('customerCreated'));
  };

  return <main className="screen-content phase3-screen"><section className="page-heading"><div><p className="eyebrow">02 / UDHAR</p><h1>{baseT(lang, 'customers')}</h1><p className="muted">{snapshot.customers.length} · {baseT(lang, 'customers')}</p></div><button className="primary-button" onClick={() => setAdding((v) => !v)}>{adding ? c('cancel') : `+ ${c('addCustomer')}`}</button></section>
    <label className="search-field"><span>{c('customerSearch')}</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={c('customerSearch')} type="search" /></label>
    <label className="sort-field"><span>{c('sortBy')}</span><select value={sortMode} onChange={(event) => setSortMode(event.target.value as 'due' | 'recent')}><option value="due">{c('highestDue')}</option><option value="recent">{c('mostRecent')}</option></select></label>
    {adding && <form className="customer-add-form" onSubmit={(event) => void addCustomer(event)}><h2>{c('newCustomer')}</h2><label>{c('customerName')}<input value={name} onChange={(event) => setName(event.target.value)} required maxLength={160} /></label><label>{c('phone')}<input value={phone} onChange={(event) => setPhone(event.target.value)} inputMode="tel" type="tel" maxLength={30} /></label><label>{c('notes')}<textarea value={notes} onChange={(event) => setNotes(event.target.value)} rows={2} maxLength={1000} /></label><button className="primary-button" type="submit">{c('createCustomer')}</button></form>}
    {error && <p role="alert" className="error-message">{error}</p>}{notice && <p role="status" className="success-message">{notice}</p>}
    {customers.length === 0 ? <div className="empty-ledger"><p>{c('noMatches')}</p><NavLink className="secondary-button button-link" to="/scan">{baseT(lang, 'scan')}</NavLink></div> : <div className="ledger-list customer-ledger-list">{customers.map(({ customer, balance, latest }, index) => <Link className="ledger-row customer-link-row" to={`/customers/${encodeURIComponent(customer.id)}`} key={customer.id}><span className="row-index">{String(index + 1).padStart(2, '0')}</span><span className="row-main"><strong>{customer.name}</strong><span>{customer.phone || baseT(lang, 'noPhone')}{latest ? ` · ${new Date(`${latest}T00:00:00`).toLocaleDateString(uiLocale(lang))}` : ''}{customer.is_sample ? ` · ${baseT(lang, 'sampleLabel')}` : ''}</span></span>{balance <= 0 ? <span className="paid-stamp">{baseT(lang, 'paid')}</span> : <strong className="amount-due">{formatRupees(balance)}</strong>}<span className="customer-chevron" aria-hidden="true">↗</span></Link>)}</div>}
  </main>;
}

export function CustomerDetailPage({ snapshot, refresh }: { snapshot: Snapshot; refresh: () => Promise<unknown> }) {
  const { customerId = '' } = useParams();
  const navigate = useNavigate();
  const shop = snapshot.shop!;
  const lang = shop.preferred_language;
  const c = (key: Phase3Key, values?: Record<string, string | number>) => tr(lang, key, values);
  const customer = snapshot.customers.find((item) => item.id === customerId);
  const [name, setName] = useState(customer?.name ?? '');
  const [phone, setPhone] = useState(customer?.phone ?? '');
  const [notes, setNotes] = useState(customer?.notes ?? '');
  const [date, setDate] = useState(todayISO());
  const [items, setItems] = useState('');
  const [amount, setAmount] = useState('');
  const [type, setType] = useState<'credit' | 'payment'>('credit');
  const [entryError, setEntryError] = useState('');
  const [notice, setNotice] = useState('');
  const [reminderLanguage, setReminderLanguage] = useState<ReminderLanguage>(shop.reminder_language);
  const [tone, setTone] = useState<'gentle' | 'normal'>('gentle');
  const [drafting, setDrafting] = useState(false);
  const [message, setMessage] = useState('');
  const [reminderNote, setReminderNote] = useState('');
  const [detailError, setDetailError] = useState('');
  useEffect(() => { setName(customer?.name ?? ''); setPhone(customer?.phone ?? ''); setNotes(customer?.notes ?? ''); }, [customer?.id, customer?.name, customer?.phone, customer?.notes]);

  const entries = useMemo(() => snapshot.entries.filter((entry) => entry.customer_id === customerId).sort((a, b) => a.date.localeCompare(b.date) || a.created_at.localeCompare(b.created_at)), [snapshot.entries, customerId]);
  const balance = customer ? customerBalance(customer.id, snapshot.entries) : 0;
  const latestEntryDate = entries.length ? entries.reduce((v, entry) => entry.date > v ? entry.date : v, '') : undefined;
  const withRunningBalance = useMemo(() => {
    let running = 0;
    return entries.map((entry) => {
      running += entry.type === 'credit' ? entry.amount : -entry.amount;
      return { entry, running };
    });
  }, [entries]);

  if (!customer) return <Navigate to="/customers" replace />;

  const saveDetails = async (event: FormEvent) => {
    event.preventDefault(); setDetailError(''); setNotice('');
    if (!name.trim()) { setDetailError(c('missingName')); return; }
    await db.customers.update(customer.id, { name: name.trim(), phone: phone.trim() || null, notes: notes.trim() || null });
    await refresh(); setNotice(c('detailSaved'));
  };

  const recordEntry = async (event: FormEvent) => {
    event.preventDefault(); setEntryError(''); setNotice('');
    const rupees = Number(amount);
    if (!date) { setEntryError(c('missingDate')); return; }
    if (!Number.isSafeInteger(rupees) || rupees <= 0) { setEntryError(c('invalidAmount')); return; }
    const row: EntryRecord = { id: makeId(), customer_id: customer.id, date, items: items.trim() || null, amount: rupees, type, source: 'manual', confidence: null, raw_text: null, created_at: new Date().toISOString(), is_sample: false };
    await db.entries.add(row);
    await refresh(); setItems(''); setAmount(''); setDate(todayISO()); setType('credit'); setNotice(c('entryCreated'));
  };

  const draft = async () => {
    setDrafting(true); setReminderNote(''); setDetailError('');
    let usedLocal = !navigator.onLine;
    let drafted = '';
    if (!usedLocal) {
      try {
        const response = await fetch('/api/reminder', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, cache: 'no-store',
          body: JSON.stringify({ shop_name: shop.name, customer_name: customer.name, amount_due: Math.max(0, balance), language: reminderLanguage, tone, last_entry_date: latestEntryDate || null }),
        });
        const result = await response.json().catch(() => ({} as Record<string, unknown>)) as { message?: string; detail?: string };
        if (!response.ok || !result.message) throw new Error(result.detail || 'Reminder service unavailable');
        drafted = result.message;
      } catch {
        usedLocal = true;
      }
    }
    if (usedLocal) {
      drafted = localReminder(shop.name, customer.name, Math.max(0, balance), reminderLanguage);
      setReminderNote(c('reminderOffline'));
    }
    setMessage(drafted); setDrafting(false);
  };
  const whatsappUrl = `https://wa.me/${(customer.phone ?? '').replace(/[^\d]/g, '')}?text=${encodeURIComponent(message)}`;
  const copyMessage = async () => {
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(message);
      else {
        const area = document.getElementById('reminder-message') as HTMLTextAreaElement | null;
        if (!area) throw new Error('no-textarea');
        area.focus(); area.select();
        if (!document.execCommand('copy')) throw new Error('copy-failed');
      }
      setReminderNote(c('copied'));
    } catch { setReminderNote(c('reminderFailed')); }
  };

  return <main className="screen-content phase3-screen customer-detail-screen">
    <p className="back-link"><Link to="/customers">← {baseT(lang, 'customers')}</Link></p>
    <section className="page-heading"><div><p className="eyebrow">02 / UDHAR</p><h1>{customer.name}</h1><p className="muted">{customer.phone || baseT(lang, 'noPhone')}</p></div><span className="paper-stamp">{customer.is_sample ? baseT(lang, 'sampleLabel') : baseT(lang, 'localOnly')}</span></section>
    <section className="customer-balance-banner"><span>{baseT(lang, 'outstanding')}</span><strong className={balance > 0 ? 'amount-due' : ''}>{formatRupees(balance)}</strong><small>{balance > 0 ? baseT(lang, 'owing') : baseT(lang, 'paid')}</small></section>
    <form className="settings-section detail-edit-form" onSubmit={(event) => void saveDetails(event)}><div className="settings-title"><div><h2>{c('editCustomer')}</h2><p>{baseT(lang, 'privacy')} · {baseT(lang, 'localOnly')}</p></div></div><label>{c('customerName')}<input value={name} onChange={(event) => setName(event.target.value)} required maxLength={160} /></label><label>{c('phone')}<input value={phone} onChange={(event) => setPhone(event.target.value)} type="tel" inputMode="tel" maxLength={30} /></label><label>{c('notes')}<textarea value={notes} onChange={(event) => setNotes(event.target.value)} rows={2} maxLength={1000} /></label><button className="secondary-button" type="submit">{c('saveDetails')}</button></form>
    <section className="ledger-section"><div className="section-heading"><div><p className="eyebrow">03 / LEDGER</p><h2>{c('ledgerHistory')}</h2></div></div>
      {withRunningBalance.length === 0 && <p className="empty-ledger">{c('noHistory')}</p>}
      {withRunningBalance.length > 0 && <div className="running-ledger-table"><div className="running-ledger-head"><span>{c('date')}</span><span>{c('items')}</span><span>{c('amount')}</span><span>{c('runningBalance')}</span></div>{withRunningBalance.map(({ entry, running }) => <div className="running-ledger-row" key={entry.id}><time dateTime={entry.date}>{new Date(`${entry.date}T00:00:00`).toLocaleDateString(uiLocale(lang), { day: '2-digit', month: 'short', year: 'numeric' })}</time><span className="entry-description">{entry.items || '—'}{entry.is_sample && <small>{baseT(lang, 'sampleLabel')}</small>}</span><strong className={entry.type === 'payment' ? 'payment-amount' : 'amount-due'}>{entry.type === 'payment' ? '−' : ''}{formatRupees(entry.amount)}</strong><strong>{formatRupees(running)}</strong></div>)}</div>}
    </section>
    <section className="settings-section manual-entry-section"><div className="settings-title"><div><h2>{c('addManualEntry')}</h2><p>{baseT(lang, 'localOnly')}</p></div></div><form className="manual-entry-form" onSubmit={(event) => void recordEntry(event)}><label>{c('date')}<input type="date" value={date} onChange={(event) => setDate(event.target.value)} required /></label><label>{c('items')}<input value={items} onChange={(event) => setItems(event.target.value)} placeholder={c('entryItemsPlaceholder')} maxLength={500} /></label><label>{c('amount')}<input id="entry-amount" type="number" min="1" step="1" value={amount} onChange={(event) => setAmount(event.target.value)} placeholder={c('amountPlaceholder')} required /></label><label>{c('type')}<select value={type} onChange={(event) => setType(event.target.value as 'credit' | 'payment')}><option value="credit">{c('credit')}</option><option value="payment">{c('payment')}</option></select></label><div className="quick-payments"><span>{c('recordPayment')}:</span><button className="text-button compact" type="button" disabled={balance <= 0} onClick={() => { setType('payment'); setAmount(String(Math.round(balance))); }}>{c('fullBalance')} ({formatRupees(Math.max(0, balance))})</button><button className="text-button compact" type="button" disabled={balance <= 0} onClick={() => { setType('payment'); setAmount(String(Math.max(1, Math.round(balance / 2)))); }}>{c('halfBalance')}</button><button className="text-button compact" type="button" onClick={() => { setType('payment'); setAmount(''); document.getElementById('entry-amount')?.focus(); }}>{c('customAmount')}</button></div>{entryError && <p role="alert" className="error-message">{entryError}</p>}<button className="primary-button" type="submit">{c('saveEntry')}</button></form></section>
    <section className="settings-section reminder-section"><div className="settings-title"><div><h2>{c('reminderTitle')}</h2><p>{balance > 0 ? `${formatRupees(balance)} · ${customer.phone || baseT(lang, 'noPhone')}` : c('noDue')}</p></div></div><label>{c('reminderLanguage')}<select value={reminderLanguage} onChange={(event) => setReminderLanguage(event.target.value as ReminderLanguage)}><option value="english">English</option><option value="hindi">हिन्दी</option><option value="marathi">मराठी</option><option value="hinglish">Hinglish</option></select></label><label>{c('tone')}<select value={tone} onChange={(event) => setTone(event.target.value as 'gentle' | 'normal')}><option value="gentle">{c('gentle')}</option><option value="normal">{c('normal')}</option></select></label><button className="primary-button" type="button" onClick={() => void draft()} disabled={balance <= 0 || drafting}>{drafting ? c('draftingReminder') : c('draftReminder')}</button>{message && <><label>{c('messagePreview')}<textarea id="reminder-message" value={message} onChange={(event) => setMessage(event.target.value)} rows={5} maxLength={1200} /></label><div className="action-row"><a className="secondary-button button-link" href={whatsappUrl} target="_blank" rel="noopener noreferrer" onClick={(event) => { if (!message.trim()) event.preventDefault(); }}>{c('openWhatsApp')}</a><button className="secondary-button" type="button" onClick={() => void copyMessage()}>{c('copyMessage')}</button></div></>}{reminderNote && <p role="status" className="success-message">{reminderNote}</p>}</section>
    {notice && <p role="status" className="success-message">{notice}</p>}{detailError && <p role="alert" className="error-message">{detailError}</p>}
  </main>;
}
