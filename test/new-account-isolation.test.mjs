import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { JsonStore, switchActiveAccountState, updateAccountScopedState } from '../src/lib/store.js';
import { runWithAccount } from '../src/services/request-account-context.js';

test('New accounts start empty, stay independent and do not stop older account writes', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'new-account-isolation-'));
  try {
    const store = new JsonStore(directory);
    for (const accountId of ['A', 'B', 'C', 'D']) {
      store.update((state) => {
        state.accounts[accountId] = { id: accountId };
        switchActiveAccountState(state, accountId);
        for (const field of ['contacts', 'threads', 'messages']) assert.deepEqual(state[field], {});
        assert.equal(JSON.stringify(state.zalo).includes('PRIVATE-'), false);
        assert.equal(JSON.stringify(state.labels).includes('PRIVATE-'), false);
        updateAccountScopedState(state, accountId, (bucket) => ({
          ...bucket,
          session: { account: { id: accountId } },
          contacts: { peer: { id: 'peer', displayName: `PRIVATE-${accountId}` } },
          threads: { shared: { id: 'shared', type: 'group', notes: `PRIVATE-${accountId}` } },
          messages: { shared: [{ id: accountId, threadId: 'shared', text: `PRIVATE-${accountId}` }] },
          labels: { items: [`PRIVATE-${accountId}`] },
          zalo: { aliases: [`PRIVATE-${accountId}`] }
        }));
        return state;
      });
    }
    runWithAccount('A', () => store.update((state) => {
      state.messages.shared.push({ id: 'background-A', threadId: 'shared', text: 'BACKGROUND-A' });
      return state;
    }));
    const reopened = new JsonStore(directory).readGlobal();
    assert.equal(reopened.activeAccountId, 'D');
    for (const accountId of ['A', 'B', 'C', 'D']) {
      const bucket = JSON.stringify(reopened.accountStateById[accountId]);
      assert.ok(bucket.includes(`PRIVATE-${accountId}`));
      for (const otherId of ['A', 'B', 'C', 'D'].filter((candidate) => candidate !== accountId)) assert.equal(bucket.includes(`PRIVATE-${otherId}`), false);
      assert.equal(bucket.includes('BACKGROUND-A'), accountId === 'A');
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('A changed active selector cannot seed a new bucket from another session owner', () => {
  const state = {
    activeAccountId: 'NEW', session: { account: { id: 'OLD' } }, accountStateById: {},
    contacts: { foreign: {} }, threads: { foreign: { id: 'foreign' } },
    messages: { foreign: [{ text: 'PRIVATE-OLD' }] }, labels: { items: ['PRIVATE-OLD'] }, zalo: { aliases: ['PRIVATE-OLD'] }
  };
  updateAccountScopedState(state, 'NEW', (bucket) => bucket);
  assert.deepEqual(state.accountStateById.NEW.threads, {});
  assert.equal(JSON.stringify(state.accountStateById.NEW).includes('PRIVATE-OLD'), false);
});
