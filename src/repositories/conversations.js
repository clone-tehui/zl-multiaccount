export function createConversationsRepository(db) {
  return {
    async countOpenByUserIds(userIds = []) {
      return db.query(`
        select assigned_user_id, count(*)::int as open_count
        from conversations
        where assigned_user_id = any($1::bigint[]) and status = 'open'
        group by assigned_user_id
      `, [userIds]);
    },
    async enqueue(conversationId, departmentId, priority = 100) {
      return db.query(`insert into routing_queue (conversation_id, department_id, priority) values ($1, $2, $3)`, [conversationId, departmentId, priority]);
    },
    async assign(conversationId, userId) {
      return db.query(`
        update conversations
        set assigned_user_id = $2, status = 'open', updated_at = now()
        where id = $1
      `, [conversationId, userId]);
    }
  };
}
