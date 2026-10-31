import test from 'node:test';
import assert from 'node:assert/strict';
import { ChatbotBridgeService } from '../src/services/chatbot-bridge-service.js';

test('chatbot bridge forwards selected direct inbound message with shared secret', async () => {
  const calls = [];
  const service = new ChatbotBridgeService({
    webhookUrl: 'http://chatbot.local/webhooks/zalo',
    secret: 'bridge-secret',
    selectedAccountIds: 'acc-1',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return { ok: true, status: 202 };
    },
  });

  const payload = {
    event: 'message',
    account_id: 'acc-1',
    messageData: { id: 'm1', threadId: 'u1', senderId: 'u1', text: 'hello', isOutgoing: false },
  };

  const result = await service.deliver(payload, {
    accountId: 'acc-1',
    isOutgoing: false,
    isGroup: false,
  });

  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://chatbot.local/webhooks/zalo');
  assert.equal(calls[0].options.headers['x-chatbot-bridge-secret'], 'bridge-secret');
  assert.deepEqual(JSON.parse(calls[0].options.body), payload);
});

test('chatbot bridge skips outgoing, groups by default, and unselected accounts', async () => {
  let calls = 0;
  const service = new ChatbotBridgeService({
    webhookUrl: 'http://chatbot.local/webhooks/zalo',
    secret: 'bridge-secret',
    selectedAccountIds: 'acc-1',
    fetchImpl: async () => {
      calls += 1;
      return { ok: true, status: 202 };
    },
  });

  assert.deepEqual(await service.deliver({}, { accountId: 'acc-1', isOutgoing: true }), { skipped: true });
  assert.deepEqual(await service.deliver({}, { accountId: 'acc-1', isGroup: true }), { skipped: true });
  assert.deepEqual(await service.deliver({}, { accountId: 'acc-2', isOutgoing: false, isGroup: false }), { skipped: true });
  assert.equal(calls, 0);
});
