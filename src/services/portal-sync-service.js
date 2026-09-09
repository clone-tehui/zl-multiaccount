export function createPortalSyncService(db) {
  const stats = {
    mode: db?.enabled ? 'dual-write' : 'json-only',
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastErrorAt: null,
    lastError: null,
    totalAttempts: 0,
    totalSuccess: 0,
    totalSkipped: 0,
    totalErrors: 0,
    byKind: {}
  };

  return {
    enabled: Boolean(db?.enabled),
    getStatus() {
      return {
        ...stats,
        enabled: Boolean(db?.enabled)
      };
    },
    async syncSettings(settings = {}) {
      return trackSync('settings', async () => {
        await db.query(
          `insert into portal_settings (key, value_json, updated_at)
           values ('global', $1::jsonb, now())
           on conflict (key) do update set value_json = excluded.value_json, updated_at = now()`,
          [JSON.stringify(settings)]
        );
      });
    },
    async syncDepartment(department) {
      return trackSync('department', async () => {
        const managerUserId = await resolveUserPk(db, department.managerUserIds?.[0]);
        await db.query(
          `insert into departments (code, name, description, manager_user_id, is_active, updated_at)
           values ($1, $2, $3, $4, $5, now())
           on conflict (code) do update
           set name = excluded.name,
               description = excluded.description,
               manager_user_id = excluded.manager_user_id,
               is_active = excluded.is_active,
               updated_at = now()`,
          [department.code || department.id, department.name || department.code || department.id, department.description || null, managerUserId, department.active !== false]
        );
      }, { skip: !department });
    },
    async syncUser(user) {
      return trackSync('user', async () => {
        await withDbTransaction(db, async (client) => {
          await client.query(
            `insert into users (username, password_hash, display_name, status, last_active_at, last_assigned_at, force_offline_until, is_active, updated_at)
             values ($1, $2, $3, $4, $5, $6, $7, $8, now())
             on conflict (username) do update
             set display_name = excluded.display_name,
                 status = excluded.status,
                 last_active_at = excluded.last_active_at,
                 last_assigned_at = excluded.last_assigned_at,
                 force_offline_until = excluded.force_offline_until,
                 is_active = excluded.is_active,
                 updated_at = now()`,
            [user.username || user.id, 'portal-managed-placeholder', user.displayName || user.username || user.id, user.status || 'offline', user.lastActiveAt || null, user.lastAssignedAt || null, user.forceOfflineUntil || null, user.active !== false]
          );
          const userRow = await client.query('select id from users where username = $1 limit 1', [user.username || user.id]);
          const userPk = userRow.rows?.[0]?.id;
          if (!userPk) throw new Error(`Không resolve được user PK cho ${user.username || user.id}`);

          await syncUserRoles(client, userPk, user.roles);
          await syncUserDepartments(client, userPk, user.departmentIds);
        });
      }, { skip: !user });
    },
    async syncChannel(channel) {
      return trackSync('channel', async () => {
        const departmentId = await resolveDepartmentPk(db, channel.departmentId);
        await withDbTransaction(db, async (client) => {
          await client.query(
            `insert into channels (code, name, channel_type, department_id, bot_status, routing_mode, is_active, updated_at)
             values ($1, $2, $3, $4, $5, $6, $7, now())
             on conflict (code) do update
             set name = excluded.name,
                 channel_type = excluded.channel_type,
                 department_id = excluded.department_id,
                 bot_status = excluded.bot_status,
                 routing_mode = excluded.routing_mode,
                 is_active = excluded.is_active,
                 updated_at = now()`,
            [channel.code || channel.id, channel.name || channel.code || channel.id, channel.channelType || 'zalo_personal', departmentId, channel.botStatus || 'disabled', channel.routingMode || 'least_connections', channel.active !== false]
          );
          const channelRow = await client.query('select id from channels where code = $1 limit 1', [channel.code || channel.id]);
          const channelPk = channelRow.rows?.[0]?.id;
          if (!channelPk) throw new Error(`Không resolve được channel PK cho ${channel.code || channel.id}`);
          await syncChannelMembers(client, channelPk, channel.members);
        });
      }, { skip: !channel });
    },
    async syncThreadBinding(binding) {
      return trackSync('threadBinding', async () => {
        const departmentId = await resolveDepartmentPk(db, binding.departmentId);
        const channelId = await resolveChannelPk(db, binding.channelId);
        const assignedUserId = await resolveUserPk(db, binding.assignedUserId);
        await db.query(
          `insert into thread_bindings (thread_id, department_id, channel_id, assigned_user_id, queue_status, priority, sla_first_response_due_at, sla_next_response_due_at, last_routing_action, last_routing_reason, last_routing_context_json, updated_at)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, now())
           on conflict (thread_id) do update
           set department_id = excluded.department_id,
               channel_id = excluded.channel_id,
               assigned_user_id = excluded.assigned_user_id,
               queue_status = excluded.queue_status,
               priority = excluded.priority,
               sla_first_response_due_at = excluded.sla_first_response_due_at,
               sla_next_response_due_at = excluded.sla_next_response_due_at,
               last_routing_action = excluded.last_routing_action,
               last_routing_reason = excluded.last_routing_reason,
               last_routing_context_json = excluded.last_routing_context_json,
               updated_at = now()`,
          [binding.threadId, departmentId, channelId, assignedUserId, binding.queueStatus || 'pending', binding.priority || 'normal', binding.slaFirstResponseDueAt || null, binding.slaNextResponseDueAt || null, binding.lastRoutingAction || null, binding.lastRoutingReason || null, JSON.stringify(binding.lastRoutingContext || {})]
        );
      }, { skip: !binding });
    }
  };

  async function trackSync(kind, worker, options = {}) {
    ensureKind(kind);
    stats.totalAttempts += 1;
    stats.byKind[kind].attempts += 1;
    stats.lastAttemptAt = new Date().toISOString();

    if (!db?.enabled || options.skip) {
      stats.totalSkipped += 1;
      stats.byKind[kind].skipped += 1;
      return { ok: false, skipped: true, mode: stats.mode, kind };
    }

    try {
      await worker();
      stats.totalSuccess += 1;
      stats.byKind[kind].success += 1;
      stats.lastSuccessAt = new Date().toISOString();
      stats.lastError = null;
      stats.lastErrorAt = null;
      return { ok: true, mode: stats.mode, kind };
    } catch (error) {
      stats.totalErrors += 1;
      stats.byKind[kind].errors += 1;
      stats.lastError = error.message || String(error);
      stats.lastErrorAt = new Date().toISOString();
      throw error;
    }
  }

  function ensureKind(kind) {
    if (!stats.byKind[kind]) {
      stats.byKind[kind] = { attempts: 0, success: 0, skipped: 0, errors: 0 };
    }
  }
}

