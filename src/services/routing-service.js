function toMillis(value) {
  const ts = value ? new Date(value).getTime() : 0;
  return Number.isFinite(ts) ? ts : 0;
}

function normalizePriority(priority) {
  return String(priority || 'normal');
}

function priorityWeight(priority) {
  switch (normalizePriority(priority)) {
    case 'vip':
      return 400;
    case 'complaint':
      return 300;
    case 'hot_lead':
      return 200;
    default:
      return 100;
  }
}

function resolveExclusionReason(candidate) {
  if (candidate?.status !== 'online') return 'status-not-online';
  if (candidate?.forceOfflineUntilExpired) return 'force-offline';
  if (candidate?.atCapacity) return 'at-capacity';
  return null;
}

function buildCandidateScore(candidate, openConversationCounts = new Map()) {
  const openCount = Number(openConversationCounts.get(String(candidate.id)) || 0);
  const lastAssignedAtMs = toMillis(candidate.lastAssignedAt);
  const routingWeight = Number(candidate?.routingWeight) || 100;
  const exclusionReason = resolveExclusionReason(candidate);
  return {
    ...candidate,
    openCount,
    routingWeight,
    lastAssignedAtMs,
    eligible: !exclusionReason,
    exclusionReason
  };
}

export function rankCandidates(candidates = [], openConversationCounts = new Map(), strategy = 'least_connections') {
  const scored = candidates.map((candidate) => buildCandidateScore(candidate, openConversationCounts));
  const eligible = scored.filter((item) => item.eligible);
  return eligible.sort((left, right) => {
    if (strategy === 'round_robin') {
      if (left.lastAssignedAtMs !== right.lastAssignedAtMs) return left.lastAssignedAtMs - right.lastAssignedAtMs;
      if (left.routingWeight !== right.routingWeight) return right.routingWeight - left.routingWeight;
      if (left.openCount !== right.openCount) return left.openCount - right.openCount;
      return String(left.id).localeCompare(String(right.id));
    }
    if (left.openCount !== right.openCount) return left.openCount - right.openCount;
    if (left.routingWeight !== right.routingWeight) return right.routingWeight - left.routingWeight;
    if (left.lastAssignedAtMs !== right.lastAssignedAtMs) return left.lastAssignedAtMs - right.lastAssignedAtMs;
    return String(left.id).localeCompare(String(right.id));
  });
}

export function selectAssignee(candidates = [], openConversationCounts = new Map(), strategy = 'least_connections') {
  return rankCandidates(candidates, openConversationCounts, strategy)[0] || null;
}

export function planRouting({ channel, candidates, openConversationCounts, thread = {} }) {
  const strategy = channel?.routingMode || 'least_connections';
  const allCandidates = candidates.map((candidate) => buildCandidateScore(candidate, openConversationCounts));
  const rankedCandidates = rankCandidates(candidates, openConversationCounts, strategy);
  const selected = rankedCandidates[0] || null;
  const context = {
    strategy,
    priority: normalizePriority(thread.priority),
    priorityWeight: priorityWeight(thread.priority),
    slaFirstResponseDueAt: thread.slaFirstResponseDueAt || null,
    slaNextResponseDueAt: thread.slaNextResponseDueAt || null
  };
  if (!selected) {
    return {
      action: 'queue',
      reason: 'no-online-agent',
      context,
      rankedCandidates: [],
      allCandidates
    };
  }
  return {
    action: 'assign',
    assigneeId: selected.id,
    reason: strategy,
    context,
    rankedCandidates,
    allCandidates
  };
}
