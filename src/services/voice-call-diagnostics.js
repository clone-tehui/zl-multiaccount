import fs from 'node:fs';
import path from 'node:path';
import { createHmac, randomBytes } from 'node:crypto';

// Strict allowlist: never serialize events, API results, errors or connection params.
export function createCallDiagnostics(baseDir) {
  const secret = randomBytes(32);
  const filename = path.join(baseDir, 'voice-calls.ndjson');
  let warned = false;
  return (event, fields = {}) => {
    const entry = { time: new Date().toISOString(), event };
    for (const name of ['accountId', 'threadId', 'callId']) {
      if (fields[name]) entry[name.replace('Id', 'Ref')] = createHmac('sha256', secret).update(String(fields[name])).digest('hex').slice(0, 16);
    }
    for (const name of ['trace', 'stage', 'status', 'reason', 'direction', 'code', 'elapsedMs', 'durationSeconds', 'dropped', 'delivered']) {
      const value = fields[name];
      if (typeof value === 'number' && Number.isFinite(value)) entry[name] = value;
      else if (typeof value === 'string' && /^[a-zA-Z0-9_.-]{1,80}$/.test(value)) entry[name] = value;
    }
    try {
      if (fs.existsSync(filename) && fs.statSync(filename).size > 1024 * 1024) fs.renameSync(filename, filename + '.1');
      fs.appendFileSync(filename, JSON.stringify(entry) + '\n', { mode: 0o600 });
    } catch {
      if (!warned) { warned = true; console.warn('[voice] Could not persist sanitized call diagnostics'); }
    }
  };
}