async function withDbTransaction(db, fn) {
  if (typeof db?.withTransaction === 'function') return db.withTransaction(fn);
  return fn({ query: db.query.bind(db) });
}

async function syncUserRoles(client, userPk, roles = []) {
  const normalizedRoles = Array.from(new Set((Array.isArray(roles) ? roles : []).map((item) => String(item || '').trim()).filter(Boolean)));
  for (const role of normalizedRoles) {
    await client.query(
      `insert into roles (code, name)
       values ($1, initcap(replace($1, '_', ' ')))
       on conflict (code) do nothing`,
      [role]
    );
  }
  await client.query(
    `delete from user_roles
     where user_id = $1
       and role_id not in (
         select id from roles where code = any($2::text[])
       )`,
    [userPk, normalizedRoles.length ? normalizedRoles : ['__none__']]
  );
  for (const role of normalizedRoles) {
    await client.query(
      `insert into user_roles (user_id, role_id)
       select $1, id from roles where code = $2
       on conflict do nothing`,
      [userPk, role]
    );
  }
}

async function syncUserDepartments(client, userPk, departmentIds = []) {
  const normalizedDepartments = Array.from(new Set((Array.isArray(departmentIds) ? departmentIds : []).map((item) => String(item || '').trim()).filter(Boolean)));
  await client.query(
    `delete from user_departments
     where user_id = $1
       and department_id not in (
         select id from departments where code = any($2::text[])
       )`,
    [userPk, normalizedDepartments.length ? normalizedDepartments : ['__none__']]
  );
  for (const [index, departmentCode] of normalizedDepartments.entries()) {
    await client.query(
      `insert into user_departments (user_id, department_id, is_primary)
       select $1, id, $3 from departments where code = $2
       on conflict (user_id, department_id) do update set is_primary = excluded.is_primary`,
      [userPk, departmentCode, index === 0]
    );
  }
}

async function syncChannelMembers(client, channelPk, members = []) {
  const normalizedMembers = Array.isArray(members) ? members.filter(Boolean) : [];
  const memberUsernames = normalizedMembers.map((item) => String(item.userId || item.username || '').trim()).filter(Boolean);
  await client.query(
    `delete from channel_members
     where channel_id = $1
       and user_id not in (
         select id from users where username = any($2::text[])
       )`,
    [channelPk, memberUsernames.length ? memberUsernames : ['__none__']]
  );
  for (const item of normalizedMembers) {
    const username = String(item.userId || item.username || '').trim();
    if (!username) continue;
    await client.query(
      `insert into channel_members (channel_id, user_id, can_handle, priority_weight, max_open_conversations)
       select $1, id, $3, $4, $5 from users where username = $2
       on conflict (channel_id, user_id) do update
       set can_handle = excluded.can_handle,
           priority_weight = excluded.priority_weight,
           max_open_conversations = excluded.max_open_conversations`,
      [channelPk, username, item.canHandle !== false, Number(item.priorityWeight) || 100, Number(item.maxOpenConversations) || 20]
    );
  }
}

async function resolveDepartmentPk(db, code) {
  if (!code) return null;
  const result = await db.query('select id from departments where code = $1 limit 1', [String(code)]);
  return result.rows?.[0]?.id || null;
}

async function resolveUserPk(db, username) {
  if (!username) return null;
  const result = await db.query('select id from users where username = $1 limit 1', [String(username)]);
  return result.rows?.[0]?.id || null;
}

async function resolveChannelPk(db, code) {
  if (!code) return null;
  const result = await db.query('select id from channels where code = $1 limit 1', [String(code)]);
  return result.rows?.[0]?.id || null;
}
