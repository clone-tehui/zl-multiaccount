import { buildPortalSummary } from './access-service.js';
import { derivePresenceStatus } from './presence-service.js';

export function createPortalReadService({ db, portalStore, preferredSource = 'auto' }) {
  const stats = {
    preferredSource,
    catalog: { source: 'json', lastSuccessAt: null, lastErrorAt: null, lastError: null },
    ops: { source: 'json', lastSuccessAt: null, lastErrorAt: null, lastError: null },
    activity: { source: 'json', lastSuccessAt: null, lastErrorAt: null, lastError: null }
  };

  return {
    getStatus() {
      return {
        preferredSource: stats.preferredSource,
        catalog: { ...stats.catalog },
        ops: { ...stats.ops },
        activity: { ...stats.activity }
      };
    },
    async readCatalog(principal) {
      const portalState = portalStore.read();
      const context = buildVisibilityContext(principal, portalState);
      const jsonResult = buildJsonCatalog(context);
      if (preferredSource === 'json' || !db?.enabled) {
        markSuccess('catalog', 'json');
        return jsonResult;
      }

      let hadDbError = false;
      try {
        const dbResult = await buildDbCatalog(db, context);
        if (preferredSource === 'db' || hasMeaningfulCatalogData(dbResult)) {
          markSuccess('catalog', 'db');
          return dbResult;
        }
      } catch (error) {
        hadDbError = true;
        markError('catalog', error);
        if (preferredSource === 'db') throw error;
      }

      markSuccess('catalog', 'json', { clearError: !hadDbError });
      return jsonResult;
    },
    async readOpsOverview(principal) {
      const portalState = portalStore.read();
      const context = buildVisibilityContext(principal, portalState);
      const jsonResult = buildJsonOpsOverview(context);
      if (preferredSource === 'json' || !db?.enabled) {
        markSuccess('ops', 'json');
        return jsonResult;
      }

      let hadDbError = false;
      try {
        const dbResult = await buildDbOpsOverview(db, context);
        if (preferredSource === 'db' || hasMeaningfulOpsData(dbResult)) {
          markSuccess('ops', 'db');
          return dbResult;
        }
      } catch (error) {
        hadDbError = true;
        markError('ops', error);
        if (preferredSource === 'db') throw error;
      }

      markSuccess('ops', 'json', { clearError: !hadDbError });
      return jsonResult;
    },
    async readActivity(principal, options = {}) {
      const portalState = portalStore.read();
      const context = buildVisibilityContext(principal, portalState);
      const jsonResult = buildJsonActivity(context, options.limit || 50);
      if (preferredSource === 'json' || !db?.enabled) {
        markSuccess('activity', 'json');
        return jsonResult;
      }

      let hadDbError = false;
      try {
        const dbResult = await buildDbActivity(db, context, options.limit || 50);
        if (preferredSource === 'db' || dbResult.items.length || !jsonResult.items.length) {
          markSuccess('activity', 'db');
          return dbResult;
        }
      } catch (error) {
        hadDbError = true;
        markError('activity', error);
        if (preferredSource === 'db') throw error;
      }

      markSuccess('activity', 'json', { clearError: !hadDbError });
      return jsonResult;
    }
  };

  function markSuccess(kind, source, options = {}) {
    stats[kind].source = source;
    stats[kind].lastSuccessAt = new Date().toISOString();
    if (options.clearError !== false) {
      stats[kind].lastError = null;
      stats[kind].lastErrorAt = null;
    }
  }

  function markError(kind, error) {
    stats[kind].lastError = error?.message || String(error);
    stats[kind].lastErrorAt = new Date().toISOString();
  }
}

function buildVisibilityContext(principal, portalState) {
  const canReadAll = (principal.permissions || []).includes('*');
  const visibleDeptIds = new Set(
    canReadAll
      ? (portalState.departments || []).map((item) => String(item.id))
      : (principal.departmentIds || []).map(String)
  );
  return { principal, portalState, canReadAll, visibleDeptIds };
}

