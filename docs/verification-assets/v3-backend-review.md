# Independent backend and store review

Task: `task_d332c41ae5fa`  
Scope: final read-only review after root declared the backend/store pass finished  
Workspace: `/home/ethancl/Workspace/automation`

## Verification performed

- Re-read `docs/demo-execution-contract.md`, plan v3, and the current controller, storage, remote-runner, runner, and store connector implementations.
- Re-ran the targeted suites with:
  `node --import tsx --test tests/demo-workflows.test.ts tests/remote-runner.test.ts tests/store-connectors.test.ts tests/store-extensions.test.ts`
- Result: 54 tests passed, 0 failed. The findings below are uncovered failure paths or missing negative cases; the passing suites do not exercise them.
- No live provider mutation or secret access was performed. A local temporary controller was used only for the URL-normalization reproduction.

## Findings

### P1 — Apple opaque resource IDs are not constrained to the selected project/app

Locations:

- `apps/controller/service.ts:323-340` queues store operations, while the scope gate at `apps/controller/service.ts:342-370` covers several project resources but not Apple provider IDs.
- `packages/connectors/store-apple-ops.ts:117-128` resolves the selected app but fetches caller-supplied `appStoreVersionId` through the global `/v1/appStoreVersions/{id}` endpoint without proving the version belongs to that app.
- `packages/connectors/store-apple-ops.ts:164-215` resolves an app, then PATCHes a caller-supplied global localization ID or POSTs under a caller-supplied version ID without validating the relationship.
- The same pattern occurs for app-info localization (`packages/connectors/store-apple-ops.ts:236-283`), beta group/build distribution (`packages/connectors/store-apple-ops.ts:369-397`), version/build linking (`packages/connectors/store-apple-ops.ts:400-420`), review submission (`packages/connectors/store-apple-ops.ts:423-475`), and release/phased-release operations (`packages/connectors/store-apple-ops.ts:530-617`).

Impact: an App Store Connect account can contain multiple apps. Selecting project/app A while supplying an opaque ID copied from app B can read or mutate B while the local run, audit record, and policy scope all say A. Some combined relationship writes may be rejected by Apple, but direct PATCH/release requests target the global resource itself and cannot rely on Apple to enforce the controller's selected-project intent.

Brief reproduction: use a fake transport that resolves `/v1/apps?...` to app A, call `updateAppleListing` with `localizationId=loc-B`, and observe a PATCH to `/v1/appStoreVersionLocalizations/loc-B` with no intervening ownership request. An equivalent release reproduction supplies a version from app B in `PENDING_DEVELOPER_RELEASE`; the code resolves app A separately and then posts the release request for B.

Action: validate the complete ownership chain before every global-ID read or mutation using app-scoped relationship/list endpoints: app → version/appInfo/betaGroup/build/reviewSubmission → localization/phasedRelease. Add multi-app negative tests asserting zero write requests when any supplied ID belongs to another app.

### P1 — Initial Apple review submission treats unresolved/canceling/unknown states as success

Locations:

- `packages/connectors/store-apple-ops.ts:486-503` marks only `WAITING_FOR_REVIEW`, `IN_REVIEW`, and `COMPLETING` as waiting and does not map `UNRESOLVED_ISSUES`, `CANCELING`, or an unknown future state to failure/action-required.
- `apps/controller/service.ts:517-519` marks every connector result that is not `unresolved`, `failed`, or `waitingExternal` as `succeeded`.
- `packages/connectors/store-apple-ops.ts:631-648` handles more states during later reconciliation, so initial submission and reconciliation currently disagree.

Impact: a submission response in `UNRESOLVED_ISSUES` or `CANCELING`—and any state newly added by Apple—can be recorded as successfully completed even though release is not accepted.

Brief reproduction: adapt the happy-path mock in `tests/store-extensions.test.ts:328-376` so the review PATCH returns `UNRESOLVED_ISSUES` or `CANCELING`, then execute it through `AppService`; the run becomes `succeeded`. At connector level, the result has `waitingExternal: false` and no `failed`/`unresolved` marker.

Action: use one exhaustive state mapper for submission and reconciliation. Only `COMPLETE` should confirm success; `UNRESOLVED_ISSUES` should be terminal failure; waiting/canceling states should remain pending or action-required; and unknown states must never default to success. Test every documented enum plus an unknown value. Reference: [Apple Review Submissions](https://developer.apple.com/documentation/appstoreconnectapi/review-submissions).

### P1 — Google Play temporary-edit cleanup can fail silently or leak edits after downstream errors

Locations:

- `packages/connectors/store-play-edits.ts:84-90` swallows every DELETE failure in `discardEdit`.
- `packages/connectors/store-play-edits.ts:111-144` returns `editDiscarded: true` before cleanup runs, so a failed discard still produces a confirmed successful result with a false summary.
- `packages/connectors/store-play-edits.ts:147-168`, `170-212`, and `238-308` create an edit but do not discard it when a later metadata write, image upload, validation, or commit step fails.
- `packages/connectors/store-play-edits.ts:58-74` can then translate a later 409 into action-required because an edit already exists, so the leaked edit can block subsequent work.

Impact: read-only listing can leave provider state behind while reporting cleanup succeeded. Mutating operations can also strand an open edit after an intermediate failure, after which the operation ledger is already dispatched/unknown and future operations may be blocked.

Brief reproduction: mock edit insertion as `edit-1`, let listing GET succeed, and throw `TEMPORARY` from DELETE; `listPlayListings` still reports `editDiscarded: true`. For an update path, throw from PUT or validate after insertion and assert that no DELETE request is made.

Action: distinguish pre-commit from post-commit failures. On every pre-commit failure, attempt discard; if discard itself fails, surface action-required/unknown state including the edit ID and do not claim success. Add explicit DELETE-failure and post-insert downstream-failure tests.

### P1 — URL normalization lets a request cross from the demo namespace into live APIs

Locations:

- `apps/controller/server.ts:73` parses the raw request target with `new URL(...)`, which normalizes dot segments.
- `apps/controller/server.ts:95-102` chooses demo versus live routing from the already-normalized `url.pathname`.

Impact: `/api/demo/../state` is normalized to `/api/state` and reaches the live handler with a valid local bearer token, violating the contract that demo and live have exact, isolated prefixes. Renderer allowlisting may block the normal UI path, but the authenticated backend itself accepts this mode-confused request.

Brief reproduction: start a controller in a temporary directory, obtain demo state normally, then issue a raw Node `http.request` to `/api/demo/../state`. The observed result was HTTP 200 with `runtime.mode: "live"` (normal `/api/demo/state` returned `runtime.mode: "demo"`).

Action: reject unsafe raw request targets before URL normalization, including literal/encoded dot segments, encoded separators, backslashes, and ambiguous duplicate separators; alternatively require the canonical path to exactly preserve the raw namespace. Add direct controller HTTP tests for these variants, not only Electron renderer allowlist tests.

## Remaining assessment

No additional blocking defect was found in the reviewed remote bundle/authentication/traversal/limit/abort paths or the pipeline parent/child persistence and recovery paths. This is not a correctness proof: the focused 54-test rerun passed, while the four negative paths above remain untested and require fixes followed by targeted verification.
