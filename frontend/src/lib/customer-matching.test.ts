import { describe, expect, it } from 'vitest';
import { editDistance, normalizeCustomerName, suggestCustomers } from './customer-matching';
import type { CustomerRecord } from './db';

const record = (id: string, name: string): CustomerRecord => ({ id, name, phone: null, notes: null, created_at: '2026-10-01T00:00:00.000Z', is_sample: false });

describe('customer name matching', () => {
  it('normalizes case and repeated spaces without translating scripts', () => {
    expect(normalizeCustomerName('  RAMESH   Kumar ')).toBe('ramesh kumar');
    expect(normalizeCustomerName('रमेश कुमार')).toBe('रमेश कुमार');
  });
  it('calculates edit distance for typo suggestions', () => {
    expect(editDistance('Ramesh Kumar', 'Ramesh Kumra')).toBe(2);
    expect(suggestCustomers('Ramesh Kumra', [record('1', 'Ramesh Kumar')])).toHaveLength(1);
  });
  it('suggests but never merges customers automatically', () => {
    const customers = [record('1', 'Asha Tai'), record('2', 'Ramesh Kumar')];
    expect(suggestCustomers('Asha Tai', customers)[0].id).toBe('1');
    expect(customers).toHaveLength(2);
  });
});
