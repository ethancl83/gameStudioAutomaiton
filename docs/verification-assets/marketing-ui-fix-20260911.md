# Marketing UI fix — P1 #4 (project-required writes + row prefill)

Date: 2026-09-11 · Worker: Opus 4.8 · Owned: `apps/desktop/**`, `tests/desktop-security.test.ts`, `docs/desktop-usage.md`.
No root backend edits, no Git, no real accounts/spend, no servers started (pure implementation + tests). Root 4317/5175 untouched.

## Root cause (from /tmp/appops-marketing-fixes-opus.md #4)
Controller `enforcePolicy` (`apps/controller/validation.ts`) throws `PROJECT_REQUIRED` for every external write except social posts, and row updates additionally enforce `RESOURCE_MISMATCH` against the resource's project. The UI let projectless marketing writes submit (needsProject `optional`/absent) and row actions passed only `externalId`, so pause/update/create failed at the controller.

## Changes (my files)
1. `apps/desktop/src/operations.ts`
   - `needsProject: 'required'` for ALL external marketing/monetization writes: `create-campaign`, `update-campaign`, `pause-campaign`, `create-ad-unit`, `update-ad-unit`, and (same controller gate) `create-product`, `update-product`. (`upload-build` was already required.)
   - Extracted `buildOperationInput(fields, values, {currency,externalId,buildRunId})` — a pure, testable builder: money→micros, `country`→comma-split multi-country array, currency when a money field exists, target `externalId`/`buildRunId` from opts. **Skips any `externalId` input field** so a schema/override `externalId` can never duplicate the target selector's value (root already removed `externalId` from connector `operationFields`; this is the defensive UI guard).
2. `apps/desktop/src/components/ActionForm.tsx`
   - Uses `buildOperationInput`; excludes `externalId` from rendered `visibleFields` (no duplicate input). Submit still blocked until a project is chosen (`needsProject==='required'`).
3. `apps/desktop/src/components/ResourcePanel.tsx`
   - Row actions now prefill the resource's project: `onRowAction(op, externalId, projectId)` → `presetProjectId={resource.projectId ?? undefined}`. Unknown-owner resources (`projectId === null`) leave the required project selector empty so the user must pick a valid project; the controller enforces actual ownership.
4. `docs/desktop-usage.md` — noted marketing/monetization writes require a project (row actions auto-select the resource's project; server verifies ownership).

## Regression tests added (`tests/desktop-security.test.ts`)
- All 7 external writes: `externalWrite===true` and `needsProject==='required'`.
- Row-target specs carry `targetKind` (campaign/ad-unit/product) — the prefill target.
- `buildOperationInput`: `dailyBudgetMicros` 10→`10000000`, `country:'KR, US , JP'`→`['KR','US','JP']`, `currency` included, target `externalId` from opts, empty fields dropped.
- Duplicate-`externalId` guard: a schema `externalId` field is ignored; only the target `externalId` is sent.
- `mergeOperationFields` never introduces an `externalId` field.

## Verification
- `npm run typecheck`: clean. `tests/desktop-security.test.ts`: 15/15. **Full `npm test`: 177/177** (root 172 + 5 new). `npm run build` (tsc + vite) succeeds.

## Notes / left
- Extended project-required to `create-product`/`update-product` beyond the 5 explicitly named ops, because the controller gate applies to them identically; leaving them optional would be a latent `PROJECT_REQUIRED` failure. Flag if a different product-scope was intended.
- No resources to close (no QA servers started this dispatch).
