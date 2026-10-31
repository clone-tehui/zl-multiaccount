import test from 'node:test';
import assert from 'node:assert/strict';
import { BinBankCard } from 'zca-js';
import { executeLatestZaloFeature as execute, LATEST_ZALO_FEATURES } from '../src/services/zalo-latest-features.js';
import { ZaloWebProvider, mergeSyncedGroupHistory } from '../src/providers/zalo-web-provider.js';

test('latest SDK dispatch validates payloads, strips device secrets and awaits failures', async () => {
  assert.equal(LATEST_ZALO_FEATURES.length, 9);
  await assert.rejects(execute({}, 'constructor'));
  await assert.rejects(execute(null, 'lostFocus'), /chưa kết nối/);
  const payload = { binBank: Object.values(BinBankCard).find((value) => typeof value === 'number'), numAccBank: '12345678', nameAccBank: 'SYNTHETIC' };
  let received;
  await execute({ createBankAccount: async (value) => { received = value; return {}; } }, 'createBankAccount', payload);
  assert.deepEqual(received, payload);
  await execute({ updateBankAccount: async (value) => { received = value; } }, 'updateBankAccount', { ...payload, accountId: '12' });
  assert.deepEqual(received, { ...payload, accountId: 12 });
  await assert.rejects(execute({ createBankAccount() { throw new Error('should not call'); } }, 'createBankAccount', { ...payload, binBank: 1 }), /chưa.*hỗ trợ/);
  await assert.rejects(execute({ deleteBankAccount() {} }, 'deleteBankAccount', { accountId: 1 }), /mặc định/);
  await execute({ deleteBankAccount: async (value) => { received = value; } }, 'deleteBankAccount', { accountId: 3, isDefault: false });
  assert.deepEqual(received, { accountId: 3, isDefault: false });
  await execute({ getListBankAccount: async (...args) => { received = args; } }, 'getListBankAccount', { page: 2, limit: 20 });
  assert.deepEqual(received, [2, 20]);
  await assert.rejects(execute({ getListBankAccount() {} }, 'getListBankAccount', { limit: 999 }));
  await assert.rejects(execute({ registerCatalog: async () => { throw new Error('upstream failed'); } }, 'registerCatalog', { enabled: true }), /upstream failed/);
  assert.deepEqual(await execute({ scanURL: async () => ({ isSafe: false }) }, 'scanURL', { url: 'https://example.com' }), { isSafe: false });
  await assert.rejects(execute({ scanURL() {} }, 'scanURL', { url: 'https://secret@example.com' }));
  const result = await execute({ getListDevice: async () => ({ devices: { masterId: 'secret-id', encIdentity: 'secret', encSignature: 'secret', companions: [{ name: 'Desktop', encIdentity: 'private' }] } }) }, 'getListDevice');
  assert.equal(result.primaryDevicePresent, true);
  assert.equal(JSON.stringify(result).includes('secret'), false);
  assert.deepEqual(result.companions[0], { name: 'Desktop', type: '', lastUpdatedAt: 0 });
});

test('provider dispatch resolves the current request account instead of a global API', async () => {
  let selected = 'A';
  const provider = Object.create(ZaloWebProvider.prototype);
  provider.store = { read: () => ({ activeAccountId: selected }) };
  provider.getAccountApi = (id) => ({ lostFocus: async () => ({ account: id }) });
  const a = provider.runLatestFeature('lostFocus');
  selected = 'B';
  const b = provider.runLatestFeature('lostFocus');
  assert.deepEqual(await a, { account: 'A' });
  assert.deepEqual(await b, { account: 'B' });
});

test('experimental avatar sizes are opt-in and fall back to the standard size on upstream error', async () => {
  const provider = Object.create(ZaloWebProvider.prototype);
  const sizes = [];
  provider.store = { read: () => ({ activeAccountId: 'A' }) };
  provider.calls = { available: () => false };
  provider.getActiveThreadContext = () => ({ thread: { type: 'direct' }, accountState: { contacts: {} }, api: { getUserInfo: async (id, size) => {
    sizes.push(size);
    if (size === 360) throw new Error('unsupported');
    return { changed_profiles: { peer: { displayName: 'SYNTHETIC' } } };
  } } });
  const large = await provider.getThreadProfile('peer', { avatarSize: 'ExtraLarge' });
  assert.deepEqual(sizes, [360, 240]);
  assert.equal(large.avatarSize, 'Large');
  assert.equal(large.avatarSizeFallback, true);
  await provider.getThreadProfile('peer', { avatarSize: 'Medium' });
  assert.equal(sizes.at(-1), 180);
});

test('a shorter upstream group history preserves saved messages and applies newer versions by ID', () => {
  const createdAt = new Date().toISOString();
  const previous = Array.from({ length: 49 }, (_, index) => ({ id: String(index), createdAt, text: 'saved' }));
  const incoming = previous.slice(-23).map((message) => ({ ...message, text: 'updated' }));
  const merged = mergeSyncedGroupHistory(previous, incoming);
  assert.equal(merged.length, 49);
  assert.equal(merged.find((message) => message.id === '0').text, 'saved');
  assert.equal(merged.find((message) => message.id === '48').text, 'updated');
  assert.equal(mergeSyncedGroupHistory(previous, []).length, 49);
});
