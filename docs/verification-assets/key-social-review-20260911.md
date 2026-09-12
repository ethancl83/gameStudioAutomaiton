# Build credentials + social orchestration final review

Review date: 2026-09-11 (Asia/Seoul). Scope was limited to `packages/build-credentials/**`, controller build-key/captured-version/signing integration, `packages/storage` social writes, `apps/controller/social-automation.ts`, and the social OAuth/connector bridge. Repository files were not changed; the only new executable probe is `/tmp/appops-key-social-probe.ts`.

## Executive result

Four material findings remain: two P1 release/security-lifecycle defects and two P2 social reliability/attribution defects. No P0 issue was found. The current SSH pinning/clone isolation, captured key-version selection, secret-file arguments, tmpfs cleanup, write-effect journal, provider-origin pinning, account ownership checks, reply target scope, ambiguous publish handling, and token-rotation serialization behaved as intended in the reviewed paths.

## P1 — Android credentials that are not yet valid and expire before Play's required date are accepted and used to produce an “accepted” AAB

**Impact.** A key can pass registration and `signAndroidArtifact`, while being unusable now or rejected for Google Play release. This turns a deterministic prerequisite error into a late upload/release failure after a build has already been produced.

**Evidence.** `packages/build-credentials/index.ts:93-100` parses the certificate but checks only `validTo > Date.now()`; it never checks `validFrom` and accepts any future expiry. `packages/build-credentials/build.ts:80-86` runs `jarsigner -verify` without a warning policy/`-strict`, then accepts the literal success text and matching certificate. Oracle documents that not-yet-valid certificates and unsigned entries are severe warnings that still return exit code 0 unless `-strict` is used: <https://docs.oracle.com/en/java/javase/24/docs/specs/man/jarsigner.html>. Android's current official signing guidance says a Google Play signing key must expire after 22 October 2033: <https://developer.android.com/studio/publish/app-signing>.

**Direct reproduction.** `node --import tsx /tmp/appops-key-social-probe.ts` generates a synthetic P12 with `-startdate +1d -validity 30`. Current code reports `{ accepted: true, signedFormat: "aab", expiresAt: "2026-10-12..." }`: both registration and the complete AAB signing/verification path succeed even though the certificate is not yet valid and expires years before the documented Play threshold. The existing `tests/build-credentials.test.ts:59-69` also deliberately generates a 30-day certificate and expects registration/signing success, so the current positive test cements the wrong release prerequisite.

**Fix sketch.** At registration, require finite `validFrom`/`validTo`, `validFrom <= now`, and—when this credential is intended for Play—`validTo > 2033-10-22` (or model a non-Play Android credential explicitly rather than presenting it as Play-ready). Make AAB verification inspect severe warning classes and reject not-yet-valid, expired, bad-key-usage, unsigned-entry, and wrong-alias cases; do not blindly fail the expected self-signed-chain/no-timestamp informational case. Add generated future-start and short-validity negative tests, plus a valid long-lived positive test.

## P1 — Vault writes and SQLite metadata are not one recoverable commit; failures orphan secrets and consume OAuth state

**Impact.** A reported-failed build-key rotation can leave an encrypted version that deletion can never discover, violating complete key cleanup. A reported-failed new social OAuth callback can leave usable tokens in the vault with no `Connection` metadata, while the callback state is already consumed and cannot be retried; existing-connection rotation can similarly make the vault and UI state disagree.

**Evidence.** `packages/build-credentials/index.ts:121-124` writes the versioned vault record, then independently writes credential metadata and an event. Deletion at `packages/build-credentials/index.ts:127-136` removes only versions `1..metadata.version`, so a vault version written before a failed metadata update is permanently skipped. Social OAuth consumes/deletes state at `apps/controller/service.ts:338-343`, writes the unversioned vault record at `apps/controller/service.ts:349-350`, and only afterward writes/resumes connection metadata at `apps/controller/service.ts:351-353`.

**Direct reproduction.** The `/tmp` probe injects a one-shot `Store.put('build-credential')` failure after a synthetic SSH rotation: metadata remains version 1, `build-key-…-v2` exists, and `remove()` reports success while version 2 still exists. It separately injects `Store.put('connection')` failure after an X OAuth exchange using only injected HTTP; output is `{ secretExists: true, metadataExists: false, retryCode: "OAUTH_EXPIRED" }`.

**Fix sketch.** Use a durable SQLite intent/pointer protocol around versioned vault records: persist a pending transition containing old/new vault IDs, write the new ciphertext, atomically publish metadata/event and clear the intent, then recover or compensate pending intents at startup. Version social credentials too, so metadata points at the committed version and an interrupted rotation can restore the old pointer; for a synchronous pre-publication failure, remove the new build-key record (or new-connection vault record) before returning. Ensure event insertion cannot turn an already-published metadata update into an API-visible false failure. Add fault injection at every boundary, including process restart, and assert both no secret orphan and callback/update resumability.

## P2 — Steam news discards the selected AppID and then bypasses identifier attribution for all social resources

**Impact.** A Steam connection shared by two projects stores project-requested news with `projectId: null`, so the project community view cannot reliably show its news. With one linked project, a manually supplied different `appId` can instead be heuristically attributed to that sole project because the selected ID is not preserved.

