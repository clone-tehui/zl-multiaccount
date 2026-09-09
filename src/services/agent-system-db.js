import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

let cachedDb = null;

export function resolveAgentSystemDbPath() {
  const dataDir = String(process.env.DATA_DIR || path.resolve(process.cwd(), 'data')).trim();
  return path.join(dataDir, 'agent_system.db');
}

export function getAgentSystemDb() {
  if (cachedDb) return cachedDb;
  let dbPath = resolveAgentSystemDbPath();
  try {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  } catch {
    dbPath = path.join(path.resolve(process.cwd(), 'data'), 'agent_system.db');
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  cachedDb = new Database(dbPath);
  cachedDb.pragma('journal_mode = WAL');
  cachedDb.pragma('foreign_keys = ON');
  initializeAgentSystemDb(cachedDb);
  return cachedDb;
}

export function initializeAgentSystemDb(db = getAgentSystemDb()) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      name TEXT,
      role TEXT,
      system_instruction TEXT
    );

    CREATE TABLE IF NOT EXISTS tools (
      id TEXT PRIMARY KEY,
      name TEXT,
      description TEXT,
      type TEXT,
      target_agent_id TEXT
    );

    CREATE TABLE IF NOT EXISTS agent_tools (
      agent_id TEXT,
      tool_id TEXT,
      PRIMARY KEY(agent_id, tool_id)
    );

    CREATE TABLE IF NOT EXISTS agent_memory (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT,
      agent_id TEXT,
      role TEXT,
      content TEXT,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS openrouter_models (
      model_id TEXT PRIMARY KEY,
      model_name TEXT,
      capability TEXT
    );

    CREATE TABLE IF NOT EXISTS execution_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      execution_id TEXT,
      step_number INTEGER,
      node_type TEXT,
      node_name TEXT,
      input_data TEXT,
      output_data TEXT,
      model_used TEXT,
      duration_ms INTEGER
    );
  `);
  seedDefaultAgentSystemRows(db);
  return db;
}

export function seedAgentSystemFromConfig(config = {}, db = getAgentSystemDb()) {
  if (!config || typeof config !== 'object') return;
  const upsertAgent = db.prepare(`
    INSERT INTO agents (id, name, role, system_instruction)
    VALUES (@id, @name, @role, @system_instruction)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      role = excluded.role,
      system_instruction = CASE
        WHEN agents.system_instruction IS NULL OR trim(agents.system_instruction) = '' THEN excluded.system_instruction
        ELSE agents.system_instruction
      END
  `);
  const upsertTool = db.prepare(`
    INSERT INTO tools (id, name, description, type, target_agent_id)
    VALUES (@id, @name, @description, @type, @target_agent_id)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      description = excluded.description,
      type = excluded.type,
      target_agent_id = excluded.target_agent_id
  `);
  const grantTool = db.prepare(`INSERT OR IGNORE INTO agent_tools (agent_id, tool_id) VALUES (?, ?)`);
  const tx = db.transaction(() => {
    for (const agent of Array.isArray(config.agentRegistry) ? config.agentRegistry : []) {
      const id = String(agent?.id || '').trim();
      if (!id) continue;
      const responsibilities = Array.isArray(agent.responsibilities) ? agent.responsibilities.join('; ') : '';
      upsertAgent.run({
        id,
        name: String(agent.label || id),
        role: String(agent.role || ''),
        system_instruction: [config.systemPrompt, responsibilities].filter(Boolean).join('\n\n') || ' '
      });
      for (const rawTool of Array.isArray(agent.tools) ? agent.tools : []) {
        const parsed = parseToolHint(rawTool);
        const targetAgentId = parsed.id.startsWith('route_to_') ? parsed.id.replace(/^route_to_/, '') : null;
        const type = targetAgentId ? 'sub_agent' : 'function';
        upsertTool.run({
          id: parsed.id,
          name: parsed.name,
          description: parsed.description,
          type,
          target_agent_id: targetAgentId
        });
        grantTool.run(id, parsed.id);
      }
    }
    for (const model of Array.isArray(config.modelCatalog) ? config.modelCatalog : []) {
      const capability = String(model.tier || '').toLowerCase() === 'large' ? 'complex' : 'basic';
      db.prepare(`
        INSERT OR IGNORE INTO openrouter_models (model_id, model_name, capability)
        VALUES (?, ?, ?)
      `).run(String(model.modelId || model.id || ''), String(model.label || model.modelId || model.id || ''), capability);
    }
  });
  tx();
}

export function listAgents(db = getAgentSystemDb()) {
  return db.prepare(`SELECT id, name, role, system_instruction FROM agents ORDER BY id`).all();
}

export function updateAgentInstruction(agentId, systemInstruction, db = getAgentSystemDb()) {
  const id = String(agentId || '').trim();
  if (!id) throw new Error('Thiếu agent id');
  const instruction = String(systemInstruction || '').trim() || ' ';
  const result = db.prepare(`UPDATE agents SET system_instruction = ? WHERE id = ?`).run(instruction, id);
  if (!result.changes) throw new Error('Không tìm thấy agent');
  return db.prepare(`SELECT id, name, role, system_instruction FROM agents WHERE id = ?`).get(id);
}

export function getAgentById(agentId, db = getAgentSystemDb()) {
  return db.prepare(`SELECT id, name, role, system_instruction FROM agents WHERE id = ?`).get(String(agentId || '').trim()) || null;
}

export function listToolsForAgent(agentId, db = getAgentSystemDb()) {
  return db.prepare(`
    SELECT t.id, t.name, t.description, t.type, t.target_agent_id
    FROM tools t
    JOIN agent_tools at ON at.tool_id = t.id
    WHERE at.agent_id = ?
    ORDER BY t.id
  `).all(String(agentId || '').trim());
}

export function getToolForAgent(agentId, toolId, db = getAgentSystemDb()) {
  return db.prepare(`
    SELECT t.id, t.name, t.description, t.type, t.target_agent_id
    FROM tools t
    JOIN agent_tools at ON at.tool_id = t.id
    WHERE at.agent_id = ? AND t.id = ?
  `).get(String(agentId || '').trim(), String(toolId || '').trim()) || null;
}

export function loadAgentMemory(sessionId, agentId, limit = 12, db = getAgentSystemDb()) {
  return db.prepare(`
    SELECT role, content, timestamp
    FROM agent_memory
    WHERE session_id = ? AND agent_id = ?
    ORDER BY id DESC
    LIMIT ?
  `).all(String(sessionId || ''), String(agentId || ''), Number(limit || 12)).reverse();
}

export function saveAgentMemory(sessionId, agentId, role, content, db = getAgentSystemDb()) {
  db.prepare(`INSERT INTO agent_memory (session_id, agent_id, role, content) VALUES (?, ?, ?, ?)`).run(
    String(sessionId || ''),
    String(agentId || ''),
    String(role || 'assistant'),
    String(content || '').trim() || ' '
  );
}

export function selectOpenRouterModel(capability = 'basic', db = getAgentSystemDb()) {
  return db.prepare(`SELECT model_id, model_name, capability FROM openrouter_models WHERE capability = ? ORDER BY rowid LIMIT 1`).get(String(capability || 'basic'))
    || db.prepare(`SELECT model_id, model_name, capability FROM openrouter_models ORDER BY rowid LIMIT 1`).get()
    || null;
}

export function logExecutionStep({ executionId, stepNumber, nodeType, nodeName, inputData, outputData, modelUsed = null, durationMs = 0 } = {}, db = getAgentSystemDb()) {
  db.prepare(`
    INSERT INTO execution_logs (execution_id, step_number, node_type, node_name, input_data, output_data, model_used, duration_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    String(executionId || ''),
    Number(stepNumber || 0),
    String(nodeType || ''),
    String(nodeName || ''),
    safeJson(inputData),
    safeJson(outputData),
    modelUsed ? String(modelUsed) : null,
    Number(durationMs || 0)
  );
}

