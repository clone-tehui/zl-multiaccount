import { Pool } from 'pg';

export function createDbClient() {
  const databaseUrl = process.env.DATABASE_URL || '';
  const enabled = Boolean(databaseUrl);
  const pool = enabled ? new Pool({ connectionString: databaseUrl }) : null;

  return {
    enabled,
    databaseUrl,
    pool,
    async query(sql, params = []) {
      if (!enabled || !pool) throw new Error('DB client chưa được nối. Hãy cấu hình DATABASE_URL hợp lệ.');
      return pool.query(sql, params);
    },
    async withTransaction(fn) {
      if (!enabled || !pool) throw new Error('DB client chưa được nối. Hãy cấu hình DATABASE_URL hợp lệ.');
      const client = await pool.connect();
      try {
        await client.query('begin');
        const result = await fn(client);
        await client.query('commit');
        return result;
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }
    },
    async close() {
      if (pool) await pool.end();
    }
  };
}
