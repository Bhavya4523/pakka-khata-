import 'fake-indexeddb/auto';
import Dexie, { type Table } from 'dexie';
import { afterEach, describe, expect, it } from 'vitest';

type ClientRecord = { id: string; customer: string; balance: number };
const databases: Dexie[] = [];
function clientDatabase(name: string) {
  const local = new Dexie(name);
  local.version(1).stores({ records: 'id' });
  databases.push(local);
  return local;
}
afterEach(async () => {
  await Promise.all(databases.splice(0).map(async (database) => { await database.delete(); }));
});

describe('Ownership guarantees', () => {
  it('keeps two simulated browser profiles in separate IndexedDB stores', async () => {
    const one = clientDatabase(`pk-test-one-${crypto.randomUUID()}`);
    const two = clientDatabase(`pk-test-two-${crypto.randomUUID()}`);
    const oneRecords = one.table('records') as Table<ClientRecord, string>;
    const twoRecords = two.table('records') as Table<ClientRecord, string>;
    await oneRecords.add({ id: 'c-1', customer: 'Private Shop A', balance: 900 });
    expect(await oneRecords.count()).toBe(1);
    expect(await twoRecords.count()).toBe(0);
    expect(await twoRecords.get('c-1')).toBeUndefined();
  });
});
