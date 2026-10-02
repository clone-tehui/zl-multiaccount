import assert from 'node:assert/strict';
import test from 'node:test';
import { quarantineAccountOverlap } from '../scripts/quarantine-account-overlap.mjs';

test('Recovery quarantines uncertain overlap without modifying source or unique history', () => {
  const buckets = Object.fromEntries(['A', 'B'].map((accountId) => [accountId, {
    threads: { shared: { id: 'shared' }, [accountId]: { id: accountId } },
    messages: { shared: [{ text: 'uncertain' }], [accountId]: [{ text: `unique-${accountId}` }] },
    contacts: { shared: {}, [accountId]: {} },
    labels: { items: ['legacy'] }, zalo: { aliases: ['legacy'] }, session: { account: { id: accountId } }
  }]));
  const input = { activeAccountId: 'B', accountStateById: buckets };
  const original = structuredClone(input);
  const { state, manifest } = quarantineAccountOverlap(input, 'A');
  assert.deepEqual(input, original);
  assert.equal(manifest.accounts.length, 1);
  assert.deepEqual(Object.keys(state.threads), ['B']);
  assert.deepEqual(state.messages.B, [{ text: 'unique-B' }]);
  assert.deepEqual(state.accountStateById.A, original.accountStateById.A);
  assert.deepEqual(state.zalo, {});
  assert.deepEqual(state.labels.items, []);
});
