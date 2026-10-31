# Sanitized source snapshot — 2026-10-31

Source-only snapshot of zlsever at release `20261031-calls`; owner approved publication of a sanitized copy on 2026-10-31 at14:38 ICT. This root commit has no parents and does not inherit existing main history. It is not a production deployment or an exact unmodified live backup.

## Provenance

95 allowlisted files came from VPS host `/opt/zlsever`; 78 src/public/scripts files plus two package files matched container bytes. Host has no Git metadata; no live Git commit is asserted. Seven supplemental local test/docs and four existing remote files absent from host complete the106-file base candidate. See `source-provenance.json` for per-file hashes/origin. Supplemental files are not claimed deployed. No local Studio v2 assets were substituted for live workspace source.

## Exact intentional differences from the live source

- `src/server.js`, `getChiHomeLookupPrincipal`, original lines1899–1900: replace the accepted-secret set (env plus hardcoded credential) and membership check with `if (!chiHomeBookingBridgeSecret || !provided || provided !== chiHomeBookingBridgeSecret) return null;`. No credential value is reproduced here. Existing env reading trims whitespace and defaults to empty. Compat/session authentication remains independent.
- `.env.example`: append an optional empty `CHIHOME_BOOKING_BRIDGE_SECRET=` entry and configuration comments. No real credential or insecure fallback is supplied.
- Added only to this publication: `test/chihome-lookup-auth.test.mjs`, this document, `API-WEBHOOK-CONTRACT.md`, `api-inventory.json`, `source-provenance.json`. The pre-existing supplemental files retain their origin labels.

To reproduce the sanitized base, apply the one-function gate change and example-env addition to the private original source snapshot; hashes identify all other unchanged candidate files. The original private source evidence is retained locally, never included in this Git branch.

## Validation and limits

69 JS/MJS files and27 synthetic tests passed in the prior candidate; unchanged file hashes allow reuse. The publication reruns that suite plus3 new auth/env tests and syntax checks. New tests execute the exact source auth function with synthetic env/requests in a VM, including positive/negative configuration and supported input paths. No real send, webhook, QR/login, or business API call is used. API/webhook contracts and known coverage gaps are documented separately.

Offline heuristic scanning, exact known-literal exclusion and manual authentication review cover the allowlist, working tree, index and every object reachable from the new branch. Heuristic scanning cannot prove that all unknown secrets are absent. No production data, real env, credential attachments, cookies, customer history, uploads, backups, dependencies or build output are included.

## Remaining security followups

Existing public main/history still contains a credential; this branch does not remediate that exposure. Rotation/revocation, production auth/config changes and historical remediation are separate owner-scoped followups and have not been performed. Production code/config/data/container remain unchanged. Do not merge old history into this clean branch. Repository visibility/default branch are unchanged; no force push or history rewrite is authorized.
