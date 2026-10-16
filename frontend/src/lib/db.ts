import Dexie, { type Table } from 'dexie';

export type UiLanguage = 'en' | 'hi' | 'mr';
export type ReminderLanguage = 'english' | 'hindi' | 'marathi' | 'hinglish';
export type EntryType = 'credit' | 'payment';
export type EntrySource = 'scan' | 'manual' | 'sample';

export interface ShopRecord {
  id: 'primary';
  name: string;
  preferred_language: UiLanguage;
  reminder_language: ReminderLanguage;
  created_at: string;
  last_backup_at: string | null;
  last_backup_entry_count: number;
  pin_hash: string | null;
  pin_salt: string | null;
  storage_persisted: boolean | null;
  backup_prompt_dismissed_until: string | null;
}

export interface CustomerRecord {
  id: string;
  name: string;
  phone: string | null;
  notes: string | null;
  created_at: string;
  is_sample: boolean;
}

export interface EntryRecord {
  id: string;
  customer_id: string;
  date: string;
  items: string | null;
  amount: number; // Integer rupees, never paise or floating-point currency.
  type: EntryType;
  source: EntrySource;
  confidence: number | null;
  raw_text: string | null;
  created_at: string;
  is_sample: boolean;
}

class PakkaKhataDB extends Dexie {
  shop!: Table<ShopRecord, string>;
  customers!: Table<CustomerRecord, string>;
  entries!: Table<EntryRecord, string>;

  constructor() {
    super('pakka-khata-local');
    this.version(1).stores({
      shop: 'id',
      customers: 'id, name, phone',
      entries: 'id, customer_id, date, type, source',
    });
  }
}

export const db = new PakkaKhataDB();

export function makeId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

export async function getShop(): Promise<ShopRecord | undefined> {
  return db.shop.get('primary');
}

export async function saveShop(shop: ShopRecord): Promise<void> {
  await db.shop.put(shop);
}

export async function getSnapshot() {
  const [shop, customers, entries] = await Promise.all([
    db.shop.get('primary'),
    db.customers.toArray(),
    db.entries.toArray(),
  ]);
  return { shop, customers, entries };
}

export async function clearLocalData(): Promise<void> {
  await db.transaction('rw', db.shop, db.customers, db.entries, async () => {
    await db.entries.clear();
    await db.customers.clear();
    await db.shop.clear();
  });
}

export function customerBalance(customerId: string, entries: EntryRecord[]): number {
  return entries.reduce((total, entry) => {
    if (entry.customer_id !== customerId) return total;
    return total + (entry.type === 'credit' ? entry.amount : -entry.amount);
  }, 0);
}

export function totalOutstanding(entries: EntryRecord[]): number {
  return entries.reduce((total, entry) => total + (entry.type === 'credit' ? entry.amount : -entry.amount), 0);
}

export function formatRupees(amount: number): string {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 0,
  }).format(amount);
}
