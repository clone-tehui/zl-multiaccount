import assert from 'node:assert/strict';
import { previewAutomationOutcome } from '../src/services/ai-automation-runtime.js';
import { AUTOMATION_ACTIONS, AUTOMATION_RESULTS } from '../src/services/ai-automation-contract.js';
import { DEFAULT_AI_AUTOMATION_CONFIG } from '../src/services/ai-automation-service.js';

const base = { ...DEFAULT_AI_AUTOMATION_CONFIG, enabled: true };

const booking = await previewAutomationOutcome({
  channel: 'zalo',
  accountId: 'acc1',
  threadId: 'thread1',
  message: { text: 'Bên mình còn phòng tối nay cho 2 khách không?' },
  thread: { messages: [], automation: { mode: 'auto' } },
  portalBinding: { departmentId: 'ChiHome' },
  config: base
});
assert.equal(booking.result, AUTOMATION_RESULTS.REPLY);
assert.equal(booking.shouldReply, true);
assert.equal(booking.analysis.intent, 'availability');
assert.ok(booking.replyText);
assert.ok((booking.actions || []).some((item) => item.kind === AUTOMATION_ACTIONS.SEND_REPLY));

const complaint = await previewAutomationOutcome({
  channel: 'zalo',
  accountId: 'acc1',
  threadId: 'thread2',
  message: { text: 'Tôi rất bực và muốn hoàn tiền ngay' },
  thread: { messages: [], automation: { mode: 'auto' } },
  portalBinding: { departmentId: 'ChiHome' },
  config: base
});
assert.equal(complaint.result, AUTOMATION_RESULTS.ESCALATE);
assert.equal(complaint.shouldReply, false);
assert.equal(complaint.analysis.sentiment, 'negative');
assert.ok((complaint.actions || []).some((item) => item.kind === AUTOMATION_ACTIONS.PATCH_THREAD));
assert.ok((complaint.actions || []).some((item) => item.kind === AUTOMATION_ACTIONS.SEND_REPLY));

console.log(JSON.stringify({ ok: true, booking: booking.result, complaint: complaint.result }, null, 2));
