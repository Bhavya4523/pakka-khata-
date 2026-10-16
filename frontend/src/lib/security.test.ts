import { describe, expect, it } from 'vitest';
import { buildBackupPayload, decryptBackup, encryptBackup, hashPin, makeLedgerCsv, nextPinLockout, planBackupMerge, verifyPin } from './security';
import type { CustomerRecord, EntryRecord, ShopRecord } from './db';

const shop: ShopRecord = {
  id: 'primary', name: 'Test Kirana', preferred_language: 'en', reminder_language: 'english',
  created_at: '2026-10-01T00:00:00.000Z', last_backup_at: null, last_backup_entry_count: 0,
  pin_hash: 'must-not-be-exported', pin_salt: 'must-not-be-exported', storage_persisted: true,
  backup_prompt_dismissed_until: null,
};
const customer: CustomerRecord = { id: 'customer-1', name: 'Ramesh', phone: null, notes: null, created_at: '2026-10-01T00:00:00.000Z', is_sample: true };
const entry: EntryRecord = { id: 'entry-1', customer_id: 'customer-1', date: '2026-10-01', items: 'Atta', amount: 250, type: 'credit', source: 'sample', confidence: 1, raw_text: null, created_at: '2026-10-01T00:00:00.000Z', is_sample: true };

describe('local security helpers', () => {
  it('hashes and verifies an App Lock PIN without storing the PIN itself', async () => {
    const stored = await hashPin('1234');
    expect(stored.hash).not.toBe('1234');
    expect(await verifyPin('1234', stored.hash, stored.salt)).toBe(true);
    expect(await verifyPin('4321', stored.hash, stored.salt)).toBe(false);
  });
  it('encrypts and decrypts an encrypted backup and excludes the PIN hash', async () => {
    const payload = buildBackupPayload(shop, [customer], [entry]);
    expect(JSON.stringify(payload)).not.toContain('must-not-be-exported');
    const blob = await encryptBackup(payload, 'correct horse battery');
    const restored = await decryptBackup(await blob.text(), 'correct horse battery');
    expect(restored.entries[0].amount).toBe(250);
    expect(restored.shop.name).toBe('Test Kirana');
  });
  it('rejects a wrong backup passphrase', async () => {
    const blob = await encryptBackup(buildBackupPayload(shop, [customer], [entry]), 'correct horse battery');
    await expect(decryptBackup(await blob.text(), 'wrong passphrase')).rejects.toThrow(/passphrase|damaged/i);
  });
  it('uses increasing App Lock delays after each group of five failed attempts', () => {
    expect(nextPinLockout(4)).toEqual({ attempts: 5, durationMs: 30_000 });
    expect(nextPinLockout(9)).toEqual({ attempts: 10, durationMs: 60_000 });
    expect(nextPinLockout(14)).toEqual({ attempts: 15, durationMs: 120_000 });
  });
  it('merges by stable IDs without duplicating customers or entries', () => {
    const { customersToAdd, entriesToAdd } = planBackupMerge([customer], [entry], [customer, { ...customer, id: 'customer-2', name: 'Asha' }], [entry, { ...entry, id: 'entry-2', customer_id: 'customer-2' }]);
    expect(customersToAdd.map((item) => item.id)).toEqual(['customer-2']);
    expect(entriesToAdd.map((item) => item.id)).toEqual(['entry-2']);
  });
  it('exports readable CSV while escaping formula-like cells', () => {
    const csv = makeLedgerCsv([{ ...customer, name: '=HYPERLINK("bad")' }], [entry]);
    expect(csv).toContain('"Customer","Date"');
    expect(csv).toContain("'=HYPERLINK(");
    expect(csv.charCodeAt(0)).toBe(0xFEFF);
  });
});
