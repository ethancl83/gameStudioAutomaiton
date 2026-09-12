# Focused verification of four backend/store P1 fixes

Task: `task_c1c1faf864d8`  
Prior report: `/tmp/appops-backend-store-final-review-task_d332c41ae5fa.md`  
Verdict: **No remaining actionable finding in the four corrected boundaries.**

This was a read-only verification after the coordinator sent `finished-final-pass`. No implementation file, live account, credential, or external provider state was modified.

## Independent verification results

- Focused command:
  `node --import tsx --test tests/demo-workflows.test.ts tests/play-edit-recovery.test.ts tests/pipeline-runner-selection.test.ts tests/store-extensions.test.ts tests/store-connectors.test.ts tests/remote-runner.test.ts`
- Result: **66 passed, 0 failed**.
- Typecheck command: `npm run typecheck`.
- Result: both TypeScript checks passed (`tsc --noEmit` and `tsc -p tsconfig.node.json --noEmit`).
- Ancillary focused command: `node --import tsx --test tests/marketing-social-extensions.test.ts`.
- Result: **13 passed, 0 failed**.
- The completed full-suite log `/tmp/appops-full-v3.log` records **246 passed, 0 failed**.

The new negative tests exercise externally observable boundaries rather than merely repeating implementation predicates: the server test sends raw HTTP request targets, Play tests record the concrete edit request sequence and checkpoints, Apple tests supply cross-app JSON:API relationship evidence and assert zero writes, and the pipeline test uses a real `Store` plus `ReleasePipelines` with multiple runner states/platforms.

## P1-1 Apple resource ownership — verified fixed

- Ownership helpers now fail closed in `packages/connectors/store-apple-ops.ts:42-162`:
  - versions are resolved with the documented `include=app` relationship (`:46-65`),
  - builds and beta groups use their `/relationships/app` linkage (`:67-83`),
  - version and app-info localizations are checked against both parent ID and requested locale (`:85-125`),
  - review submissions are tied to the resolved app (`:127-146`), and
  - phased releases are tied to the selected version (`:148-162`).
