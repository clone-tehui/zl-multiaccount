import assert from 'node:assert/strict';
import { loadEnvFile } from 'node:process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAiAutomationRuntime } from '../src/services/ai-automation-runtime.js';
import { createAiAutomationChannelAdapter } from '../src/services/ai-automation-channel-adapter.js';
import { resolveAiAutomationConfigForDepartment } from '../src/services/ai-automation-service.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
try {
  loadEnvFile(path.join(__dirname, '..', '.env'));
} catch {}

const threadId = 'smoke-thread-chihome';
const accountId = '642007995652147887';
const portalState = {
  threadBindings: {
    [threadId]: {
      threadId,
      accountId,
      departmentId: 'ChiHome',
      channelId: accountId,
      queueStatus: 'open'
    }
  }
};

const baseConfig = resolveAiAutomationConfigForDepartment({
  aiAutomation: {},
  aiAutomationByDepartment: {
    ChiHome: {
      enabled: true,
      defaultThreadMode: 'auto'
    }
  },
  departmentId: 'ChiHome'
});

const appState = {
  activeAccountId: 'stub-active-account',
  labels: { items: [], version: 0, lastUpdateTime: 0 },
  zalo: {},
  contacts: {},
  threads: {},
  messages: {},
  session: { account: null, syncInfo: null, status: 'connected', updatedAt: new Date().toISOString() },
  aiAutomation: {},
  aiAutomationByDepartment: {
    ChiHome: baseConfig
  },
  aiAutomationLogs: [],
  aiAutomationUsage: {},
  accounts: {},
  accountStateById: {
    [accountId]: {
      threads: {
        [threadId]: {
          id: threadId,
          title: 'Smoke ChiHome',
          messages: [],
          automation: {}
        }
      }
    }
  }
};

const sent = [];
const events = [];
const adapter = createAiAutomationChannelAdapter({
  async sendTypingEvent(threadId, actor, active, options = {}) {
    sent.push({ kind: 'typing', threadId, actor, active, accountId: options.accountId || null });
    return { ok: true };
  },
  async sendMessage({ threadId, text, accountId }) {
    sent.push({ kind: 'message', threadId, text, accountId });
    return { ok: true, provider: 'stub', text };
  }
});

const runtime = createAiAutomationRuntime({
  readAppState: () => appState,
  updateAppState: (mutator) => mutator(appState),
  readPortalState: () => portalState,
  resolveThreadRecord: (state, wantedThreadId, wantedAccountId) => state.accountStateById?.[wantedAccountId]?.threads?.[wantedThreadId] || null,
  resolvePortalThreadBinding: (state, wantedThreadId) => state.threadBindings?.[wantedThreadId] || null,
  getDepartmentIdForThread: () => 'ChiHome',
  getConfigForDepartment: (state, departmentId) => resolveAiAutomationConfigForDepartment({
    aiAutomation: state.aiAutomation,
    aiAutomationByDepartment: state.aiAutomationByDepartment,
    departmentId
  }),
  adapter,
  emitEvent: (type, payload) => events.push({ type, payload }),
  logger: console
});

await runtime.runIncoming({
  channel: 'zalo',
  accountId,
  threadId,
  message: {
    id: 'msg-live-1',
    threadId,
    senderId: 'guest-1',
    text: 'Bên mình còn phòng trống từ 23/05 đến 25/05 cho 2 khách không?',
    isOutgoing: false
  }
});

const liveSend = sent.find((item) => item.kind === 'message');
assert.ok(liveSend, 'expected runtime to send a reply');
assert.match(liveSend.text, /ChiHomeHotel|23\/05\/2026|25\/05\/2026|căn phù hợp/i);
assert.equal(appState.accountStateById[accountId].threads[threadId].automation.mode, 'auto');
assert.ok(appState.aiAutomationLogs.some((item) => item.stage === 'send' && item.status === 'ok'));
assert.ok(appState.aiAutomationUsage.recentCalls?.[0]?.provider);

await runtime.runIncoming({
  channel: 'zalo',
  accountId,
  threadId,
  message: {
    id: 'msg-escalate-1',
    threadId,
    senderId: 'guest-1',
    text: 'Tôi rất bực và muốn gặp nhân viên ngay',
    isOutgoing: false
  }
});

assert.equal(appState.accountStateById[accountId].threads[threadId].automation.mode, 'paused_by_escalation');
assert.ok(sent.some((item) => item.kind === 'message' && /chuyển người phụ trách hỗ trợ ngay/i.test(item.text)));
assert.ok(events.some((item) => item.type === 'thread.meta_updated'));

console.log(JSON.stringify({
  ok: true,
  sentMessages: sent.filter((item) => item.kind === 'message').map((item) => item.text),
  finalAutomation: appState.accountStateById[accountId].threads[threadId].automation,
  usageProvider: appState.aiAutomationUsage.recentCalls?.[0]?.provider || null,
  logStages: appState.aiAutomationLogs.slice(0, 6).map((item) => ({ stage: item.stage, status: item.status, reason: item.reason }))
}, null, 2));
