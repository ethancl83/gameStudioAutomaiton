# AppOps marketing fixes — independent verification (Opus)

Read-only, once-only bounded check on 2026-09-11. No repository files were edited,
no real accounts/credentials/uploads/mutations/spend were used. Verification used
the repo's real modules driven by injected HTTP responses via a probe at
`/tmp/appops-marketing-fixes-probe.ts`, plus the in-repo regression tests.

## Bottom line

Root's backend/doc fixes for the marketing review are **verified resolved**:
findings **#1, #2, #3, #5, #6, #7, #8** all reproduce as fixed. Finding **#4**
(marketing write forms must satisfy the controller's mandatory project scope) is
**NOT yet in the tree** — it is the UI worker's item (`ctx_e21c18897179`,
"all writes project-required / resource prefill") and remains reproducible in the
current checkout. Exact file/line for #4 is below.

## Evidence base

- Regression tests: `tests/marketing-connectors.test.ts` + `tests/metrics.test.ts`
  → **14/14 pass**.
- Independent injected-HTTP probe (real connectors/metrics/UI-merge, mock `request`):
  **all assertions pass** — output reproduced inline per finding.
- `tsc --noEmit` (both project configs via the browser config): **0 errors** repo-wide;
  0 in `packages/connectors`, `packages/metrics`, `apps/desktop/src`.

## Per-finding verdicts (the 8 review findings)

### #1 P1 Google Ads spend rows overwrite — RESOLVED
- `packages/connectors/google-ads.ts:95-113` (`spendMetrics`). The query selects
  `campaign.app_campaign_setting.app_id` and the connector **aggregates per
  `sourceId` (customer:appId:date) with BigInt** before returning:
  `amountMicros = (parseMicros(cost) + parseMicros(existing)).toString()`
  (`parseMicros` returns `bigint`, `packages/metrics/index.ts:4-7`).
- Probe: two rows for `com.example.game` on `2026-09-10` (1,000,000 + 2,000,000)
  → **one metric, amountMicros `3000000`** (was: later row replaced earlier at
  2,000,000). Matches GAQL "row per resource/segment" semantics.

### #2 P1 AdMob attribution + MAX/AdMob overlap — RESOLVED
- `admob.ts:53-68` (`listApps`) sets `data.packageName = linkedAppInfo.appStoreId`
  **only for `platform==='ANDROID'`** and only when it matches a package-name
  regex; `listAdUnits:70-82` and `networkRevenue:90-124` map the raw
  `ca-app-pub-…` APP id → linked Android package for `appIdentifier`, while the
  **raw SDK id is preserved** in `sourceId` and `data.admobAppId`.
- Overlap fence `packages/metrics/index.ts:18-34`: AdMob revenue is **excluded and
  warned** when a MAX fact covers the same date+currency and
  `(!appIdentifier || coverage.has('*') || coverage.has(appIdentifier))` — i.e.
  conservative for the iOS/unknown case.
- Probe: Android `ca-app-pub-1~1` → `appIdentifier=com.example.game`; iOS
  `ca-app-pub-2~2` (numeric store id) → `appIdentifier=undefined` (unattributed).
  Summarize(MAX 2,000,000 for `com.example.game` + AdMob android 1,000,000 + AdMob
  iOS 500,000) → **revenue `2000000` with an overlap warning** (both AdMob amounts
  excluded conservatively). Was: 3,000,000 and no warning.

### #3 P1 duplicate `externalId` fields on update/pause forms — RESOLVED
- Root removed the `externalId` overrides from the connector `operationFields`:
  `google-ads.ts` (`update-campaign`={name,dailyBudgetMicros,currency,status},
  `pause-campaign`=[]), `applovin-ads.ts:167-174` (same shape),
  `applovin-max.ts` (`update-ad-unit`={name required},{status remove}). No base
  spec in `operations.ts` contains `externalId`.
- Probe: `mergeOperationFields([], override)` for google update/pause and MAX
  update **adds no `externalId` field**. The selector-derived id still flows via
  `ActionForm.buildInput` (`ActionForm.tsx:137`). The review's alternative
  "suppress controller-owned keys in merge" is therefore unnecessary.

### #4 P1 marketing forms don't satisfy mandatory project scope — NOT RESOLVED (UI-worker scope)
- Controller still gates every external write: `apps/controller/validation.ts:48`
  throws `PROJECT_REQUIRED` when no project.
