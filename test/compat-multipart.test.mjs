import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { JsonStore } from '../src/lib/store.js';
import { PortalStore } from '../src/lib/portal-store.js';
import { createPortalSessionToken, PORTAL_COOKIE_NAME } from '../src/auth/session.js';
import { readCompatMultipart, MULTIPART_LIMITS } from '../src/lib/compat-multipart.js';

test('multipart HTTP mock-provider regression; no external Zalo calls', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'compat-regression-'));
  const port = 29000 + Math.floor(Math.random() * 1000);
  new JsonStore(directory).update((state) => { state.accounts = { A: { id: 'A' }, B: { id: 'B' } }; return state; });
  new PortalStore(directory).update((state) => { state.users = [{ id: 'admin', username: 'admin', roles: ['admin'], active: true }]; return state; });
  const secret = 'compat-regression-secret';
  const adminCookie = `${PORTAL_COOKIE_NAME}=${createPortalSessionToken({ id: 'admin', username: 'admin', roles: ['admin'] }, { jwtSecret: secret })}`;
  const child = spawn(process.execPath, ['--import', './test/fixtures/compat-provider-spy.mjs', 'src/server.js'], { env: { ...process.env, DATA_DIR: directory, PROVIDER: 'mock', PORT: String(port), PORTAL_JWT_SECRET: secret, SESSION_SECRET: secret, COMPAT_API_TOKEN: 'synthetic-only', DATABASE_URL: '', OPENROUTER_API_KEY: '', TELEGRAM_ALERT_BOT_TOKEN: '', TELEGRAM_ALERT_CHAT_ID: '' }, stdio: 'ignore' });
  const request = (body, extra = {}) => fetch(`http://127.0.0.1:${port}/api/compat/manager`, { method: 'POST', headers: { authorization: 'Bearer synthetic-only', ...extra }, body });
  const form = (account = 'A') => {
    const body = new FormData();
    body.set('operation', 'send_message'); body.set('conversationId', 'shared'); body.set('credential_id', account); body.set('content', '<p>Hello</p>');
    return body;
  };
  try {
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try { ready = (await fetch(`http://127.0.0.1:${port}/api/health`)).ok; } catch {}
      if (ready) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(ready, 'server starts');
    const fixtures = [['photo.png', 'image/png', Buffer.from([137,80,78,71,0,255])], ['doc.pdf', 'application/pdf', Buffer.from('%PDF-1.7\0binary')], ['file.bin', 'application/octet-stream', Buffer.from([0,255,1,128])]];
    await Promise.all(['A', 'B'].map(async (account) => {
      const body = form(account);
      for (const [name, mime, bytes] of fixtures) body.append('files', new Blob([bytes], { type: mime }), name);
      const response = await request(body);
      assert.equal(response.status, 200);
      const { result } = await response.json();
      assert.equal(result.accountId, account); assert.equal(result.requestedAccount, account); assert.equal(result.threadId, 'shared'); assert.equal(result.text, 'Hello');
      result.files.forEach((file, index) => { assert.equal(file.basename, fixtures[index][0]); assert.equal(file.name, fixtures[index][0]); assert.equal(file.contentType, fixtures[index][1]); assert.equal(file.data, fixtures[index][2].toString('base64')); });
    }));
    assert.deepEqual(fs.readdirSync(path.join(directory, 'tmp-uploads')), []);
    const alias = form(); alias.append('files', new Blob(['alias']), 'alias.bin');
    const aliasResponse = await fetch(`http://127.0.0.1:${port}/get/post`, { method: 'POST', headers: { cookie: adminCookie }, body: alias });
    assert.equal(aliasResponse.status, 200); assert.equal((await aliasResponse.json()).result.files[0].name, 'alias.bin');
    const aliasJson = await fetch(`http://127.0.0.1:${port}/get/post`, { method: 'POST', headers: { cookie: adminCookie, 'content-type': 'application/json' }, body: JSON.stringify({ operation: 'send_message', conversation_id: 'shared', accountId: 'B', content: 'alias JSON' }) });
    assert.equal(aliasJson.status, 200); assert.equal((await aliasJson.json()).result.accountId, 'B');
    const safe = form(); safe.append('files', new Blob(['safe']), '../../unsafe.bin');
    const safeResult = await (await request(safe)).json(); assert.equal(safeResult.result.files[0].basename, 'unsafe.bin');
    const error = form(); error.set('content', 'provider-error'); error.append('files', new Blob(['x']), 'error.bin'); assert.equal((await request(error)).status, 400);
    assert.deepEqual(fs.readdirSync(path.join(directory, 'tmp-uploads')), []);
    assert.equal((await request(form(), { authorization: 'Bearer wrong' })).status, 401);
    assert.equal((await request(form(), { 'x-zalo-account-id': 'B' })).status, 403);
    const conflict = form(); conflict.set('accountId', 'B'); assert.equal((await request(conflict)).status, 403);
    const missing = form(); missing.delete('conversationId'); assert.equal((await request(missing)).status, 400);
    const unknown = form('unknown'); assert.equal((await request(unknown)).status, 403);
    assert.equal((await request('broken', { 'content-type': 'multipart/form-data' })).status, 400);
    assert.equal((await request('--cut\r\nContent-Disposition: form-data; name="files"; filename="x.bin"\r\n\r\nunfinished', { 'content-type': 'multipart/form-data; boundary=cut' })).status, 400);
    const empty = form(); empty.append('files', new Blob([]), 'empty.bin'); assert.equal((await request(empty)).status, 400);
    const fieldLimit = form(); fieldLimit.set('content', 'x'.repeat(MULTIPART_LIMITS.field + 1)); assert.equal((await request(fieldLimit)).status, 413);
    const mixed = form(); mixed.set('base64Attachments', 'AP8BgA=='); mixed.append('files', new Blob(['binary']), 'binary.bin'); assert.equal((await (await request(mixed)).json()).result.files.length, 2);
    const noMime = form(); noMime.append('files', new Blob(['binary']), 'fallback.bin'); assert.equal((await (await request(noMime)).json()).result.files[0].contentType, 'application/octet-stream');
    const duplicate = form(); duplicate.append('credential_id', 'B'); assert.equal((await request(duplicate)).status, 400);
    const huge = form(); huge.append('files', new Blob([Buffer.alloc(MULTIPART_LIMITS.file + 1)]), 'large.bin'); assert.equal((await request(huge)).status, 413);
    const total = form(); for (let index = 0; index < 3; index += 1) total.append('files', new Blob([Buffer.alloc(21 * 1024 * 1024)]), `large-${index}.bin`); assert.equal((await request(total)).status, 413);
    const many = form(); for (let index = 0; index < 11; index += 1) many.append('files', new Blob(['x']), `${index}.bin`); assert.equal((await request(many)).status, 413);
    const legacy = async (fields) => { const response = await request(JSON.stringify({ operation: 'sendMessage', chat_id: 'shared', credentialId: 'A', ...fields }), { 'content-type': 'application/json' }); assert.equal(response.status, 200); return (await response.json()).result; };
    assert.equal((await legacy({ text: 'legacy text' })).text, 'legacy text');
    assert.equal((await legacy({ base64_attachments: 'AP8BgA==' })).files[0].data, 'AP8BgA==');
    const partialFailure = await request(JSON.stringify({ operation: 'send_message', conversationId: 'shared', credential_id: 'A', base64Attachments: `AP8BgA==,${Buffer.alloc(MULTIPART_LIMITS.file + 1).toString('base64')}` }), { 'content-type': 'application/json' });
    assert.equal(partialFailure.status, 400); assert.deepEqual(fs.readdirSync(path.join(directory, 'tmp-uploads')), []);
    const urlServer = http.createServer((req, res) => { res.setHeader('content-type', 'application/pdf'); res.end(fixtures[1][2]); });
    await new Promise((resolve) => urlServer.listen(0, '127.0.0.1', resolve));
    try { assert.equal((await legacy({ attachments_urls: `http://127.0.0.1:${urlServer.address().port}/doc.pdf` })).files[0].data, fixtures[1][2].toString('base64')); } finally { urlServer.close(); }
    assert.deepEqual(fs.readdirSync(path.join(directory, 'tmp-uploads')), []);
  } finally {
    child.kill('SIGTERM'); await new Promise((resolve) => child.once('exit', resolve)); fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('aborted multipart rejects without writing files', async () => {
  const { PassThrough } = await import('node:stream');
  const stream = new PassThrough(); stream.headers = { 'content-type': 'multipart/form-data; boundary=test' };
  const result = readCompatMultipart(stream);
  stream.write('--test\r\nContent-Disposition: form-data; name="files"; filename="x.bin"\r\n\r\npartial');
  stream.emit('aborted');
  await assert.rejects(result, /aborted/);
});
