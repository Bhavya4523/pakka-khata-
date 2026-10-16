import type { CustomerRecord, EntryRecord, ReminderLanguage, ShopRecord, UiLanguage } from './db';

const KDF_ITERATIONS = 310_000;
const BACKUP_VERSION = 1;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

type BackupShop = Pick<ShopRecord, 'name' | 'preferred_language' | 'reminder_language'>;
export interface BackupPayload {
  format: 'pakka-khata-backup';
  version: 1;
  created_at: string;
  shop: BackupShop;
  customers: CustomerRecord[];
  entries: EntryRecord[];
}
interface EncryptedEnvelope {
  format: 'pakka-khata-encrypted-backup';
  version: 1;
  kdf: 'PBKDF2-SHA256';
  iterations: number;
  salt: string;
  iv: string;
  ciphertext: string;
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const block = 0x8000;
  for (let i = 0; i < bytes.length; i += block) {
    binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + block, bytes.length)));
  }
  return btoa(binary);
}
function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
function randomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}
async function deriveAesKey(passphrase: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey('raw', encoder.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export function nextPinLockout(previousAttempts: number): { attempts: number; durationMs: number } {
  const attempts = Math.max(0, Math.floor(previousAttempts)) + 1;
  if (attempts % 5 !== 0) return { attempts, durationMs: 0 };
  const groupsAfterFirst = Math.floor((attempts - 5) / 5);
  return { attempts, durationMs: Math.min(30_000 * 2 ** groupsAfterFirst, 5 * 60_000) };
}

export function planBackupMerge(
  existingCustomers: CustomerRecord[],
  existingEntries: EntryRecord[],
  incomingCustomers: CustomerRecord[],
  incomingEntries: EntryRecord[],
): { customersToAdd: CustomerRecord[]; entriesToAdd: EntryRecord[] } {
  const customerIds = new Set(existingCustomers.map((customer) => customer.id));
  const customersToAdd = incomingCustomers.filter((customer) => !customerIds.has(customer.id));
  for (const customer of customersToAdd) customerIds.add(customer.id);
  const entryIds = new Set(existingEntries.map((entry) => entry.id));
  const entriesToAdd = incomingEntries.filter((entry) => !entryIds.has(entry.id) && customerIds.has(entry.customer_id));
  return { customersToAdd, entriesToAdd };
}

export async function hashPin(pin: string, saltBase64?: string): Promise<{ hash: string; salt: string }> {
  const salt = saltBase64 ? fromBase64(saltBase64) : randomBytes(16);
  const material = await crypto.subtle.importKey('raw', encoder.encode(pin), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: KDF_ITERATIONS },
    material,
    256,
  );
  return { hash: toBase64(new Uint8Array(bits)), salt: toBase64(salt) };
}
export async function verifyPin(pin: string, expectedHash: string, salt: string): Promise<boolean> {
  const actual = await hashPin(pin, salt);
  const a = fromBase64(actual.hash);
  const b = fromBase64(expectedHash);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}

export function buildBackupPayload(
  shop: ShopRecord,
  customers: CustomerRecord[],
  entries: EntryRecord[],
): BackupPayload {
  return {
    format: 'pakka-khata-backup',
    version: BACKUP_VERSION,
    created_at: new Date().toISOString(),
    // The backup never exports the App Lock PIN hash or salt.
    shop: {
      name: shop.name,
      preferred_language: shop.preferred_language,
      reminder_language: shop.reminder_language,
    },
    customers,
    entries,
  };
}

export async function encryptBackup(payload: BackupPayload, passphrase: string): Promise<Blob> {
  if (passphrase.length < 8) throw new Error('Use a backup passphrase with at least 8 characters.');
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = await deriveAesKey(passphrase, salt, KDF_ITERATIONS);
  const cleartext = encoder.encode(JSON.stringify(payload));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, cleartext);
  const envelope: EncryptedEnvelope = {
    format: 'pakka-khata-encrypted-backup',
    version: BACKUP_VERSION,
    kdf: 'PBKDF2-SHA256',
    iterations: KDF_ITERATIONS,
    salt: toBase64(salt),
    iv: toBase64(iv),
    ciphertext: toBase64(new Uint8Array(encrypted)),
  };
  return new Blob([JSON.stringify(envelope)], { type: 'application/vnd.pakka-khata.backup+json' });
}

