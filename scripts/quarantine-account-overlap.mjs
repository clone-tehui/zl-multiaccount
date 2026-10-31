import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function quarantineAccountOverlap(input, sourceAccountId) {
  const state = structuredClone(input);
  if (!sourceAccountId || !state.accountStateById?.[sourceAccountId]) throw new Error('Verified original account required');
  const buckets = Object.entries(state.accountStateById || {});
  const owners = new Map();
  for (const [accountId, bucket] of buckets) {
    for (const threadId of Object.keys(bucket.threads || {})) {
      const accounts = owners.get(threadId) || new Set();
      accounts.add(accountId);
      owners.set(threadId, accounts);
    }
  }
  const uncertain = new Set([...owners].filter(([, accounts]) => accounts.size > 1).map(([threadId]) => threadId));
  const manifest = { version: 1, createdAt: new Date().toISOString(), reason: 'Operator-approved reversible quarantine of legacy overlapping account records; overlap alone is not proof of foreign ownership', accounts: [] };
  for (const [accountId, bucket] of buckets) {
    if (accountId === sourceAccountId) continue;
    const threadIds = Object.keys(bucket.threads || {}).filter((threadId) => uncertain.has(threadId));
    const messageCount = threadIds.reduce((total, threadId) => total + (bucket.messages?.[threadId]?.length || 0), 0);
    manifest.accounts.push({ accountId, threadIds, messageCount, archivedContactCount: Object.keys(bucket.contacts || {}).length });
    for (const threadId of threadIds) {
      delete bucket.threads[threadId];
      delete bucket.messages?.[threadId];
    }
    const requiredContacts = new Set([accountId, ...Object.values(bucket.threads || {}).flatMap((thread) => [String(thread.id), ...(thread.participantIds || []).map(String)])]);
    bucket.contacts = Object.fromEntries(Object.entries(bucket.contacts || {}).filter(([contactId]) => requiredContacts.has(contactId)));
    bucket.labels = { items: [], version: 0, lastUpdateTime: 0 };
    bucket.zalo = {};
    bucket.session = { ...bucket.session, syncInfo: null };
  }
  const active = state.accountStateById?.[state.activeAccountId];
  if (!active) throw new Error('Active account bucket missing; refusing recovery');
  for (const key of ['threads', 'messages', 'contacts', 'labels', 'zalo', 'session']) state[key] = structuredClone(active[key] || {});
  state.accountIsolationRecovery = { version: 1, completedAt: manifest.createdAt };
  return { state, manifest };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [statePath, baselinePath, archiveDirectory, mode] = process.argv.slice(2);
  if (!statePath || !baselinePath || !archiveDirectory) throw new Error('Usage: node scripts/quarantine-account-overlap.mjs STATE SINGLE_ACCOUNT_BASELINE ARCHIVE [--apply]; stop service before --apply');
  const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
  const sourceAccounts = Object.keys(baseline.accounts || {});
  if (sourceAccounts.length !== 1) throw new Error('Expected verified single-account baseline');
  const original = fs.readFileSync(statePath);
  const input = JSON.parse(original);
  if (input.accountIsolationRecovery) throw new Error('Recovery already applied; refusing repeated quarantine');
  const { state, manifest } = quarantineAccountOverlap(input, sourceAccounts[0]);
  if (mode === '--apply') {
    fs.mkdirSync(archiveDirectory, { mode: 0o700 });
    fs.writeFileSync(path.join(archiveDirectory, 'state-original.json'), original, { mode: 0o600, flag: 'wx' });
    fs.writeFileSync(path.join(archiveDirectory, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600, flag: 'wx' });
    if (!fs.readFileSync(statePath).equals(original)) throw new Error('State changed during recovery; stop service first');
    const temporary = `${statePath}.isolation-${process.pid}`;
    fs.writeFileSync(temporary, JSON.stringify(state, null, 2), { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, statePath);
  }
  console.log(JSON.stringify({ applied: mode === '--apply', accounts: manifest.accounts.map((item, ordinal) => ({ ordinal, quarantinedThreads: item.threadIds.length, quarantinedMessages: item.messageCount })) }));
}
