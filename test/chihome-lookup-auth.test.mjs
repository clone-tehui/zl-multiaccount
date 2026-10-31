import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
const envLine = source.split('\n').find((line) => line.startsWith('const chiHomeBookingBridgeSecret ='));
const start = source.indexOf('function getChiHomeLookupPrincipal(req) {');
const end = source.indexOf('\nfunction ', start + 10);
assert.ok(envLine && start >= 0 && end > start);
const authSource = source.slice(start, end);
function lookup(env = {}, compat = null) {
  const context = vm.createContext({ process: { env }, URL,
    getCompatApiPrincipal: () => compat,
    enrichPrincipal: (principal) => principal,
    portalStore: { read: () => ({}) }
  });
  return vm.runInContext(`${envLine}\n${authSource}\ngetChiHomeLookupPrincipal`, context);
}
const request = (headers = {}, url = '/api/chihome/resolve-thread') => ({ headers, url });

test('ChiHome auth fails closed for missing, empty and whitespace-only env', () => {
  for (const env of [{}, { CHIHOME_BOOKING_BRIDGE_SECRET: '' }, { CHIHOME_BOOKING_BRIDGE_SECRET: '   ' }]) {
    const auth = lookup(env);
    for (const headers of [{}, { 'x-chihome-bridge-secret': 'synthetic-denied' }, { 'x-booking-bridge-secret': 'synthetic-denied' }]) assert.equal(auth(request(headers)), null);
    assert.equal(auth(request({}, '/api/chihome/resolve-thread?secret=synthetic-denied')), null);
  }
});
test('ChiHome accepts only configured env through supported header/query paths', () => {
  const auth = lookup({ CHIHOME_BOOKING_BRIDGE_SECRET: '  synthetic-lookup-test  ' });
  for (const req of [request({ 'x-chihome-bridge-secret': 'synthetic-lookup-test' }), request({ 'x-booking-bridge-secret': 'synthetic-lookup-test' }), request({}, '/api/chihome/resolve-thread?secret=synthetic-lookup-test')]) {
    const principal = auth(req);
    assert.equal(principal.id, 'chihome-bridge');
    assert.equal(principal.role, 'admin');
  }
  for (const req of [request(), request({ 'x-chihome-bridge-secret': 'synthetic-wrong' }), request({}, '/api/chihome/resolve-thread?secret=synthetic-wrong')]) assert.equal(auth(req), null);
  assert.match(authSource, /!chiHomeBookingBridgeSecret \|\| !provided \|\| provided !== chiHomeBookingBridgeSecret/);
  assert.doesNotMatch(authSource, /acceptedSecrets|new Set/);
});
test('independent compat authentication retains its existing precedence', () => {
  const principal = { id: 'synthetic-compat', role: 'admin' };
  assert.equal(lookup({}, principal)(request()), principal);
});
