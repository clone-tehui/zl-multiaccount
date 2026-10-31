import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { VoiceFramePacer } from '../src/services/voice-call-media.js';
import { createCallDiagnostics } from '../src/services/voice-call-diagnostics.js';
import { CallJitterBuffer } from '../public/voice-call-audio.js';

test('Pacer bounds burst, expires stale audio, fills silence and serializes slow UDP sends', async () => {
  let now = 0, release;
  const sent = [];
  const pacer = new VoiceFramePacer(async (frame) => sent.push(frame.toString()), { now: () => now });
  for (let i = 0; i < 9; i++) pacer.push(Buffer.from(String(i)));
  assert.equal(pacer.queue.length, 3);
  assert.equal(pacer.dropped, 6);
  await pacer.tick();
  assert.deepEqual(sent, ['6']);
  now = 100;
  await pacer.tick();
  assert.equal(sent[1], Buffer.from([0xf8, 0xff, 0xfe]).toString());
  pacer.send = () => new Promise((resolve) => { release = resolve; });
  const pending = pacer.tick();
  await pacer.tick();
  assert.equal(pacer.busy, true);
  release(); await pending;
  pacer.close();
  assert.equal(pacer.queue.length, 0);
});

test('Jitter buffer reorders wraparound, discards duplicates/late frames and resyncs big gaps', () => {
  const buffer = new CallJitterBuffer();
  buffer.push(65534, 'A'); buffer.push(0, 'C');
  assert.equal(buffer.take(), null);
  buffer.push(65535, 'B');
  assert.equal(buffer.take(), 'A');
  assert.equal(buffer.take(), 'B');
  buffer.push(65534, 'STALE');
  assert.equal(buffer.take(), 'C');
  assert.equal(buffer.frames.size, 0);
  buffer.push(100, 'X'); buffer.push(102, 'Z'); buffer.push(101, 'Y');
  assert.equal(buffer.take(), 'X'); assert.equal(buffer.take(), 'Y'); assert.equal(buffer.take(), 'Z');
});

test('Capture resamples actual 48kHz device clock into 320 samples per 20ms', () => {
  let Processor;
  const posted = [];
  const context = { AudioWorkletProcessor: class { constructor() { this.port = { postMessage: (data) => posted.push(data) }; } }, sampleRate: 48000, registerProcessor: (_name, processor) => { Processor = processor; } };
  vm.runInNewContext(fs.readFileSync(new URL('../public/call-audio-worklet.js', import.meta.url), 'utf8'), context);
  const capture = new Processor();
  for (let i = 0; i < 75; i++) capture.process([[new Float32Array(128).fill(0.5)]]);
  assert.equal(posted.length, 10);
  assert.ok(posted.every((frame) => frame.length === 320 && frame.every((value) => value === 0.5)));
});

test('Diagnostics persist allowlisted fields, hash identities and rotate a bounded file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zlsever-call-diagnostics-'));
  try {
    const log = createCallDiagnostics(dir);
    log('signal.error', { accountId: 'PRIVATE_ACCOUNT', threadId: 'PRIVATE_PEER', code: 112, token: 'SECRET', message: 'SECRET', params: { cookie: 'SECRET' } });
    const filename = path.join(dir, 'voice-calls.ndjson');
    const data = fs.readFileSync(filename, 'utf8');
    assert.equal(/PRIVATE|SECRET/.test(data), false);
    assert.equal(JSON.parse(data).code, 112);
    assert.equal(fs.statSync(filename).mode & 0o777, 0o600);
    fs.writeFileSync(filename, 'x'.repeat(1024 * 1024 + 1));
    log('call.ended', { reason: 'local_end' });
    assert.ok(fs.statSync(filename).size < 1024);
    assert.ok(fs.existsSync(filename + '.1'));
  } finally { fs.rmSync(dir, { recursive: true }); }
});
