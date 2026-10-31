#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const rootDir = path.resolve(import.meta.dirname, '..');
const dataDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(rootDir, 'data');
const statePath = process.argv[2] ? path.resolve(process.argv[2]) : path.join(dataDir, 'state.json');
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const errors = [];
const warnings = [];

const accounts = state.accounts && typeof state.accounts === 'object' ? state.accounts : {};
const accountStateById = state.accountStateById && typeof state.accountStateById === 'object' ? state.accountStateById : {};
const activeAccountId = String(state.activeAccountId || '').trim();

if (!activeAccountId) errors.push('missing activeAccountId');
if (!Object.keys(accounts).length) warnings.push('no accounts in state.accounts');

function sameJson(a, b) {
  return JSON.stringify(a || {}) === JSON.stringify(b || {});
}

function threadType(thread) {
  return String(thread?.type || 'direct');
}

const report = [];

for (const [accountId, account] of Object.entries(accounts)) {
  const snapshot = accountStateById[accountId];
  if (!snapshot || typeof snapshot !== 'object') {
    errors.push(`${accountId}: missing accountStateById snapshot`);
    continue;
  }

  const ownId = String(snapshot.session?.account?.id || account.userId || accountId || '');
  const threads = snapshot.threads && typeof snapshot.threads === 'object' ? snapshot.threads : {};
  const messages = snapshot.messages && typeof snapshot.messages === 'object' ? snapshot.messages : {};
  const contacts = snapshot.contacts && typeof snapshot.contacts === 'object' ? snapshot.contacts : {};

  let messageCount = 0;
  let directForeignSender = 0;
  let missingThreadMessages = 0;
  let wrongThreadIdMessages = 0;
  let danglingThreadParticipants = 0;

  for (const [threadId, items] of Object.entries(messages)) {
    const thread = threads[threadId];
    if (!thread) {
      missingThreadMessages += 1;
      continue;
    }
    const list = Array.isArray(items) ? items : [];
    messageCount += list.length;
    for (const message of list) {
      if (String(message?.threadId || threadId) !== String(threadId)) wrongThreadIdMessages += 1;
      if (threadType(thread) === 'direct') {
        const senderId = String(message?.senderId || '');
        if (senderId && senderId !== ownId && senderId !== String(threadId)) directForeignSender += 1;
      }
    }
  }

  for (const [threadId, thread] of Object.entries(threads)) {
    if (threadType(thread) !== 'group') continue;
    for (const participantId of thread.participantIds || []) {
      if (participantId && !contacts[String(participantId)]) danglingThreadParticipants += 1;
    }
    if (!threadId) errors.push(`${accountId}: empty thread id`);
  }

  if (directForeignSender) errors.push(`${accountId}: ${directForeignSender} direct messages have sender outside own/thread id`);
  if (missingThreadMessages) errors.push(`${accountId}: ${missingThreadMessages} message buckets without matching thread`);
  if (wrongThreadIdMessages) errors.push(`${accountId}: ${wrongThreadIdMessages} messages with mismatched threadId`);
  if (danglingThreadParticipants) warnings.push(`${accountId}: ${danglingThreadParticipants} group participants missing contact profile`);

  report.push({
    accountId,
    displayName: account.displayName || account.userId || accountId,
    status: account.status || null,
    ownId,
    threads: Object.keys(threads).length,
    contacts: Object.keys(contacts).length,
    messages: messageCount,
    directForeignSender,
    missingThreadMessages,
    wrongThreadIdMessages,
    danglingThreadParticipants
  });
}

if (activeAccountId) {
  const activeSnapshot = accountStateById[activeAccountId];
  if (!activeSnapshot) {
    errors.push(`active account ${activeAccountId}: missing snapshot`);
  } else {
    for (const key of ['contacts', 'threads', 'messages']) {
      if (!sameJson(state[key], activeSnapshot[key])) {
        errors.push(`active account ${activeAccountId}: global ${key} does not match active snapshot`);
      }
    }
    if (String(state.session?.account?.id || '') !== String(activeSnapshot.session?.account?.id || '')) {
      errors.push(`active account ${activeAccountId}: global session.account.id does not match active snapshot`);
    }
  }
}

const summary = {
  ok: errors.length === 0,
  statePath,
  activeAccountId,
  accountCount: Object.keys(accounts).length,
  report,
  warnings,
  errors
};

console.log(JSON.stringify(summary, null, 2));
if (errors.length) process.exit(1);
