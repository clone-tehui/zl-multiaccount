import assert from 'node:assert/strict';
import { loadEnvFile } from 'node:process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateOpenRouterReply } from '../src/services/ai-automation-openrouter.js';
import { buildAgentPlan, resolveAiAutomationConfigForDepartment } from '../src/services/ai-automation-service.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
loadEnvFile(path.join(__dirname, '..', '.env'));

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

const cases = [
  'Bên mình còn phòng trống từ 23/05 đến 25/05 không?',
  'Giá phòng 2 phòng ngủ ở Crest bao nhiêu?',
  'Cho mình hỏi tiện ích của phòng 1 phòng ngủ là gì?'
];

for (const text of cases) {
  const normalized = text.normalize('NFD').replace(/\p{Diacritic}+/gu, '').toLowerCase();
  const intent = normalized.includes('tien ich') ? 'amenities' : normalized.includes('gia') ? 'pricing' : 'availability';
  const message = { text };
  const thread = { messages: [] };
  const portalBinding = { departmentId: 'ChiHome', channelId: '642007995652147887' };
  const plan = buildAgentPlan({
    message,
    thread,
    portalBinding,
    config: baseConfig,
    intent,
    confidence: 0.9,
    complexity: 'simple',
    asksHuman: false,
    repeatedQuestions: 0,
    sentiment: 'neutral',
    now: Date.now()
  });
  const result = await generateOpenRouterReply({
    config: baseConfig,
    plan,
    message,
    thread,
    portalBinding
  });

  console.log('CASE:', text);
  console.log(JSON.stringify(result, null, 2));
  console.log('---');
  assert.equal(result.ok, true, `Expected smoke live case to succeed: ${text}`);
}
