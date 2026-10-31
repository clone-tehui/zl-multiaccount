import fs from 'node:fs';
import path from 'node:path';

const PORTAL_STATE_REVISION = Symbol.for('zlsever.portalStateRevision');

export class PortalStore {
  constructor(baseDir, options = {}) {
    this.baseDir = baseDir;
    this.filePath = path.join(baseDir, 'portal.json');
    this.cachedState = null;
    this.cachedStatKey = null;
    this.revisionCounter = 0;
    fs.mkdirSync(baseDir, { recursive: true });
    if (!fs.existsSync(this.filePath)) this.write(buildDefaultPortalState(this.seedAdmin));
  }

  read() {
    try {
      const stat = fs.statSync(this.filePath);
      const statKey = `${stat.mtimeMs}:${stat.size}`;
      if (this.cachedState && this.cachedStatKey === statKey) {
        return this.cachedState;
      }
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      const merged = mergeDefaults(parsed, buildDefaultPortalState(this.seedAdmin));
      markPortalStateRevision(merged, ++this.revisionCounter);
      this.cachedState = merged;
      this.cachedStatKey = statKey;
      return merged;
    } catch {
      const fallback = buildDefaultPortalState(this.seedAdmin);
      markPortalStateRevision(fallback, ++this.revisionCounter);
      this.cachedState = fallback;
      this.cachedStatKey = null;
      return fallback;
    }
  }

  write(nextState) {
    fs.writeFileSync(this.filePath, JSON.stringify(nextState, null, 2));
    const stat = fs.statSync(this.filePath);
    markPortalStateRevision(nextState, ++this.revisionCounter);
    this.cachedState = nextState;
    this.cachedStatKey = `${stat.mtimeMs}:${stat.size}`;
    return nextState;
  }

  update(mutator) {
    const state = this.read();
    const nextState = mutator(state) || state;
    return this.write(nextState);
  }
}

export function getPortalStateRevision(state) {
  return Number(state?.[PORTAL_STATE_REVISION] || 0);
}

function markPortalStateRevision(state, revision) {
  if (!state || typeof state !== 'object') return state;
  Object.defineProperty(state, PORTAL_STATE_REVISION, {
    value: Number(revision || 0),
    enumerable: false,
    configurable: true,
    writable: true
  });
  return state;
}

function buildDefaultPortalState(seedAdmin) {
  return {
    users: [],
    departments: [
      { id: 'default', code: 'default', name: 'Default', managerUserIds: [], active: true }
    ],
    channels: [],
    threadBindings: {},
    recentActivity: [],
    settings: {
      staffCanSeeUnassigned: false,
      autoBindUnassignedThreads: true,
      autoRouteIncomingMessages: true,
      defaultDepartmentId: 'default',
      stickyAssignment: true,
      routingMode: 'least_connections'
    },
    updatedAt: new Date().toISOString()
  };
}

function mergeDefaults(value, defaults) {
  if (Array.isArray(defaults)) return Array.isArray(value) ? value : defaults;
  if (defaults && typeof defaults === 'object') {
    const out = { ...defaults };
    for (const key of Object.keys(value || {})) out[key] = mergeDefaults(value[key], defaults[key]);
    return out;
  }
  return value ?? defaults;
}