- Current UI is unchanged for this finding (`apps/desktop/src/operations.ts`):
  - `create-campaign:49-58` `needsProject:'optional'`
  - `update-campaign:60-70` `needsProject:'optional'`
  - `pause-campaign:72-76` **no `needsProject`** (no project selector rendered)
  - `create-ad-unit:` `needsProject:'optional'`
  - `update-ad-unit:` **no `needsProject`**
- `ActionForm.tsx:114` blocks submit only when `needsProject==='required'`, so a
  projectless submit is allowed → fails at the controller. `ResourcePanel.tsx:102,
  110,172` pass only `externalId` on row actions (no `projectId`/`presetProjectId`),
  so row pause / MAX update cannot supply a project through the form.
- This is explicitly assigned to the UI worker (`ctx_e21c18897179`) and is outside
  root's backend fix set. Reproduction is exact above; no code change was made.

### #5 P1 MAX status change reports success after ID-only no-op — RESOLVED
- `applovin-max.ts:82-91` (`updateAdUnit`): `if (input.status!==undefined ||
  input.disabled!==undefined) throw UNSUPPORTED_OPERATION` **before any request**;
  body is `{id,name}` with `name` required. Capability `update-ad-unit`
  operationFields = `{name required},{status remove}` (status not exposed).
- Probe: `{externalId:'u1',status:'inactive'}` and `{...,disabled:true}` both throw
  `UNSUPPORTED_OPERATION` with **0 requests dispatched**. Matches AppLovin docs
  (disabled read-only; activation via UI only).

### #6 P2 Google Ads country serialized as array is rejected — RESOLVED
- `google-ads.ts:createCampaign` accepts scalar **or array**:
  `Array.isArray(input.country)? input.country : [input.country]`, caps at 20,
  dedupes via `new Set(countries.map(value => countryCode(value)))`, and emits one
  `campaignCriterionOperation` per country. The `map(value => countryCode(value))`
  form fixes the callback-arity type issue (`countryCode(value, label='국가')`).
  `ActionForm.tsx:129-130` serializes `country` → array; connector now consumes it.
- Probe: `country:['US','KR']` → **2 criterion operations, no `INVALID_INPUT`**.

### #7 P2 MAX exposes NATIVE without `template_size` — RESOLVED
- `applovin-max.ts:adFormat` whitelist is `BANNER/INTER/REWARD/MREC`; `NATIVE`
  throws `INVALID_INPUT` ("NATIVE 템플릿 설정은 아직 지원하지 않습니다"). Capability
  `create-ad-unit` format options list only those four (no NATIVE).
- Probe: `format:'NATIVE'` throws `INVALID_INPUT` with **0 requests**.
- Minor (not a finding, no regression): the `FORMATS` map still contains
  `native`/`appopen` entries, but both are rejected by the whitelist; only the
  error text is NATIVE-specific.

### #8 P2 marketing guide describes completed/unsupported follow-up — RESOLVED
- `docs/marketing-integration.md` now states the four connectors **are registered**
  in `packages/connectors/index.ts` and that the UI consumes
  `capability.operationFields`; the stale coordinator-follow-up section is gone.
  It documents Google BigInt per-app/day aggregation, AdMob linked-package
  attribution with iOS/manual left unattributed, and MAX NATIVE excluded until
  `template_size` is modeled. No AppLovin create-campaign inputs are listed
  (create is documented as unsupported).

## Official-docs behavior confirmation

- No fake success: MAX status/disabled and AppLovin create-campaign throw
  (`UNSUPPORTED_OPERATION`); Google creates `PAUSED` and re-verifies via
  `listCampaigns`; AdMob writes are absent from `capability.operations`.
- Attribution accurate: AdMob→linked Android package (iOS unattributed), Google
  spend keyed by app+date and summed; overlap fence prevents MAX/AdMob double count.
- Money accurate: `parseMicros` BigInt, `decimalToMicros` exact to 6 dp,
  `moneyToMicros` for MAX. These match the review's cited GAQL / AdMob
  `linkedAppInfo.appStoreId` / MAX ad-unit-management (disabled read-only) / MAX
  native `template_size` sources.

## Scope notes / not covered

- Core Social review and keys are handled separately by Sol (`ctx_12a2a800037c`);
  not re-audited here.
- No new broad audit was performed. No real OAuth/account/provider HTTP; provider
  allowlisting, minimum budgets, live response variation, and rate limits remain
  unverified (same limits as the original review).
- The six foundation fixes were already verified in the prior review and were not
  re-checked. Repository was not modified; only `/tmp` artifacts were created.