export function readExecutionLogs(executionId, db = getAgentSystemDb()) {
  return db.prepare(`
    SELECT id, execution_id, step_number, node_type, node_name, input_data, output_data, model_used, duration_ms
    FROM execution_logs
    WHERE execution_id = ?
    ORDER BY step_number ASC, id ASC
  `).all(String(executionId || '')).map((row) => ({
    ...row,
    input_data: parseJson(row.input_data),
    output_data: parseJson(row.output_data)
  }));
}

function seedDefaultAgentSystemRows(db) {
  const agentCount = db.prepare(`SELECT COUNT(*) AS count FROM agents`).get()?.count || 0;
  if (agentCount === 0) {
    const insertAgent = db.prepare(`INSERT INTO agents (id, name, role, system_instruction) VALUES (?, ?, ?, ?)`);
    insertAgent.run('orchestrator', 'Orchestrator chính', 'planner', 'Bạn là Orchestrator chính của ChiHome. Chọn đúng agent phụ/tool phù hợp, không gọi tất cả agent, tổng hợp kết quả và trả lời khách ngắn gọn.');
    insertAgent.run('composer', 'Reply composer', 'writer', 'Soạn câu trả lời cuối cho khách dựa trên dữ liệu đã có, không tự bịa fact mới.');
  }
  const modelCount = db.prepare(`SELECT COUNT(*) AS count FROM openrouter_models`).get()?.count || 0;
  if (modelCount === 0) {
    const insertModel = db.prepare(`INSERT INTO openrouter_models (model_id, model_name, capability) VALUES (?, ?, ?)`);
    insertModel.run('deepseek/deepseek-v4-flash', 'DeepSeek V4 Flash', 'basic');
    insertModel.run('openai/gpt-4o', 'GPT-4o', 'complex');
    insertModel.run('anthropic/claude-3.5-sonnet', 'Claude 3.5 Sonnet', 'complex');
  }
}

function parseToolHint(rawTool = '') {
  const text = String(rawTool || '').trim();
  const [idPart, ...rest] = text.split(':');
  const id = idPart.trim().replace(/[^a-zA-Z0-9_\-.]/g, '_') || `tool_${Math.random().toString(36).slice(2, 8)}`;
  const description = rest.join(':').trim() || text || id;
  return { id, name: id, description };
}

function safeJson(value) {
  try {
    return JSON.stringify(value ?? null);
  } catch {
    return JSON.stringify({ error: 'unserializable' });
  }
}

function parseJson(value) {
  try {
    return value ? JSON.parse(value) : null;
  } catch {
    return value;
  }
}