function buildJsonCatalog(context) {
  const portal = buildPortalSummary(context.principal, context.portalState);
  return {
    ok: true,
    source: 'json',
    portal,
    users: context.canReadAll
      ? (context.portalState.users || []).map(maskPortalUser)
      : (context.portalState.users || []).filter((item) => (item.departmentIds || []).some((deptId) => context.visibleDeptIds.has(String(deptId)))).map(maskPortalUser),
    threadBindings: filterThreadBindings(context),
    settings: context.canReadAll ? (context.portalState.settings || {}) : maskPortalSettings(context.portalState.settings || {})
  };
}

async function buildDbCatalog(db, context) {
  const departmentCodes = Array.from(context.visibleDeptIds);
  const [departmentsResult, channelsResult, usersResult, bindingsResult, settingsResult] = await Promise.all([
    db.query(
      `select d.code as id, d.code, d.name, d.description, d.is_active,
              coalesce(array_remove(array_agg(distinct mu.username), null), '{}') as manager_user_ids
       from departments d
       left join users mu on mu.id = d.manager_user_id
       where d.code = any($1::text[])
       group by d.id
       order by d.code asc`,
      [departmentCodes]
    ),
    db.query(
      `select c.code as id, c.code, c.name, c.channel_type, c.bot_status, c.routing_mode, c.is_active,
              d.code as department_id
       from channels c
       left join departments d on d.id = c.department_id
       where c.department_id is null or d.code = any($1::text[])
       order by c.code asc`,
      [departmentCodes]
    ),
    db.query(
      `select u.id::text as id, u.username, u.display_name, u.status, u.last_active_at, u.last_assigned_at,
              u.force_offline_until, u.is_active, coalesce(max(cm.max_open_conversations), 20) as max_open_conversations,
              coalesce(max(cm.priority_weight), 100) as routing_weight,
              coalesce(array_remove(array_agg(distinct r.code), null), '{}') as roles,
              coalesce(array_remove(array_agg(distinct d.code), null), '{}') as department_ids
       from users u
       join user_departments ud on ud.user_id = u.id
       join departments d on d.id = ud.department_id
       left join user_roles ur on ur.user_id = u.id
       left join roles r on r.id = ur.role_id
       left join channel_members cm on cm.user_id = u.id
       where d.code = any($1::text[])
       group by u.id
       order by u.username asc`,
      [departmentCodes]
    ),
    db.query(
      `select tb.thread_id, d.code as department_id, c.code as channel_id,
              u.username as assigned_user_id, tb.queue_status, tb.priority,
              tb.sla_first_response_due_at, tb.sla_next_response_due_at,
              tb.last_routing_action, tb.last_routing_reason, tb.last_routing_context_json, tb.updated_at
       from thread_bindings tb
       left join departments d on d.id = tb.department_id
       left join channels c on c.id = tb.channel_id
       left join users u on u.id = tb.assigned_user_id
       where tb.department_id is null or d.code = any($1::text[])
       order by tb.updated_at desc`,
      [departmentCodes]
    ),
    db.query(`select value_json from portal_settings where key = 'global' limit 1`)
  ]);

  const departments = (departmentsResult.rows || []).map((row) => ({
    id: row.id,
    code: row.code,
    name: row.name,
    description: row.description,
    managerUserIds: row.manager_user_ids || [],
    active: row.is_active !== false
  }));

  const channels = (channelsResult.rows || []).map((row) => ({
    id: row.id,
    code: row.code,
    name: row.name,
    departmentId: row.department_id,
    channelType: row.channel_type,
    botStatus: row.bot_status,
    routingMode: row.routing_mode,
    active: row.is_active !== false
  }));

  const users = (usersResult.rows || []).map((row) => ({
    id: row.username || row.id,
    username: row.username,
    displayName: row.display_name,
    roles: row.roles || [],
    departmentIds: row.department_ids || [],
    permissions: [],
    status: row.status,
    lastActiveAt: row.last_active_at,
    lastAssignedAt: row.last_assigned_at,
    forceOfflineUntil: row.force_offline_until,
    maxOpenConversations: Number(row.max_open_conversations) || 20,
    routingWeight: Number(row.routing_weight) || 100,
    active: row.is_active !== false,
    dbUserPk: row.id
  }));

  const threadBindings = Object.fromEntries((bindingsResult.rows || []).map((row) => [String(row.thread_id), {
    threadId: row.thread_id,
    departmentId: row.department_id || null,
    channelId: row.channel_id || null,
    assignedUserId: row.assigned_user_id || null,
    queueStatus: row.queue_status || 'pending',
    priority: row.priority || 'normal',
    slaFirstResponseDueAt: row.sla_first_response_due_at || null,
    slaNextResponseDueAt: row.sla_next_response_due_at || null,
    lastRoutingAction: row.last_routing_action || null,
    lastRoutingReason: row.last_routing_reason || null,
    lastRoutingContext: row.last_routing_context_json || null,
    updatedAt: row.updated_at || null
  }]));

  const settings = settingsResult.rows?.[0]?.value_json || context.portalState.settings || {};
  const dbPortalState = {
    ...context.portalState,
    departments,
    channels,
    users,
    threadBindings,
    settings
  };
  const portal = buildPortalSummary(context.principal, dbPortalState);

  return {
    ok: true,
    source: 'db',
    portal,
    users: users.map(maskPortalUser),
    threadBindings,
    settings
  };
}