export async function decryptBackup(text: string, passphrase: string): Promise<BackupPayload> {
  let envelope: EncryptedEnvelope;
  try {
    envelope = JSON.parse(text) as EncryptedEnvelope;
  } catch {
    throw new Error('This file is not a readable Pakka Khata backup.');
  }
  if (envelope.format !== 'pakka-khata-encrypted-backup' || envelope.version !== BACKUP_VERSION || envelope.kdf !== 'PBKDF2-SHA256') {
    throw new Error('This backup format is not supported by this version of Pakka Khata.');
  }
  if (!Number.isInteger(envelope.iterations) || envelope.iterations < 100_000 || envelope.iterations > 1_000_000) {
    throw new Error('The backup security settings are not valid.');
  }
  let plaintext: ArrayBuffer;
  try {
    const key = await deriveAesKey(passphrase, fromBase64(envelope.salt), envelope.iterations);
    plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromBase64(envelope.iv) },
      key,
      fromBase64(envelope.ciphertext),
    );
  } catch {
    throw new Error('That passphrase did not unlock this backup, or the file is damaged. Please check it and try again.');
  }
  let payload: unknown;
  try {
    payload = JSON.parse(decoder.decode(plaintext));
  } catch {
    throw new Error('The unlocked backup contents could not be read.');
  }
  if (!isBackupPayload(payload)) throw new Error('The backup contents are incomplete or invalid. Your existing khata has not been changed.');
  return payload;
}

function isBackupPayload(value: unknown): value is BackupPayload {
  if (!value || typeof value !== 'object') return false;
  const x = value as Partial<BackupPayload>;
  if (x.format !== 'pakka-khata-backup' || x.version !== 1) return false;
  if (typeof x.created_at !== 'string' || Number.isNaN(Date.parse(x.created_at))) return false;
  if (!x.shop || typeof x.shop.name !== 'string' || !x.shop.name.trim() || !['en', 'hi', 'mr'].includes(x.shop.preferred_language)) return false;
  if (!['english', 'hindi', 'marathi', 'hinglish'].includes(x.shop.reminder_language)) return false;
  if (!Array.isArray(x.customers) || !Array.isArray(x.entries)) return false;
  const customerIds = new Set<string>();
  for (const customer of x.customers) {
    if (!customer || typeof customer.id !== 'string' || !customer.id || typeof customer.name !== 'string' || !customer.name.trim()) return false;
    if (customerIds.has(customer.id)) return false;
    if (customer.phone !== null && typeof customer.phone !== 'string') return false;
    if (customer.notes !== null && typeof customer.notes !== 'string') return false;
    if (typeof customer.created_at !== 'string' || Number.isNaN(Date.parse(customer.created_at))) return false;
    if (typeof customer.is_sample !== 'boolean') return false;
    customerIds.add(customer.id);
  }
  const entryIds = new Set<string>();
  for (const entry of x.entries) {
    if (!entry || typeof entry.id !== 'string' || !entry.id || !customerIds.has(entry.customer_id)) return false;
    if (entryIds.has(entry.id)) return false;
    if (!Number.isSafeInteger(entry.amount) || entry.amount <= 0) return false;
    if (!['credit', 'payment'].includes(entry.type)) return false;
    if (!['scan', 'manual', 'sample'].includes(entry.source)) return false;
    if (entry.items !== null && typeof entry.items !== 'string') return false;
    if (entry.confidence !== null && (typeof entry.confidence !== 'number' || entry.confidence < 0 || entry.confidence > 1)) return false;
    if (typeof entry.date !== 'string' || Number.isNaN(Date.parse(entry.date))) return false;
    if (typeof entry.created_at !== 'string' || Number.isNaN(Date.parse(entry.created_at))) return false;
    if (typeof entry.is_sample !== 'boolean') return false;
    if (entry.raw_text !== null && typeof entry.raw_text !== 'string') return false;
    entryIds.add(entry.id);
  }
  return true;
}

function csvCell(input: unknown): string {
  let value = String(input ?? '');
  if (/^[=+\-@\t\r]/.test(value)) value = `'${value}`; // prevent spreadsheet formula injection
  return `"${value.replace(/"/g, '""')}"`;
}
export function makeLedgerCsv(customers: CustomerRecord[], entries: EntryRecord[]): string {
  const customerNames = new Map(customers.map((customer) => [customer.id, customer.name]));
  const rows = [
    ['Customer', 'Date', 'Items', 'Amount (INR)', 'Type', 'Source', 'Confidence'],
    ...entries.map((entry) => [
      customerNames.get(entry.customer_id) ?? 'Unknown customer',
      entry.date,
      entry.items ?? '',
      entry.amount,
      entry.type,
      entry.source,
      entry.confidence ?? '',
    ]),
  ];
  return `\uFEFF${rows.map((row) => row.map(csvCell).join(',')).join('\r\n')}`;
}

export function reminderLanguageForUi(language: UiLanguage): ReminderLanguage {
  if (language === 'hi') return 'hindi';
  if (language === 'mr') return 'marathi';
  return 'english';
}
