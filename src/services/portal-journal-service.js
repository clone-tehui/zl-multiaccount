import fs from 'node:fs';
import path from 'node:path';

export function createPortalJournalService({ db, dataDir }) {
  const filePath = path.join(dataDir, 'portal-event-journal.jsonl');
  fs.mkdirSync(dataDir, { recursive: true });
  if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, '');

  const stats = {
    fileWrites: 0,
    dbWrites: 0,
    lastEventAt: null,
    lastDbSyncAt: null,
    lastDbError: null,
    lastDbErrorAt: null
  };

  return {
    filePath,
    dbEnabled: Boolean(db?.enabled),
    async append(entry = {}) {
      const event = normalizeEvent(entry);
      fs.appendFileSync(filePath, `${JSON.stringify(event)}\n`);
      stats.fileWrites += 1;
      stats.lastEventAt = event.createdAt;
      if (db?.enabled) {
        try {
          await db.query(
            `insert into portal_event_journal
              (id, actor_user_id, action, resource_type, resource_id, department_id, payload_json, source, created_at, recorded_at)
             values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, now())
             on conflict (id) do nothing`,
            [
              event.id,
              event.actorUserId,
              event.action,
              event.resourceType,
              event.resourceId,
              event.departmentId,
              JSON.stringify(event.payload || {}),
              event.source || 'portal',
              event.createdAt
            ]
          );
          stats.dbWrites += 1;
          stats.lastDbSyncAt = new Date().toISOString();
          stats.lastDbError = null;
          stats.lastDbErrorAt = null;
        } catch (error) {
          stats.lastDbError = error.message || String(error);
          stats.lastDbErrorAt = new Date().toISOString();
        }
      }
      return event;
    },
    getStatus() {
      return {
        mode: db?.enabled ? 'dual-write' : 'json-only',
        filePath,
        fileExists: fs.existsSync(filePath),
        fileWrites: stats.fileWrites,
        dbWrites: stats.dbWrites,
        lastEventAt: stats.lastEventAt,
        lastDbSyncAt: stats.lastDbSyncAt,
        lastDbError: stats.lastDbError,
        lastDbErrorAt: stats.lastDbErrorAt
      };
    }
  };
}

function normalizeEvent(entry) {
  const createdAt = entry.createdAt || new Date().toISOString();
  return {
    id: entry.id || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    actorUserId: entry.actorUserId || 'system',
    action: entry.action || 'unknown',
    resourceType: entry.resourceType || 'resource',
    resourceId: entry.resourceId || null,
    departmentId: entry.departmentId || null,
    payload: entry.payload || {},
    source: entry.source || 'portal',
    createdAt
  };
}