function hasMeaningfulCatalogData(result) {
  return Boolean(
    (result.portal?.departments?.length || 0) > 0 ||
    (result.portal?.channels?.length || 0) > 0 ||
    Object.keys(result.threadBindings || {}).length > 0 ||
    (result.users?.length || 0) > 0
  );
}

function buildJsonOpsOverview(context) {
  const bindings = Object.values(context.portalState.threadBindings || {}).filter((item) => !item.departmentId || context.visibleDeptIds.has(String(item.departmentId)));
  const users = (context.portalState.users || []).filter((item) => (item.departmentIds || []).some((deptId) => context.visibleDeptIds.has(String(deptId))));
  return {
    ok: true,
    source: 'json',
    stats: {
      departments: context.visibleDeptIds.size,
      users: users.length,
      openThreads: bindings.filter((item) => String(item.queueStatus || '') === 'open').length,
      pendingThreads: bindings.filter((item) => String(item.queueStatus || '') === 'pending').length,
      unassignedThreads: bindings.filter((item) => !item.assignedUserId).length
    },
    presence: users.map((item) => ({
      id: item.id,
      username: item.username,
      displayName: item.displayName,
      derivedStatus: derivePresenceStatus({ declaredStatus: item.status, lastActiveAt: item.lastActiveAt, forceOfflineUntil: item.forceOfflineUntil }),
      openThreads: bindings.filter((binding) => String(binding.assignedUserId || '') === String(item.id) && String(binding.queueStatus || '') === 'open').length
    })),
    queue: bindings.filter((item) => String(item.queueStatus || '') === 'pending')
  };
}

async function buildDbOpsOverview(db, context) {
  const departmentCodes = Array.from(context.visibleDeptIds);
  const bindingsResult = await db.query(
    `select tb.thread_id, tb.queue_status, tb.priority,
            tb.sla_first_response_due_at, tb.sla_next_response_due_at,
            tb.last_routing_action, tb.last_routing_reason, tb.last_routing_context_json,
            u.username as assigned_user_id, d.code as department_id, c.code as channel_id
     from thread_bindings tb
     left join departments d on d.id = tb.department_id
     left join channels c on c.id = tb.channel_id
     left join users u on u.id = tb.assigned_user_id
     where tb.department_id is null or d.code = any($1::text[])
     order by tb.updated_at desc`,
    [departmentCodes]
  );
  const usersResult = await db.query(
    `select distinct u.id::text as id, u.username, u.display_name, u.status, u.last_active_at, u.force_offline_until
     from users u
     join user_departments ud on ud.user_id = u.id
     join departments d on d.id = ud.department_id
     where d.code = any($1::text[])
     order by u.username asc`,
    [departmentCodes]
  );

  const bindings = (bindingsResult.rows || []).map((row) => ({
    threadId: row.thread_id,
    queueStatus: row.queue_status,
    assignedUserId: row.assigned_user_id || null,
    departmentId: row.department_id || null,
    channelId: row.channel_id || null,
    priority: row.priority || 'normal',
    slaFirstResponseDueAt: row.sla_first_response_due_at || null,
    slaNextResponseDueAt: row.sla_next_response_due_at || null,
    lastRoutingAction: row.last_routing_action || null,
    lastRoutingReason: row.last_routing_reason || null,
    lastRoutingContext: row.last_routing_context_json || null
  }));
  const users = (usersResult.rows || []).map((row) => ({
    id: row.username || String(row.id),
    username: row.username,
    displayName: row.display_name,
    status: row.status,
    lastActiveAt: row.last_active_at,
    forceOfflineUntil: row.force_offline_until
  }));

  return {
    ok: true,
    source: 'db',
    stats: {
      departments: context.visibleDeptIds.size,
      users: users.length,
      openThreads: bindings.filter((item) => String(item.queueStatus || '') === 'open').length,
      pendingThreads: bindings.filter((item) => String(item.queueStatus || '') === 'pending').length,
      unassignedThreads: bindings.filter((item) => !item.assignedUserId).length
    },
    presence: users.map((item) => ({
      id: item.id,
      username: item.username,
      displayName: item.displayName,
      derivedStatus: derivePresenceStatus({ declaredStatus: item.status, lastActiveAt: item.lastActiveAt, forceOfflineUntil: item.forceOfflineUntil }),
      openThreads: bindings.filter((binding) => String(binding.assignedUserId || '') === String(item.id) && String(binding.queueStatus || '') === 'open').length
    })),
    queue: bindings.filter((item) => String(item.queueStatus || '') === 'pending')
  };
}

