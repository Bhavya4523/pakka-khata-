import type { CustomerRecord } from './db';

export function normalizeCustomerName(value: string): string {
  return value.normalize('NFC').toLocaleLowerCase().replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\s+/g, ' ').trim();
}

export function editDistance(a: string, b: string): number {
  const left = Array.from(normalizeCustomerName(a));
  const right = Array.from(normalizeCustomerName(b));
  if (left.length > right.length) return editDistance(b, a);
  let previous = Array.from({ length: left.length + 1 }, (_, i) => i);
  for (let j = 1; j <= right.length; j += 1) {
    const current = [j];
    for (let i = 1; i <= left.length; i += 1) {
      current[i] = Math.min(
        current[i - 1] + 1,
        previous[i] + 1,
        previous[i - 1] + (left[i - 1] === right[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[left.length];
}

export function suggestCustomers(name: string, customers: CustomerRecord[], limit = 3): CustomerRecord[] {
  const normalized = normalizeCustomerName(name);
  if (!normalized) return [];
  return customers
    .map((customer) => {
      const candidate = normalizeCustomerName(customer.name);
      const distance = editDistance(normalized, candidate);
      const threshold = normalized === candidate ? 0 : Math.max(1, Math.floor(Math.min(normalized.length, candidate.length) * 0.18));
      return { customer, distance, threshold, candidate };
    })
    .filter(({ distance, threshold, candidate }) => candidate && distance <= threshold)
    .sort((a, b) => a.distance - b.distance || a.customer.name.localeCompare(b.customer.name))
    .slice(0, limit)
    .map(({ customer }) => customer);
}
