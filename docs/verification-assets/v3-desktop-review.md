# Opus desktop v3 independent review

Date: 2026-09-11 KST  
Scope: read-only review of `apps/desktop/src/**` against domain/controller/connector contracts. The coordinator-owned in-flight media import, provider-specific `list-listings` classification, and `create-creative` campaign targeting were treated as moving scope and not reported as defects here.

## Findings

### 1. High — publish requests do not send the idempotency key that the controller already supports

- Renderer: `apps/desktop/src/components/PublishFlow.tsx:41-75` uses `useAction` but does not create or retain an idempotency key; `apps/desktop/src/api.ts:328-344` does not admit `idempotencyKey` in the publish input type.
- Controller: `apps/controller/pipelines.ts:33-37` only provides terminal-state-safe deduplication when `data.idempotencyKey` is present. Without it, the fallback only reuses an equivalent pipeline while it is nonterminal.
- Impact: if POST `/projects/:id/publish` reaches the controller but its response is lost, and the first pipeline reaches `succeeded`/`failed` before the user resubmits, the same form creates a second pipeline and can repeat the build/upload workflow. This is exactly the response-loss case for which ActionForm retains a key.
- Repro: submit a publish request while dropping the response after server receipt; wait for the first pipeline to terminate; resubmit the unchanged form. The second request has no key and `publish()` excludes the terminal prior pipeline from fallback matching, so it returns a new pipeline ID.

### 2. High — synthetic local runner is exposed as a stored remote runner, yielding dead controls and an invalid build choice

- Controller: `apps/controller/operations.ts:42-43` prepends a synthetic `{id:'local', status:'ready'}` runner, but `checkRunner`/`removeRunner` only accept persisted runners (`apps/controller/operations.ts:107-124`), and builds with a nonempty runner ID require a persisted runner (`apps/controller/service.ts:175`).
- Renderer: `apps/desktop/src/views/OperationsView.tsx:178-179,188-219` renders check/delete for every runner. `apps/desktop/src/useOperations.ts:13-16` classifies every ready item—including `local`—as selectable, and `apps/desktop/src/components/RunnerSelect.tsx:33-38` displays it in addition to the empty-value “local” option.
- Impact: Operations presents buttons that always fail for the local runner, and Build/Publish present a second local choice that sends `runnerId:'local'` and is always rejected with `RUNNER_REQUIRED`.
- Repro/evidence: in an independent Orca tab, Project → Build showed both “로컬(현재 OS)” and “데모 로컬 러너 · Linux”. A direct demo check of the same UI action returned HTTP 404 `NOT_FOUND` (“등록한 러너가 없습니다.”). No live external service was called.

### 3. High — restore is presented as point-in-time replacement but does not remove projects created after the backup

- Renderer promise: `apps/desktop/src/views/OperationsView.tsx:507-510` says projects/policies/settings will be restored “to this point”, and the completion copy at `:500-503` reports the snapshot project count.
- Controller behavior: `apps/controller/operations.ts:77-93` validates snapshot projects and calls `writeBatch` only with project/settings updates and an empty removal list. Any current project whose ID is absent from the snapshot remains registered.
- Impact: a restore can report success while leaving post-backup projects and their settings in place, so the visible state is not the advertised snapshot. This is particularly risky because users invoke restore as a destructive recovery operation.
- Repro: create backup A; register project B; restore A. Project B remains because no project removal is included, while the modal reports the count from A.

### 4. Medium — capability money forms render two currency inputs, require the wrong one, then silently discard it

- Connector contract: Google Ads and AppLovin Ads add a `currency` operation field (for example `packages/connectors/google-ads.ts:336-354` and `packages/connectors/applovin-ads.ts:248-276`).
- Renderer: capability fields remain in `visibleFields` (`apps/desktop/src/components/ActionForm.tsx:50-57`), then any money field also causes a separate canonical currency control at `:270-273`. Required validation checks `values.currency` (`:115-121`), but submission passes separate state `currency` into `buildOperationInput` (`:125-130`).
- Serialization: `apps/desktop/src/operations.ts:265-279` first serializes the capability `currency` field, then unconditionally overwrites it with `opts.currency`.
- Impact: create-campaign shows two controls both labelled “통화”; the user must fill the first to enable submit even though the second is already populated, and the first value is ignored. This can make the payload differ from what the user typed.
- Repro/evidence: an independent Orca tab on Google Ads → 캠페인 생성 displayed two “통화” textboxes, one empty and one `USD`. A pure contract probe with capability currency `EUR` and canonical currency `USD` produced `submittedCurrency:"USD"`.

