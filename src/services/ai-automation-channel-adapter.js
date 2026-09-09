import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AUTOMATION_ACTIONS } from './ai-automation-contract.js';
import { processWorkflow } from './ai-automation-runtime.js';

export function createAiAutomationChannelAdapter({ sendTypingEvent, sendMessage } = {}) {
  return {
    async execute(action, context = {}) {
      if (!action?.kind) return;
      if (action.kind === AUTOMATION_ACTIONS.SEND_REPLY) {
        const threadId = String(action.payload?.threadId || context.threadId || '').trim();
        const accountId = String(action.payload?.accountId || context.accountId || '').trim();
        const messageParts = normalizeMessageParts(action.payload?.messageParts);
        if (messageParts.length) {
          return await sendSequentialMessageParts({ messageParts, threadId, accountId, sendTypingEvent, sendMessage });
        }
        const text = String(action.payload?.text || '').trim();
        const attachmentUrls = Array.isArray(action.payload?.attachmentsUrls) ? action.payload.attachmentsUrls : [];
        const attachments = await downloadRemoteAttachments(attachmentUrls);
        if (!threadId || (!text && !attachments.length)) return;
        if (typeof sendTypingEvent === 'function') {
          await sendTypingEvent(threadId, 'User', true, { accountId }).catch(() => null);
        }
        return await sendMessage({ threadId, text, accountId, attachments });
      }
      return null;
    }
  };
}


async function sendSequentialMessageParts({ messageParts = [], threadId = '', accountId = '', sendTypingEvent, sendMessage } = {}) {
  if (!threadId || typeof sendMessage !== 'function') return null;
  const results = [];
  for (const part of messageParts) {
    const text = String(part?.text || '').trim();
    const attachmentUrls = Array.isArray(part?.attachmentsUrls) ? part.attachmentsUrls : [];
    const attachments = await downloadRemoteAttachments(attachmentUrls);
    if (!text && !attachments.length) continue;
    if (typeof sendTypingEvent === 'function') {
      await sendTypingEvent(threadId, 'User', true, { accountId }).catch(() => null);
    }
    const result = await sendMessage({ threadId, text, accountId, attachments });
    results.push(result);
  }
  return results[results.length - 1] || null;
}

function normalizeMessageParts(parts = []) {
  if (!Array.isArray(parts)) return [];
  return parts.map((part) => ({
    text: String(part?.text || '').trim(),
    attachmentsUrls: Array.isArray(part?.attachmentsUrls) ? part.attachmentsUrls.map((item) => String(item || '').trim()).filter(Boolean) : []
  })).filter((part) => part.text || part.attachmentsUrls.length).slice(0, 80);
}

async function downloadRemoteAttachments(urls = []) {
  const files = [];
  for (const rawUrl of urls) {
    const url = String(rawUrl || '').trim();
    if (!url || isNonDownloadableImagePage(url)) continue;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      const response = await fetch(url, { signal: controller.signal });
      clearTimeout(timer);
      if (!response.ok) continue;
      const contentType = response.headers.get('content-type') || '';
      if (contentType && !/^image\//i.test(contentType)) continue;
      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      const extension = guessExtension(contentType, url);
      const filePath = path.join(os.tmpdir(), `ai-auto-${Date.now()}-${Math.random().toString(36).slice(2)}${extension}`);
      await fs.writeFile(filePath, buffer);
      files.push(filePath);
    } catch {
      continue;
    }
  }
  return files;
}

function isNonDownloadableImagePage(url = '') {
  return /photos\.google\.com\/share|photos\.app\.goo\.gl/i.test(String(url || ''));
}

function guessExtension(contentType = '', url = '') {
  const normalizedType = String(contentType || '').toLowerCase();
  if (normalizedType.includes('png')) return '.png';
  if (normalizedType.includes('webp')) return '.webp';
  if (normalizedType.includes('gif')) return '.gif';
  if (normalizedType.includes('jpeg') || normalizedType.includes('jpg')) return '.jpg';
  const pathname = String(url || '').split('?')[0];
  const ext = path.extname(pathname);
  return ext || '.jpg';
}

export function createZcaWorkflowAdapter({ zaloClient = null, rootAgentId = 'orchestrator', sendMessage = null } = {}) {
  return {
    async handleIncomingMessage(event = {}) {
      const sessionId = String(event?.senderId || event?.uidFrom || event?.fromUserId || event?.threadId || '').trim();
      const threadId = String(event?.threadId || event?.toid || event?.conversationId || sessionId || '').trim();
      const userMessage = String(event?.text || event?.message || event?.data?.content || '').trim();
      if (!sessionId || !threadId || !userMessage) return { ok: false, reason: 'missing_zalo_event_fields' };
      const workflow = await processWorkflow(sessionId, rootAgentId, userMessage);
      const text = String(workflow?.text || '').trim();
      if (!text) return { ok: false, reason: 'empty_workflow_reply', executionId: workflow.executionId };
      if (typeof sendMessage === 'function') {
        await sendMessage({ threadId, text });
      } else if (zaloClient?.api?.sendMessage) {
        await zaloClient.api.sendMessage(text, threadId);
      } else if (zaloClient?.sendMessage) {
        await zaloClient.sendMessage({ threadId, text });
      } else {
        return { ok: false, reason: 'missing_zalo_send_method', executionId: workflow.executionId, text };
      }
      return { ok: true, executionId: workflow.executionId, text };
    }
  };
}
