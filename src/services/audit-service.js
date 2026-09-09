export function createAuditService(db) {
  return {
    async log(entry) {
      if (!db?.enabled) return { ok: false, skipped: true };
      return db.query(
        `insert into audit_logs (actor_user_id, action, resource_type, resource_id, payload_json) values ($1, $2, $3, $4, $5::jsonb)`,
        [entry.actorUserId || null, entry.action, entry.resourceType, entry.resourceId || null, JSON.stringify(entry.payload || {})]
      );
    }
  };
}