### 5. Medium — build and publish offer fabricated targets when inspection found none, but the controller rejects every offered value

- Build: `apps/desktop/src/views/ProjectsView.tsx:523-545` tells the user to choose a target manually and supplies all five targets when `project.targets` is empty. `apps/controller/service.ts:168-170` requires the chosen target to already be in `project.targets`.
- Publish: `apps/desktop/src/components/PublishFlow.tsx:44-45` uses the same all-target fallback, while `apps/controller/pipelines.ts:27` enforces membership in `project.targets`.
- Impact/repro: for any inspection result with `targets: []`, select any offered target and submit Build or Publish. Both paths deterministically return `UNSUPPORTED_TARGET`; there is no UI path that can satisfy the controller.

### 6. Medium — publish store choices ignore target compatibility, operation support, and connection status

- `eligibleStoreConnections` (`apps/desktop/src/components/PublishFlow.tsx:16-22`) includes every connection whose capability category is `store`; the modal displays all of them at `:131-137` independently of the selected target.
- `apps/controller/pipelines.ts:26-29` rejects disconnected connections and enforces Android→Google Play, iOS→App Store, macOS→App Store/Steam, other desktop→Steam.
- Impact/repro: open Publish for an Android target and choose the App Store or Steam item the UI offers; submit deterministically fails `PROVIDER_MISMATCH`. A disconnected store and a store capability lacking `upload-build` can likewise make the UI appear publishable even though it is not.

### 7. Medium — RunActions treats read runs as external writes and offers a reconcile action the controller rejects

- Canonical classification: `packages/connectors/types.ts:43-47` marks list/sync/check operations read-only (with provider-specific exceptions).
- Renderer classification: `apps/desktop/src/components/runs.tsx:141-169` infers “external write” from non-null `connectionId` and a three-operation blacklist, so `list-campaigns`, `sync`, `list-products`, etc. are treated as writes.
- Failure path: an auth/vault/permission error can put even a read run in `action_required` (`apps/controller/queue.ts:42-50`). The renderer then shows “상태 재확인”, while `apps/controller/service.ts:361-364` rejects reconcile because canonical `isWriteOperation` is false.
- Repro: force `AUTH_REQUIRED` on `list-campaigns`; open the resulting action-required run; click “상태 재확인”. The request returns `RECONCILIATION_UNAVAILABLE`.

### 8. Medium — Operations settings accepts a retention value the controller explicitly rejects

- Renderer: `apps/desktop/src/views/OperationsView.tsx:340-355` considers any integer ≥1 valid, sets `<input min=1>`, and says “최소 1”.
- Controller: `apps/controller/operations.ts:27-30` accepts only 7–3650 days.
- Repro: enter 1–6 and click Save. The enabled form submits and always receives `INVALID_SETTINGS`.

### 9. Medium — backup description input is accepted and sent but discarded

- Renderer/API: `apps/desktop/src/views/OperationsView.tsx:407,415-430` collects an optional description and `apps/desktop/src/api.ts:356-358` sends it.
- Server/controller: `apps/controller/server.ts:122` calls `operations.backup()` without the body, and `apps/controller/operations.ts:48-52` has no input parameter and always stores a fixed description.
- Repro: enter “출시 전 스냅샷”, create a backup, and inspect the row. It shows the fixed controller description, not the supplied label.

### 10. Medium — readiness “안내 열기” buttons route internal view keys through the external-URL API

- Controller returns internal destinations such as `connections`, `projects`, and `settings` (`apps/controller/operations.ts:35-40`).
- Renderer sends those strings to `api.openExternal` (`apps/desktop/src/views/OperationsView.tsx:146-149`) instead of calling App’s `goTo`; `OperationsView` is not given `goTo` (`apps/desktop/src/App.tsx:324-325`).
- Electron rejects non-HTTPS/non-allowlisted targets (`apps/desktop/electron/security.ts:162-177`), and the UI ignores the returned error. Browser dev mode opens a relative URL in a new tab rather than switching the state-based SPA view.
- Repro: in Electron, click any readiness “안내 열기”; it silently stays put. In browser preview it attempts a new relative tab instead of navigating the current console.

## Verification

- `npm run typecheck`: passed against the final integrated tree (`tsc --noEmit` and node project typecheck).
- `node --import tsx --test tests/desktop-security.test.ts`: 15/15 passed. The passing suite does not cover the runtime contract mismatches above.
- Independent Orca browser tab was used and closed after inspection; the coordinator’s existing page was not touched.
- No source code was edited and no live external write was performed.
