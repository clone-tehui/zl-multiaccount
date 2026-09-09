export function createUsersRepository(db) {
  return {
    async findByUsername(username) {
      return db.query(`select * from users where username = $1 limit 1`, [username]);
    },
    async updatePresence(userId, status) {
      return db.query(`update users set status = $2, last_active_at = now(), updated_at = now() where id = $1`, [userId, status]);
    },
    async forceOffline(userId, until, reason = '') {
      return db.query(`update users set status = 'offline', force_offline_until = $2, updated_at = now() where id = $1`, [userId, until]);
    },
    async touchHeartbeat(userId) {
      return db.query(`update users set last_active_at = now(), updated_at = now() where id = $1`, [userId]);
    }
  };
}
