# Account isolation

Each Zalo account owns a separate `accountStateById` bucket containing contacts,
threads, messages, labels, Zalo metadata and session details. The legacy root
fields are only a projection. Changing a browser selection never disconnects
another account or changes another operator's request context.

HTTP requests use `X-Zalo-Account-Id`; SSE and media use `accountId`. Conflicting
header, query and body selectors are rejected. Account membership and operator
status are checked server-side. Staff require explicit channel membership and
thread assignment; a department alone does not grant staff account access.
The portal JSON read model remains authoritative for non-admin account filtering.

AsyncLocalStorage pins provider calls and background listener processing to the
source account. Listeners persist and emit events even when nobody is viewing
that account. SSE filters account and thread permissions before serialization.
Frontend switching clears message, search, profile, forward, image and draft
view state and rejects responses from the previous account. Drafts are keyed by
account plus thread. New uploads have ownership sidecars; unowned legacy uploads
are denied rather than assumed to belong to the current account.

## Verification

Run `npm run check`, `npm run test:account-isolation`,
`node --test test/account-recovery.test.mjs`, and `npm run test:chatbot-bridge`.
The isolation suite uses synthetic data and an isolated mock server, never
production Zalo sends. It tests concurrent operators, identical thread IDs,
background ingest, persistence, SSE, scope denial and revoked operators.

Run `node --test test/new-account-isolation.test.mjs` for sequential onboarding
of four synthetic accounts, empty initial data/metadata, same-ID isolation,
background writes to an older account and persistence after reopening the store.
Store initialization and default merging clone templates so newly created buckets
cannot inherit mutations from an earlier account or a fresh store instance.

## Approved legacy recovery, 2026-10-02

Old data was already duplicated across buckets. Prevention alone cannot establish
ownership of that history. The operator approved reversible quarantine, including
the risk of temporarily hiding legitimate history whose origin is uncertain.

`scripts/quarantine-account-overlap.mjs` requires a verified single-account
baseline to identify the original source bucket. It leaves that bucket unchanged,
quarantines overlapping legacy threads in the other buckets, retains unique
threads, and clears uncertain labels and metadata for authoritative resync.
Overlap is a quarantine criterion, not proof of foreign ownership. Shared groups
may legitimately reappear after each account independently fetches its own data.
Group history is refetched by the existing provider; historical direct messages
cannot necessarily be reconstructed by zca-js and remain in the secure archive.

Stop only the application service before applying recovery. Back up the full data
directory, source and current image. Run without `--apply` first to inspect counts:

```
node scripts/quarantine-account-overlap.mjs STATE SINGLE_ACCOUNT_BASELINE ARCHIVE
```

The apply mode writes a private original-state archive and manifest before an
atomic state replacement, refuses an existing recovery marker, and must not run
while the service writes state. Never commit archives, credentials, portal data,
customer content or runtime state to Git.

For rollback, stop the application, archive its post-deployment data, restore the
known-good source/image and stopped-state backup, then start only that service.
Restoring old state also restores the old contamination and can lose newer events;
prefer selective account-aware restoration from the quarantine archive after
verifying provenance. Do not automatically replay archived events to AI/webhooks.
