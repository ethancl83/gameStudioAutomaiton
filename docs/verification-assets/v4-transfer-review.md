# V4 transfer/install/backup independent review

Date: 2026-09-11 (Asia/Seoul)  
Reviewer role: read-only independent Sol high review  
Scope: `packages/setup/download.ts`; Apple screenshot/build upload wiring in `packages/connectors/{apple-media,app-store,store-apple-ops}.ts` and its shared transport; Electron portable-backup streaming handlers in `apps/desktop/electron/{main,preload,security}.ts`; browser/API/UI backup flow in `apps/desktop/src/{api.ts,components/PortableBackupPanel.tsx}`. No provider writes or system authorization were performed.

## Executive result

The reviewed tree type-checks and all 64 executed targeted tests pass (one live-network test was intentionally skipped). I did not find a path that silently installs a digest-mismatched download, leaks the App Store bearer token to an upload URL, automatically duplicates an uncertain provider write, or reports a live restore as complete after a restart failure. I did confirm two high-impact contract/trust defects and several medium defects: invalid current App Store screenshot enum values and materially stale size mappings; renderer-controlled live/demo binding; shallow image validation; upload-part method/range validation gaps; build and screenshot artifact TOCTOU; and an interrupted Apple upload state that reconciliation cannot recover.

## Confirmed defects

### D1 — High: screenshot display types do not match the current App Store Connect API

`packages/connectors/apple-media.ts:28-54` publishes `APP_IPHONE_69` and `APP_IPHONE_63`; neither appears in the current official `ScreenshotDisplayType` enum. Both values can reach the set-creation POST unchanged at `apple-media.ts:206-216`, so the UI/connector offers provider-invalid requests. The current OpenAPI 4.4.1 enum instead contains `APP_IPHONE_67`, `APP_IPHONE_61`, the older iPhone/iPad/Mac/Watch/TV types, and `APP_APPLE_VISION_PRO`.

The dimensions are also incomplete or wrong against Apple's current screenshot specification:

- `APP_APPLE_VISION_PRO` is listed as 2732×2048 / 2048×2732 at `apple-media.ts:51`; Apple currently requires 3840×2160.
- `APP_IPAD_PRO_3GEN_11` at line 40 contains only 1668×2388 and its rotation, omitting the current 1488×2266, 1668×2420, and 1640×2360 pairs.
- `APP_IPAD_97` at line 43 omits six currently accepted dimensions.
- `APP_IPHONE_40` and `APP_IPHONE_35` at lines 37-38 omit Apple's no-status-bar dimensions.
- The current Watch specification includes 422×514, which no entry represents.
- Common 6.9-inch dimensions 1260×2736 and 1320×2868 are accepted only under the provider-invalid `APP_IPHONE_69`; consequently they cannot be submitted under a legal current API enum through this table.

Reproduction: select `APP_IPHONE_69` or `APP_IPHONE_63`; `displayType()` accepts it and `findOrCreateSet()` sends it as `screenshotDisplayType`. Conversely, a header declaring 3840×2160 with `APP_APPLE_VISION_PRO` is rejected locally at `apple-media.ts:111-118` before contacting Apple.

