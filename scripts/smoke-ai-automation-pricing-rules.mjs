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

function buildHarness(threadId) {
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
    aiAutomationByDepartment: { ChiHome: baseConfig },
    aiAutomationLogs: [],
    aiAutomationUsage: {},
    accounts: {},
    accountStateById: {
      [accountId]: {
        threads: {
          [threadId]: {
            id: threadId,
            title: 'Smoke ChiHome Pricing Rules',
            messages: [],
            automation: {}
          }
        }
      }
    }
  };

  const sent = [];
  const adapter = createAiAutomationChannelAdapter({
    async sendTypingEvent() {
      return { ok: true };
    },
    async sendMessage({ threadId: sentThreadId, text, accountId: sentAccountId }) {
      sent.push({ threadId: sentThreadId, text, accountId: sentAccountId });
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
    emitEvent: () => {},
    logger: console
  });

  return { runtime, sent, accountId, threadId };
}

const availabilityHarness = buildHarness('smoke-thread-pricing-normal');
await availabilityHarness.runtime.runIncoming({
  channel: 'zalo',
  accountId: availabilityHarness.accountId,
  threadId: availabilityHarness.threadId,
  message: {
    id: 'msg-pricing-normal',
    threadId: availabilityHarness.threadId,
    senderId: 'guest-1',
    text: 'Bên mình còn phòng Galleria 1 phòng ngủ từ 23/05 đến 25/05 cho 2 khách không?',
    isOutgoing: false
  }
});

const availabilityTexts = availabilityHarness.sent.map((item) => item.text || '');
const availabilityReply = availabilityTexts.join('\n\n');
assert.match(availabilityTexts[0] || '', /Hiện còn/i);
assert.match(availabilityReply, /C05\.03A/i);
assert.match(availabilityReply, /Em gửi kèm hình/i);
assert.doesNotMatch(availabilityReply, /Hình ảnh căn\s*\d+:/i);
assert.doesNotMatch(availabilityReply, /photos\.google\.com\/share|photos\.app\.goo\.gl|api\.tehui\.io\.vn\/uploads\/rooms/i);
assert.doesNotMatch(availabilityReply, /có thể giảm khoảng|mức tốt hơn|mềm hơn/i);

const negotiationHarness = buildHarness('smoke-thread-pricing-negotiation');
await negotiationHarness.runtime.runIncoming({
  channel: 'zalo',
  accountId: negotiationHarness.accountId,
  threadId: negotiationHarness.threadId,
  message: {
    id: 'msg-pricing-negotiation',
    threadId: negotiationHarness.threadId,
    senderId: 'guest-1',
    text: 'Phòng Galleria 1 phòng ngủ từ 23/05 đến 25/05 cho 2 khách giá hơi căng, có bớt được không?',
    isOutgoing: false
  }
});

const negotiationReply = negotiationHarness.sent.map((item) => item.text || '').join('\n\n');
assert.match(negotiationReply, /xin hỗ trợ khoảng|có thể giảm khoảng|mức tốt hơn|mềm hơn/i);
assert.match(negotiationReply, /C05\.03A/i);

console.log(JSON.stringify({
  ok: true,
  availabilityReply,
  negotiationReply
}, null, 2));
