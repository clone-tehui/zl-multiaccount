import fs from 'node:fs';
import { MockProvider } from '../../src/providers/mock-provider.js';
import { currentRequestAccountId } from '../../src/services/request-account-context.js';

MockProvider.prototype.sendMessage = async function (payload) {
  await new Promise((resolve) => setTimeout(resolve, 15));
  if (payload.text === 'provider-error') throw new Error('Synthetic provider failure');
  return {
    accountId: currentRequestAccountId(), requestedAccount: payload.accountId, threadId: payload.threadId, text: payload.text,
    files: payload.attachments.map((filename, index) => ({ basename: filename.split('/').pop(), data: fs.readFileSync(filename).toString('base64'), ...payload.attachmentMeta[index] }))
  };
};