- The checks occur before writes at the relevant call sites: version creation with build (`:215-220`), listing reads/updates (`:255-260`, `:322-330`), app-info updates (`:382-399`), TestFlight distribution (`:510-518`), build linking (`:544-551`), review submission (`:570-578`), release/phased release (`:680-696`, `:752-758`), and review reconciliation (`:779-784`).
- `tests/store-extensions.test.ts:499-553` proves same-app IDs continue to work. `tests/store-extensions.test.ts:555-653` supplies foreign version, localization, app-info, build, beta-group, phased-release, and review IDs and asserts that no write is sent; `:655-684` also proves missing official linkage fails closed.
- Apple’s current primary documentation confirms these relationships and include values, including [reading an App Store version with `include=app`](https://developer.apple.com/documentation/appstoreconnectapi/get-v1-appstoreversions-_id_), [reading a version localization with `include=appStoreVersion`](https://developer.apple.com/documentation/appstoreconnectapi/get-v1-appstoreversionlocalizations-_id_), [reading an app-info localization with `include=appInfo`](https://developer.apple.com/documentation/appstoreconnectapi/get-v1-appinfolocalizations-_id_), and [reading a review submission with `include=app`](https://developer.apple.com/documentation/appstoreconnectapi/get-v1-reviewsubmissions-_id_).

## P1-2 Apple review-state false success — verified fixed

- `packages/connectors/store-apple-ops.ts:164-175` now has one shared exhaustive outcome mapper. Only `COMPLETE` confirms success; `UNRESOLVED_ISSUES` fails; documented pending/canceling states wait; `READY_FOR_REVIEW`, missing, and unknown values remain unresolved rather than succeeding.
- Both initial submit (`packages/connectors/store-apple-ops.ts:630-652`) and reconciliation (`:779-797`) use that mapper.
- `tests/store-extensions.test.ts:686-777` drives documented terminal/pending states plus `READY_FOR_REVIEW`, a synthetic unknown state, and a missing state through both paths. The assertions distinguish `confirmed`, `failed`, `waitingExternal`, and `unresolved`, so a truthy/falsey shortcut cannot satisfy the test accidentally.
- Apple’s [Review Submissions documentation](https://developer.apple.com/documentation/appstoreconnectapi/review-submissions) and its current list/read endpoint documentation enumerate the handled state set.

## P1-3 Google Play edit cleanup and commit uncertainty — verified fixed

- `packages/connectors/store-play-edits.ts:77-100` centralizes mutating edit lifecycle handling. Failures before commit trigger DELETE; successful cleanup returns a confirmed failed result; cleanup failure remains action-required; once commit starts, the code neither discards nor resends an edit whose live result may be unknown.
- `packages/connectors/store-play-edits.ts:102-112` no longer swallows cleanup errors and checkpoints `edit-cleanup-required`. Read-only listing still uses `finally`, so it can report success only after cleanup (`:144-177`). Listing update, image upload, and release promotion all use the lifecycle wrapper (`:180-202`, `:204-247`, `:273-345`).
- `packages/connectors/store-play-edits.ts:114-123` reconciles a failed read/pre-commit cleanup using GET only. `apps/controller/service.ts:578-580` routes these exact states to that read-only reconciliation; an uncertain post-commit result reaches the explicit manual-confirmation fallback at `apps/controller/service.ts:627-628` and is never automatically resent.
- `tests/play-edit-recovery.test.ts:7-19` reproduces DELETE-response loss and proves a success cannot be returned and rechecking performs no write. `tests/play-edit-recovery.test.ts:21-33` injects failures at PUT, validate, commit, and cleanup, proving exactly one pre-commit DELETE, zero DELETE after commit starts, and distinct final checkpoints.

The intentionally manual post-commit case is honest: a lost commit response cannot be distinguished safely from a completed provider write using the edit ID alone, so the application preserves action-required state and avoids duplicate or destructive recovery.

## P1-4 demo/live URL normalization — verified fixed

- `apps/controller/server.ts:73-80` validates the wire request path before WHATWG URL parsing. Dot segments, percent-encoded path bytes, backslashes, duplicate separators, and absolute-form targets are rejected before demo/live mode selection at `:102-109`.
- `tests/demo-workflows.test.ts:118-124` sends literal and encoded traversal variants, a backslash variant, duplicate slash, encoded namespace text, and an absolute-form target over raw `node:http`; all return HTTP 400 `INVALID_PATH`, after which live state remains empty and demo state remains seeded.
- This independently closes the original reproduction `/api/demo/../state`, which previously normalized to the live `/api/state` route.

## iOS pipeline runner selection — verified

- `apps/controller/pipelines.ts:39-45` waives only the specific local `ios.requires_macos` inspection error, and only when the explicitly selected registered runner is both `ready` and `darwin`. Other inspection errors remain blocking, and the selected `runnerId` is persisted into the build input.
- `tests/pipeline-runner-selection.test.ts:10-25` uses a real store and proves missing selection, unavailable Mac, Linux runner, and unrelated inspection errors are rejected; the ready Mac runner queues exactly one build.

## Ancillary checks requested by the coordinator

- Demo seed migration at `apps/controller/demo.ts:28-38` inserts only absent synthetic `creative`/`news` rows. An independent temporary-store reproduction changed an existing creative name to `USER-EDIT`, removed one news row, and invoked `seed()` again; the creative remained `USER-EDIT`, the news row was restored, and the existing five projects/nine connections remained intact.
- AdMob app-state and SDK guidance remain read-only and distinguish linked/manual apps: `packages/connectors/admob.ts:54-75`, `:176-179`, and `packages/connectors/sdk-integration.ts:35-76`. The 13-test ancillary rerun includes the platform-specific Android/iOS guidance, secret non-disclosure, and non-`ACTIVE` pending approval cases.
- Releases now displays both release and store-listing creative resources at `apps/desktop/src/views/ReleasesView.tsx:12-16`. Publish target changes clear the previously selected store connection at `apps/desktop/src/components/PublishFlow.tsx:123`, preventing a stale incompatible provider selection; the typecheck covers these UI paths.

## Conclusion

All four previously reported P1 reproductions are closed in the settled code, and the new negative cases are behavior-level tests with meaningful failure injection. No additional actionable defect was found in this focused reread of the corrected backend/store boundaries.
