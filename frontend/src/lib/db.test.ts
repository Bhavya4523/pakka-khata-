import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { customerBalance, formatRupees, totalOutstanding, type EntryRecord } from './db';

const entries: EntryRecord[] = [
  { id: '1', customer_id: 'a', date: '2026-10-01', items: 'Opening', amount: 1250, type: 'credit', source: 'manual', confidence: null, raw_text: null, created_at: '', is_sample: false },
  { id: '2', customer_id: 'a', date: '2026-10-02', items: 'Paid', amount: 1000, type: 'payment', source: 'manual', confidence: null, raw_text: null, created_at: '', is_sample: false },
  { id: '3', customer_id: 'b', date: '2026-10-03', items: 'Tea', amount: 230, type: 'credit', source: 'manual', confidence: null, raw_text: null, created_at: '', is_sample: false },
];

describe('ledger math and local storage primitives', () => {
  it('calculates customer and total outstanding balances', () => {
    expect(customerBalance('a', entries)).toBe(250);
    expect(totalOutstanding(entries)).toBe(480);
  });
  it('formats rupees using Indian grouping', () => {
    expect(formatRupees(123456)).toContain('1,23,456');
  });
});