function hasMeaningfulOpsData(result) {
  return Boolean(
    (result.stats?.users || 0) > 0 ||
    (result.stats?.openThreads || 0) > 0 ||
    (result.stats?.pendingThreads || 0) > 0
  );
}

function buildJsonActivity(context, limit) {
  return {
    ok: true,
    source: 'json',
    items: (context.portalState.recentActivity || [])
      .filter((item) => !item.departmentId || context.visibleDeptIds.has(String(item.departmentId)))
      .slice(0, limit)
  };
}

async function buildDbActivity(db, context, limit) {
  const result = await db.query(
    `select id, actor_user_id, action, resource_type, resource_id, department_id, payload_json, source, created_at, recorded_at
     from portal_event_journal
     where department_id is null or department_id = any($1::text[])
     order by created_at desc
     limit $2`,
    [Array.from(context.visibleDeptIds), limit]
  );
  return {
    ok: true,
    source: 'db',
    items: (result.rows || []).map((row) => ({
      id: row.id,
      actorUserId: row.actor_user_id,
      action: row.action,
      resourceType: row.resource_type,
      resourceId: row.resource_id,
      departmentId: row.department_id,
      payload: row.payload_json || {},
      source: row.source || 'portal',
      createdAt: row.created_at,
      recordedAt: row.recorded_at
    }))
  };
}

function filterThreadBindings(context) {
  const principalUserId = String(context.principal?.userId || context.principal?.username || '');
  const entries = Object.entries(context.portalState.threadBindings || {}).filter(([, binding]) => {
    if (context.canReadAll) return true;
    if ((context.principal?.roles || []).includes('manager')) return binding.departmentId && context.visibleDeptIds.has(String(binding.departmentId));
    if ((context.principal?.roles || []).includes('staff')) return String(binding.assignedUserId || '') === principalUserId;
    return false;
  });
  return Object.fromEntries(entries.map(([threadId, binding]) => [threadId, context.canReadAll ? binding : maskThreadBinding(binding)]));
}

function maskThreadBinding(binding) {
  return {
    threadId: binding.threadId,
    departmentId: binding.departmentId || null,
    channelId: binding.channelId || null,
    assignedUserId: binding.assignedUserId || null,
    queueStatus: binding.queueStatus || null,
    priority: binding.priority || 'normal',
    slaFirstResponseDueAt: binding.slaFirstResponseDueAt || null,
    slaNextResponseDueAt: binding.slaNextResponseDueAt || null,
    updatedAt: binding.updatedAt || null
  };
}

function maskPortalSettings(settings) {
  return {
    staffCanSeeUnassigned: Boolean(settings.staffCanSeeUnassigned),
    autoRouteIncomingMessages: settings.autoRouteIncomingMessages !== false,
    defaultDepartmentId: settings.defaultDepartmentId || null,
    routingMode: settings.routingMode || 'least_connections'
  };
}

function maskPortalUser(user) {
  return {
    ...user,
    permissions: [],
    passwordHash: undefined,
    dbUserPk: undefined,
    sessionVersion: undefined
  };
}
