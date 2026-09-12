# Final bounded verification: build credentials and social fixes

Date: 2026-09-11 (Asia/Seoul)  
Scope: only the four findings in `/tmp/appops-key-social-review.md` plus the Threads terminal-status flow requested by the coordinator. No repository files were changed, no Git command was used, and no real account, key, post, upload, or spend was involved.

## Result

Verified: all four original findings are fixed in the current code, and the Threads terminal negative-result flow is closed correctly. I found no remaining actionable flaw in this bounded review.

## 1. Android certificate acceptance and AAB verification — verified fixed

- `packages/build-credentials/index.ts:53-58` parses both certificate bounds, rejects non-finite or future `validFrom`, rejects expired certificates, and requires `validTo` after the end of 2033-10-22 UTC.
- The same certificate predicate is applied at registration (`packages/build-credentials/index.ts:100-105`) and immediately before artifact signing (`packages/build-credentials/build.ts:80-83`), so a previously stored invalid certificate cannot bypass the current policy.
- Registration verification uses `jarsigner -verify -strict` with the selected keystore and alias (`packages/build-credentials/index.ts:103-105`). AAB verification does the same and then confirms that every certificate found in the signed artifact matches the captured fingerprint (`packages/build-credentials/build.ts:84-90`).
- `tests/build-credentials.test.ts:67-87` exercises a real long-lived P12 and real AAB-format JAR signing. `tests/build-credentials.test.ts:100-121` rejects future-start, short-lived, and prohibited-key-usage certificates and confirms invalid stored keys do not replace the source artifact.

## 2. Vault/metadata commit recovery and orphan cleanup — verified fixed

### Build credentials

- A new version is written to the vault first, then metadata and its event are published in one SQLite `writeBatch`; a synchronous publication failure compensates by removing the unpublished version (`packages/build-credentials/index.ts:128-137`, `packages/storage/index.ts:127-135`).
- Deletion enumerates `vault.listIds()` in addition to metadata versions, so versions beyond the published pointer are not skipped (`packages/credentials/vault.ts:178-182`, `packages/build-credentials/index.ts:146-150`).
- Startup cleanup removes versioned records with absent metadata or a version greater than the committed metadata pointer, and resumes tombstoned deletions (`packages/build-credentials/index.ts:184-191`).
- `tests/build-credentials.test.ts:40-64` injects metadata/event failure, verifies synchronous compensation, forces compensation failure, verifies startup orphan cleanup, and verifies deletion removes an unpublished higher version.

### Connection credentials

- `commitConnection` first stores a durable public `connection-commit` intent containing a unique random marker, writes that marker inside the authenticated vault ciphertext, then atomically publishes connection metadata + event while removing the intent (`apps/controller/service.ts:192-201`).
- Recovery is invoked on both service start and state reads (`apps/controller/service.ts:70-72`, `apps/controller/service.ts:100-102`). Under the per-connection lock it publishes only when the authenticated marker matches; otherwise it discards the unfulfilled intent without publishing stale metadata (`apps/controller/service.ts:203-223`). Connection add/update/OAuth completion also use the same connection locks (`apps/controller/service.ts:225-244`, `apps/controller/service.ts:372-401`).
- `tests/credential-commit.test.ts:11-44` fails the final event insert after one synthetic OAuth exchange, restarts the service/store, recovers through `state()`, observes exactly one connection/event and exactly one exchange, and verifies neither tokens nor the internal marker become public. `tests/credential-commit.test.ts:46-59` confirms a failed vault update cannot publish metadata for old ciphertext.

## 3. Steam AppID identity and attribution — verified fixed

- The adapter resolves the requested AppID and places it in every normalized news resource; provider envelope/item AppID mismatches are rejected (`packages/social/steam.ts:18-73`).
- The bridge chooses explicit action input first, then the selected project's numeric identifier, then connection credential/AppID fallbacks (`packages/connectors/social.ts:47-54`).
- Persistence includes AppID in Steam-news identity and gives a unique identifier match priority; an explicit unmatched or ambiguous identifier remains unassigned instead of falling through to channel heuristics (`apps/controller/service.ts:465-481`).
- `tests/credential-commit.test.ts:61-83` uses one shared connection for projects 440 and 570 plus explicit AppID 730, verifies exact project attribution for 440/570, null attribution for 730, and separate resources even when the provider news ID repeats. Connector-level AppID propagation/mismatch tests also pass.

## 4. Ordered social quota admission — verified fixed

- `Store.socialWrites` returns qualifying reservations/effects in durable `created_at, rowid` order (`packages/storage/index.ts:172-177`).
- `SocialAutomation.enforceWrite` admits a prepared current run based only on earlier prepared reservations while continuing to count confirmed or unresolved/dispatched effects (`apps/controller/social-automation.ts:40-55`). This makes the oldest reservation deterministic across different connection locks and prevents both concurrent channels from rejecting each other.
- `tests/social-automation.test.ts:69-85` lowers the cap after two durable reservations, evaluates the newer run first, and confirms only the oldest can proceed before and after dispatch/success.

## 5. Threads readiness and terminal negative status — verified fixed

- Readiness polling uses fixed module-owned bounds of 60 seconds, six reads, and five minutes (`packages/social/threads.ts:25-33`, `packages/social/threads.ts:145-173`). Only normalized `FINISHED` permits one publish; `ERROR`/`EXPIRED` are terminal failures, while `IN_PROGRESS`, unknown/exhausted, abort, and unexpected `PUBLISHED` remain unresolved without publishing (`packages/social/threads.ts:115-120`, `packages/social/threads.ts:208-243`).
- Read-only reconcile maps `PUBLISHED` to confirmed and `ERROR`/`EXPIRED` to failed without requesting or surfacing provider `error_message` and without calling publish (`packages/social/threads.ts:312-327`). The controller maps direct terminal failure to run `failed` with `effectResolved`, and storage converts a dispatched effect to `resolved_failed`; reconciliation applies the same terminal effect state (`apps/controller/service.ts:428-455`, `apps/controller/service.ts:523-527`, `packages/storage/index.ts:219-235`, `packages/storage/index.ts:262-275`).
- A `resolved_failed` effect is excluded from later quota reservations and cannot be automatically retried (`packages/storage/index.ts:172-177`, `packages/storage/index.ts:252-259`). `tests/credential-commit.test.ts:85-110` confirms no publish, run `failed`, effect `resolved_failed`, no leaked provider error, retry rejection, and freed quota. Connector regressions cover FINISHED-only publish, bounded unresolved polling, abort, ERROR, and read-only reconciliation.

## Focused verification run

Command:

```text
node --import tsx --test tests/build-credentials.test.ts tests/credential-commit.test.ts tests/social-automation.test.ts tests/social-connectors.test.ts
```

Result: **48 passed, 0 failed, 0 skipped** in 34.1 seconds. This includes the corrected Threads credential fixture using millisecond timestamps.

The full suite, repository typecheck, package, and documentation checks were intentionally not duplicated because the coordinator is running those concurrently; this conclusion is limited to the requested fixes and targeted regressions.
