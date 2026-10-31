import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LoginQRCallbackEventType } from 'zca-js';
import { QrLoginSession } from '../src/services/qr-login-session.js';
import { ZaloWebProvider } from '../src/providers/zalo-web-provider.js';
import { JsonStore, updateAccountScopedState, switchActiveAccountState } from '../src/lib/store.js';
import { runWithAccount } from '../src/services/request-account-context.js';

function fixture(timeoutMs) {
  const attempts = [];
  const qr = new QrLoginSession(() => ({
    loginQR(options, callback) {
      return new Promise((resolve, reject) => {
        const abort = () => reject(new Error('Aborted'));
        attempts.push({ callback, resolve, reject, abort });
        callback({ type: LoginQRCallbackEventType.QRCodeGenerated, data: { image: 'synthetic-image', code: 'PRIVATE-CODE', token: 'PRIVATE-TOKEN' }, actions: { abort } });
      });
    }
  }), timeoutMs);
  return { qr, attempts };
}

test('QR belongs to its initiator, renews safely, and never exposes provider tokens', async () => {
  const { qr, attempts } = fixture();
  let completed = 0;
  const options = { ownerId: 'admin-A', departmentId: 'dept-A', complete: async () => { completed += 1; } };
  qr.start(options);
  await delay(0);
  assert.equal(qr.read('admin-A').status, 'awaiting_qr_scan');
  assert.equal(qr.read('admin-A').qrImage, 'data:image/png;base64,synthetic-image');
  assert.deepEqual(qr.read('admin-B'), { status: 'idle' });
  assert.equal(JSON.stringify(qr.read('admin-A')).includes('PRIVATE'), false);
  assert.throws(() => qr.start({ ...options, ownerId: 'admin-B' }), { statusCode: 409 });
  qr.start(options);
  await delay(0);
  attempts[0].callback({ type: LoginQRCallbackEventType.QRCodeScanned, data: {}, actions: { abort: attempts[0].abort } });
  assert.equal(qr.read('admin-A').status, 'awaiting_qr_scan');
  attempts[1].resolve({ fake: true });
  await qr.current.task;
  assert.equal(qr.read('admin-A').status, 'connected');
  assert.equal(completed, 1);
});

test('QR expiry and network failure settle in background and allow another attempt', async () => {
  const { qr, attempts } = fixture(15);
  const options = { ownerId: 'admin', departmentId: 'dept', complete: async () => {} };
  qr.start(options);
  await delay(30);
  await qr.current.task;
  assert.equal(qr.read('admin').status, 'qr_expired');
  qr.start(options);
  await delay(0);
  attempts[1].reject(new Error('Cannot get scan result'));
  await qr.current.task;
  assert.equal(qr.read('admin').status, 'login_error');
  assert.equal(qr.read('admin').qrImage, null);
  qr.start(options);
  await delay(0);
  attempts[2].resolve({});
  await qr.current.task;
  assert.equal(qr.read('admin').status, 'connected');
});

test('Provider QR failure does not alter any existing account or its background client', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zl-qr-regression-'));
  try {
    const store = new JsonStore(directory);
    store.update((state) => {
      for (const accountId of ['A', 'B']) {
        state.accounts[accountId] = { id: accountId, status: 'connected' };
        updateAccountScopedState(state, accountId, (bucket) => {
          bucket.session = { account: { id: accountId }, status: 'connected' };
          return bucket;
        });
      }
      switchActiveAccountState(state, 'A');
      return state;
    });
    const provider = new ZaloWebProvider(store, () => {});
    provider.accountClients.set('A', { api: { marker: 'A' } });
    provider.accountClients.set('B', { api: { marker: 'B' } });
    provider.qrLogin.createClient = () => ({ loginQR: async () => { throw new Error('Cannot get scan result'); } });
    const before = JSON.stringify(store.readGlobal());
    runWithAccount('A', () => provider.startQrLogin({ ownerId: 'admin', departmentId: 'dept' }));
    await provider.qrLogin.current.task;
    assert.equal(JSON.stringify(store.readGlobal()), before);
    assert.equal(provider.accountClients.get('A').api.marker, 'A');
    assert.equal(provider.accountClients.get('B').api.marker, 'B');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
