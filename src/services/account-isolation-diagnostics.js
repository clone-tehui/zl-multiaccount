// Read-only account inventory diagnostics. No account/session mutation.
// Caller must authenticate normal session first, pass principal, and never expose raw results.
export async function diagnoseAccountIsolation(provider, state, principal) {
  if (!(principal?.roles || []).includes('admin')) {
    const error = new Error('Forbidden'); error.statusCode = 403; throw error;
  }
  const results = [];
  for (const accountId of Object.keys(state.accounts || {})) {
    const api = typeof provider.getAccountApi === 'function' ? provider.getAccountApi(accountId) : null; // strict existing account client, no login
    const bucket = state.accountStateById?.[accountId] || {};
    const result = { ordinal: results.length, inventoryStatus: 'unavailable' };
    if (!api) { results.push(result); continue; }
    try {
      const [groups, friends] = await Promise.all([api.getAllGroups(), api.getAllFriends()]);
      if (!groups?.gridVerMap || typeof groups.gridVerMap !== 'object' || Array.isArray(groups.gridVerMap) || !Array.isArray(friends)) throw new Error('Invalid inventory response');
      const groupIds = new Set(Object.keys(groups.gridVerMap).map(String));
      const friendIds = new Set(friends.map(x => String(x?.userId || '')).filter(Boolean));
      let groupsPresent=0,groupsAbsentUncertain=0,directFriendPresent=0,directNonfriendUncertain=0,foreignDirectSenderRecords=0;
      const ownId=String(bucket.session?.account?.id || accountId);
      for (const [id, thread] of Object.entries(bucket.threads || {})) {
        if (thread.type === 'group') { if(groupIds.has(id))groupsPresent++;else groupsAbsentUncertain++; }
        if (thread.type === 'direct') {
          if(friendIds.has(id))directFriendPresent++;else directNonfriendUncertain++;
          foreignDirectSenderRecords+=(bucket.messages?.[id] || []).filter(m=>!['',ownId,id].includes(String(m?.senderId || ''))).length;
        }
      }
      Object.assign(result,{inventoryStatus:'success',groupCount:groupIds.size,friendCount:friendIds.size,groupsPresent,groupsAbsentUncertain,directFriendPresent,directNonfriendUncertain,foreignDirectSenderRecords});
    } catch { result.inventoryStatus='failed'; } // failure NEVER interpreted as empty inventory
    results.push(result);
  }
  return { accounts:results, warning:'Current membership absence does not establish foreign history. No state mutation performed.' };
}