**Evidence.** `packages/social/steam.ts:50-63` resolves the exact AppID and includes it only in the summary; `newsResource` at `packages/social/steam.ts:32-47` omits it from resource data. The bridge chooses an AppID at `packages/connectors/social.ts:47-53`. `apps/controller/service.ts:437-439` has exact identifier attribution, but the social branch at `apps/controller/service.ts:441-446` replaces that result with write/previous/parent/single-channel heuristics, rather than preserving an exact AppID match.

**Direct reproduction.** The injected-HTTP probe creates projects `440` and `570` sharing one synthetic Steam connection, runs project `440`'s `list-news`, and gets `{ requestedProject: "p440", persistedProjectId: null, resourceAppId: null }` even though the provider response and run summary identify AppID 440.

**Fix sketch.** Put the resolved AppID on every normalized news resource (`data.appId`) and preserve a unique identifier-derived `projectId` before social heuristics. If an identifier is present but does not uniquely match, keep the resource unassigned rather than falling back to the sole channel project. Include AppID in the resource identity if Steam `gid` is not contractually global across apps. Add shared-connection and explicit-mismatched-AppID integration tests.

## P2 — Lowering a project's daily cap below existing reservations rejects older work (and concurrent channels can reject all work)

**Impact.** Policy revalidation is safe against exceeding the new limit, but it has no admission order. Every queued/running post counts as a reservation against every other current post, so after lowering the limit the oldest work fails first; with two different-channel runs executing concurrently at a new limit of one, both can see the other reservation and both fail, publishing zero posts. Sequential execution eventually permits the newest run, contrary to durable FIFO intent.

**Evidence.** `apps/controller/social-automation.ts:44-47` counts all other active reservations and decides solely on aggregate length. `packages/storage/index.ts:171-175` returns active social writes without an “earlier than current” admission rule, while the queue is FIFO but can run different connection locks concurrently (`apps/controller/queue.ts:15,25-38`).

**Direct reproduction.** The `/tmp` probe creates three ordered synthetic posts under limit 3, lowers the policy to 1, and revalidates them. It reports the oldest and middle both rejected while overbooked; after settling failures, only `newest` is admitted. The same predicate applied to two concurrently running channel jobs rejects both before either status changes.

**Fix sketch.** Make quota admission transactional and ordered: count today's confirmed/unresolved effects plus only active reservations that precede the current run by a durable sequence/rowid, or explicitly reconcile excess un-dispatched reservations when saving a lower policy. Never cancel or retry a dispatched/unknown effect. Add a two-channel concurrency test and a lower-limit test asserting the oldest eligible reservation wins deterministically.

## Verification performed

- `node --import tsx --test tests/build-credentials.test.ts tests/social-automation.test.ts tests/social-connectors.test.ts tests/storage.test.ts tests/controller.test.ts` — 58/58 passed.
- `node --import tsx --test tests/build-credentials.test.ts tests/ssh-dependency.test.ts tests/social-automation.test.ts tests/social-connectors.test.ts` — 38/38 passed, including the newly present real loopback `ssh2` Git-fetch regression.
- `node --import tsx /tmp/appops-key-social-probe.ts` — reproduced all four findings using generated credentials, in-memory master keys, isolated `/tmp`/`/dev/shm` workspaces, and injected HTTP only.
- No real user key, external account, external SSH server, social post, store upload, or spend was used.

## Reviewed limits / non-findings

- The SSH wrapper fixes host/user/port through validated policy, uses strict host-key checking, disables agent/forwarding/proxies/password interaction, disables Git hooks/global config/submodules, and the loopback regression confirms the wrong host key fails before authentication. Dependency snapshots omit `.git`, `.env`, symlinks, and executable mode is included in snapshot hashes.
- Build engines do not receive build-key values. Key contents/passwords are placed in 0600 tmpfs files; subprocess argv receives file paths, not secret values; tool stderr is replaced with stable errors; secret workspaces are removed on success/failure/cancellation and namespaced startup cleanup exists.
- Trusted JDK/Android SDK executable identity still depends on process-level `APPOPS_JAVA_HOME`/`JAVA_HOME`/Android SDK configuration (`packages/build-credentials/tools.ts:21-26`, `packages/build-credentials/build.ts:48-60`). No project/action-input path to those variables was found, so this is recorded as a same-user/deployment trust assumption rather than a defect; there is no provenance/hash/ownership pin if that assumption changes.
- The AAB/JAR path and synthetic P12 were exercised. The APK `zipalign`/`apksigner` branch was not exercised in this environment because no SDK build-tools test fixture is present.
- Ambiguous X/Threads writes remain `action_required` without reposting; Threads container IDs are checkpointed before publish; account ownership and reply resource/project scope are rechecked immediately before dispatch. The concurrent social worker's token-reset/read-reconcile/owned-reply-field work was intentionally not duplicated or reported as a finding.
- Marketing findings and unrelated packages/UI were excluded. A full repository audit and full typecheck were intentionally not run; the user identified an unrelated temporary social partial-file typecheck condition.