Official baselines: [App Store Connect OpenAPI specification](https://developer.apple.com/sample-code/app-store-connect/app-store-connect-openapi-specification.zip), [ScreenshotDisplayType](https://developer.apple.com/documentation/appstoreconnectapi/screenshotdisplaytype), and [Screenshot specifications](https://developer.apple.com/help/app-store-connect/reference/app-information/screenshot-specifications/). The downloaded OpenAPI archive identified version 4.4.1 and was checked on 2026-09-11.

### D2 — High: the main-process live/demo backup route is selected by renderer-writable state

`apps/desktop/electron/preload.ts:62-73,91-93` reads `window.localStorage` and forwards the result over IPC. `apps/desktop/electron/security.ts:238-244` and `apps/desktop/electron/main.ts:429-432,565-567` treat the literal string `live` as authoritative. The comment at `main.ts:395-397` says page script cannot forge the mode, but a script in the trusted renderer can write that same localStorage key. `isTrustedFrame()` authenticates only the calling frame URL; it does not bind the requested mode to main-owned application state.

Reproduction in a compromised trusted renderer: `localStorage.setItem('appops.runtime.mode', 'live')`, then invoke the exposed import bridge and select a file in the native dialog. Main routes the upload to `/api/operations/portable-backups/import`, not `/api/demo/...`. The native file picker still requires user selection, and cryptographic restore preparation/activation remains enforced, so this is not a demonstrated silent restore; it is a broken trust boundary capable of routing a user-selected backup into the live store. Bind mode in main/controller-owned state (or a main-owned user confirmation), not renderer storage.

### D3 — Medium: image validation accepts structurally invalid PNG and JPEG files

`parsePng()` at `packages/connectors/apple-media.ts:68-76` trusts the signature/IHDR fields without checking chunk boundaries, CRC, IDAT, or IEND. `parseJpeg()` at lines 78-94 accepts a SOF dimension record without requiring scan data or EOI. The local validator therefore does not establish that Apple can decode the image.

Scratch reproduction (no provider call): a 26-byte buffer containing a PNG signature plus IHDR marker/dimensions was accepted as a 1290×2796 PNG; a 12-byte SOI/SOF-only buffer was accepted as a 1290×2796 JPEG. The exact probe result was:

```json
{"pngBytes":26,"pngAccepted":{"mime":"image/png","width":1290,"height":2796},"jpegBytes":12,"jpegAccepted":{"mime":"image/jpeg","width":1290,"height":2796}}
```

Apple should reject such data later, so the direct consequence is avoidable reservation/writes and an eventual failed/action-required run, not a demonstrated false provider success. Decode the entire image with a bounded parser before reservation and continue enforcing no-alpha PNG.

### D4 — Medium: upload operations are not proven to describe the exact file and the method is not enforced

Both parsers (`apple-media.ts:121-141`, `app-store.ts:66-86`) accept any method string and independently valid non-empty ranges. Neither proves that the union is exactly `[0, fileSize)`, non-overlapping, gap-free, duplicate-free, or safely ordered. Screenshot upload coerces every non-POST method to PUT at `apple-media.ts:278-280`; build upload passes an arbitrary runtime string despite the TypeScript cast at `app-store.ts:157-159`. This violates Apple's requirement to execute each returned operation with its specified method, URL, headers, offset, and length.

Reproduction: return two operations `(offset=0,length=1)` and `(offset=2,length=fileSize-2)`, or two overlapping operations, from the mocked reservation response. Each item passes the parser and the connector proceeds to upload and PATCH `uploaded:true`; only Apple-side checksum/state processing can catch the incomplete/duplicated content. A response method of `PATCH` is silently converted to PUT in the screenshot path and sent as PATCH in the build path.

Official baseline: [Uploading assets to App Store Connect](https://developer.apple.com/documentation/appstoreconnectapi/uploading-assets-to-app-store-connect).

### D5 — Medium: upload reads are not pinned to the artifact that was validated

Screenshot upload reads and hashes the whole artifact at `apple-media.ts:305-311`, performs multiple network operations, then reopens the path for every part at lines 262-284. A same-path replacement after validation but before/during part reads uploads different bytes while the commit still supplies the original MD5. Part-length checks catch truncation but not same-size replacement.

Build upload is weaker: `app-store.ts:95-110` parses IPA metadata but never rechecks the registered artifact size or SHA-256. It reopens the path for parts at lines 152-163, does not check that every slice has the instructed length, and later declares the stored `artifact.sha256` at lines 168-180.

Reproduction: replace the artifact atomically with a same-size file after reservation and before the first slice read. The connector reads the replacement and commits the original checksum. Apple should reject the mismatch during processing, so this is a confirmed local integrity/availability defect rather than a demonstrated false success. Hold one no-follow file descriptor from validation through upload, verify it is a regular file, hash those exact bytes, and validate every read length/range.

### D6 — Medium: an interrupted Apple upload can become a permanent non-writing reconciliation loop

Reservation IDs and phases are durably checkpointed (`apple-media.ts:317-355`, `app-store.ts:133-150`; merge persistence at `packages/storage/index.ts:208-214`). After any external write is marked dispatched, the queue correctly prevents automatic retry (`apps/controller/queue.ts:43-51`; `packages/storage/index.ts:260-267`). However, screenshot reconciliation at `apple-media.ts:399-429` only polls the existing screenshot. If a crash or network failure leaves it in `AWAITING_UPLOAD`, reconciliation returns waiting again; it cannot resend specifically missing parts or delete an expired reservation and create a replacement. Apple documents both resending lost parts before commit and deleting/recreating expired reservations.

Reproduction: reserve successfully, checkpoint the screenshot ID, upload zero or only some parts, then terminate before commit. On restart, reconcile the run while Apple still reports `AWAITING_UPLOAD`; the implementation performs no upload/delete action and remains `waiting_external`. This is safe against automatic duplicate writes but is an operational dead end requiring manual provider inspection/cleanup. A crash after provider reservation but before its ID checkpoint similarly requires manual discovery because the effect is already marked dispatched.

### D7 — Low/medium: resumed HTTP responses are under-validated

`packages/setup/download.ts:93-103,224-256` requires `Content-Range` to start at the current offset, but it does not verify that `end - start + 1` equals the bytes received for that response, that the total is unchanged from the first response, that the returned validator still equals the original ETag/Last-Modified, or that a 206 response is identity encoded. A malicious or broken allowed CDN can therefore force retry/quarantine or waste bandwidth. The mandatory final SHA-256/SHA-512 pin still prevents corrupted installation, so no digest bypass was found.

Reproduction: after a retry at offset N, return `206 Content-Range: bytes N-(N+9)/T` but stream a different number of decoded bytes; the code accepts the range header and detects only aggregate length/digest later. Store the initial total/validator, require matching response semantics, validate each resumed segment length, and reject encoded range responses.

## Verified safe behavior

### App Store upload transport and execution state

- `packages/connectors/transport.ts:20-30,90-107` learns upload URLs only from a successful authenticated App Store API JSON response, requires HTTPS, no credentials/fragment, Apple/iCloud subdomain, default/443 port, and caps the set at 4096 exact URLs.
- Every fetch uses `redirect: 'error'` (`transport.ts:46-52`). Upload requests reject `Authorization`, `Cookie`, `Host`, and `Proxy-Authorization`; I found no bearer-token propagation to signed upload hosts. Error bodies and request URLs are not placed in history (`transport.ts:57-64`).
- The storage/queue effect fence prevents a write run from completing without a dispatched effect and blocks replay after an uncertain write (`packages/storage/index.ts:224-239,260-267`). A reused already-complete screenshot reservation therefore cannot produce a system-level success without a recorded write in the current run.
- Screenshot completion is based on Apple's `assetDeliveryState === COMPLETE`; `FAILED` is surfaced. Build upload similarly polls provider state. No direct connector-only false success was found in these terminal-state checks.

### Verified download/install behavior

- `assertOfficialUrl()` and `fetchOfficial()` (`packages/setup/download.ts:15-49`) require an exact allowlisted HTTPS hostname, reject credentials, IP/local hosts, and non-443 ports, and revalidate every manual redirect hop.
- A digest pin is mandatory (`download.ts:68-70`). Streaming enforces `maxBytes`, bounds retries to four attempts, resumes only with `Range` plus a strong ETag or Last-Modified validator, restarts from zero on a full 200, deletes partials on cancel, quarantines terminal failures, and verifies the final pinned digest before installation.
- The gzip change at `download.ts:80-91` correctly prefers `x-identity-content-length` when Node fetch decodes a content-encoded response. If a server ignores `Accept-Encoding: identity`, sends gzip, and omits that identity header, the implementation compares decoded bytes to compressed `Content-Length` and safely fails as truncated; it does not install corrupt content.
- `/tmp/appops-download-verified-cmdline.json` records a real, uninjected Node `downloadVerified` fetch from `https://dl.google.com/android/repository/commandlinetools-linux-15859902_latest.zip`: 181,833,628 bytes and SHA-256 `4e4c464f145a7512b57d088ac6c278c03c9eea610886b35a5e0804e74eedf583`. Its temporary destination has since been removed, so the retained report cannot now be independently rehashed.
- `/tmp/appops-setup-real-result.json` records successful Temurin JDK and Android SDK setup, packages `build-tools;36.0.0`, `platform-tools` 37.0.1, and `platforms;android-36` revision 2, plus a cancellation case preserving the previous install. The installed Java 21.0.12.1 LTS and adb 37.0.1 binaries still execute; their modes are 0700 and 0775 respectively. In that setup run the JDK and command-line tools came from cached local/previously verified archives; only `sdkmanager` package retrieval was live, so it is not a second independent live exercise of `downloadVerified`.

### Native portable backup and restore

- Every relevant IPC handler checks the top frame (`apps/desktop/electron/main.ts:600-708`); BrowserWindow disables Node integration and keeps context isolation/sandbox (`main.ts:711-750`). Raw import/download paths are not in the generic renderer API allowlist (`apps/desktop/electron/security.ts:48-53`). Renderer APIs receive neither controller bearer token nor a native path/file body (`preload.ts:52-59,91-94`).
- Save uses a native dialog, unpredictable sibling `wx` temporary file with 0600 mode, a 512 GiB streaming cap, length/SHA checks when the server supplies them, and rename only after verification (`main.ts:429-500`). Failure removes only the temporary file, preserving an existing destination.
- The controller opens the source with `O_NOFOLLOW`, holds the descriptor through download, and checks its stored size (`apps/controller/portable-backups.ts:68-73`). It always emits `Content-Length` and `X-AppOps-SHA256` (`apps/controller/server.ts:145-152`), so the current native endpoint exercises both main-process checks.
- Import uses a native dialog, a declared length, a cap, and a magic precheck. The controller independently enforces exact received length and magic, hashes the bytes, writes a 0600 exclusive temporary file, calls `fsync`, and renames only on completion (`apps/controller/portable-backups.ts:75-94`).
- Pending restore records are HMAC-authenticated; stage digest/identity are rechecked before atomic directory replacement; the old directory is retained and startup failure rolls it back (`packages/backup/activation.ts:54-76,111-172`).
- The corrected UI no longer reports live restore completion merely because commit returned. It restarts, propagates restart errors, fetches backup state, and marks confirmed only when the same restore ID is `committed` (`apps/desktop/src/components/PortableBackupPanel.tsx:373-418`). This matches controller activation commit after successful startup (`apps/controller/server.ts:70-72`; `apps/controller/portable-backups.ts:42-49`).

## Limitations and unverified claims (not demonstrated exploits)

- Production `isTrustedFrame()` accepts any top-level `file:` URL (`apps/desktop/electron/main.ts:369-391`) instead of an exact packaged entry URL/webContents identity. Navigation/window restrictions reduce reachability, so I did not establish a practical second-file navigation exploit; exact URL binding is still preferable.
- Native import calls `stat()`, opens once for magic, closes, and opens the pathname again for upload (`main.ts:417-426,578-593,556`). It follows symlinks and does not pin the chosen inode. A swap can change which same-size file is uploaded, but the controller's exact-length, magic, archive cryptographic validation, and restore-stage digest prevent an unvalidated silent commit. Use one `O_NOFOLLOW` descriptor from validation through streaming.
- Native save treats missing/malformed `Content-Length` or missing SHA header as “no expectation” (`main.ts:460-486`). The actual in-scope controller always emits both, so this is fail-open protocol robustness rather than a current endpoint bypass. Make both headers mandatory in main.
- The native save closes the stream before rename but does not explicitly fsync the file/directory. Rename is namespace-atomic, yet a power loss could lose a just-reported save. This review did not perform destructive crash testing.
- Browser fallback download at `apps/desktop/src/api.ts:625-647` enforces only a capacity ceiling; it does not verify declared length, `X-AppOps-SHA256`, or backup magic before triggering download. Browser downloads cannot provide the same overwrite/atomicity guarantees as the native bridge, but digest/length checks can still provide parity before success is returned.
- Demo restore is shown as confirmed whenever a successful commit response has `restartRequired:false` (`PortableBackupPanel.tsx:379-380,419-422`) without checking `restored:true`. The current controller only returns that branch after successful isolated-demo reactivation (`apps/controller/server.ts:190-198`), so no present false-success path was reproduced; making `restored` required and checking it would harden the contract.
- Screenshot reservation reuse is keyed only by file name and size (`apple-media.ts:232-241`), not artifact hash. The run effect fence prevents a no-write success when a previously complete reservation is reused, but identity is ambiguous and could attach to an unrelated same-name/same-size reservation. Prefer persisted resource ID plus checksum/state validation.
- Cross-process download resume is not implemented: `downloadVerified()` deletes its partial at entry (`download.ts:212-215`). Resume applies only to retries within one invocation. This is safe but should not be advertised as crash-resume.
- Apple-returned operation headers other than the explicit credential/header denylist are forwarded. Because the operations are learned only from authenticated Apple JSON and upload URLs are exact-pinned, I found no renderer-controlled or bearer-leak path; a strict allowlist would further reduce trust in malformed provider responses.
- I did not make real App Store Connect writes, interrupt a production upload, perform system authentication, or run power-loss/crash filesystem tests. Provider terminal behavior and the current OpenAPI/help contract were verified from official documentation and deterministic mocks/static paths only.

## Verification executed

Command:

```sh
APPOPS_SKIP_LIVE_INSTALL=1 node --import tsx --test \
  tests/setup-install-download.test.ts \
  tests/transport.test.ts \
  tests/app-store-media.test.ts \
  tests/store-connectors.test.ts \
  tests/desktop-backup-bridge.test.ts \
  tests/portable-backup.test.ts \
  tests/portable-backup-controller.test.ts
```

Result: **65 tests; 64 passed; 0 failed; 1 skipped** (the separately evidenced live installer download was intentionally skipped). Duration was approximately 14.6 seconds.

Type verification:

```sh
npm run typecheck
```

Result: **passed** (`tsc --noEmit` and `tsc -p tsconfig.node.json --noEmit`).

The targeted suites exercised URL/header/redirect fencing, screenshot validation and state transitions, store connector checkpoints, gzip identity-length and resume/error paths, native backup bridge validation, controller streaming import/download, archive cryptography, restore activation rollback, and UI/API contracts. The malformed-image probe above was the only additional scratch exploit probe retained as output; it performed no external write.

## Recommended fix order

1. Replace screenshot enums/dimension mapping from the current official OpenAPI/help contract and add a fixture test that rejects every non-enum key.
2. Move live/demo authority out of renderer localStorage and bind it in main/controller state.
3. Pin uploaded artifacts to one descriptor; fully decode screenshots; validate methods and an exact, non-overlapping range partition before the first part write.
4. Design explicit, user-confirmed recovery for `AWAITING_UPLOAD`/expired Apple reservations while preserving the no-automatic-replay invariant.
5. Tighten resumed HTTP segment checks and native/browser download header requirements.
