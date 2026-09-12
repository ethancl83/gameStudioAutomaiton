# AppOps Desktop — Live browser→controller final smoke

Date: 2026-09-11 · Worker: Opus 4.8 · Scope owned: `apps/desktop/**`, `tests/desktop-security.test.ts`, `docs/desktop-usage.md`.

## Harness (isolated, no real accounts/sites)
- Real controller/service/queue/**BuildKeyManager**/social connectors started from source via `/tmp/appops-final-smoke/harness.ts` with:
  - **memory KeyProvider** (no OS keyring) → `CredentialVault(dir/credentials,{keyProvider})`; `/state` vault backend shows `memory`.
  - **injected fetch** answering only official origins (api.x.com, graph.threads.com/net) with fake data (account **1111**, fake token/code, fake posts/mentions). Never contacts real sites (transport origin-allowlist guarantees it).
- Data dir `/tmp/appops-final-smoke/data`, controller port 4319, Vite 5199. Root dev servers (4317/5175) untouched. Native Electron window NOT attempted (host sandbox; no `--no-sandbox`) — this smoke is browser→controller.
- Fake material generated with real tools: `ssh-keygen` ed25519 deploy key + pinned `known_hosts`; `keytool` RSA-2048 keystore (base64).

## Backend end-to-end (real API + queue + BuildKeyManager, verify.mjs): 26/28 checks, 0 real failures
Build keys (bwrap isolation available, `/dev/shm` tmpfs):
- register SSH (ssh-keygen validate) → fingerprint `SHA256:ra1J…`, publicKey present, **no secrets in response** ✓
- register Android (keytool `-exportcert` + jarsigner possession check) → cert `AF:CE:EA:…`, details.keyAlias/expiresAt, **no secrets** ✓
- bind android + ssh dependency (`addons/private_sdk`) to project ✓
- **delete in-use → 409 BUILD_KEY_IN_USE** ✓ · unbind → delete unbound → deleted ✓
- rotate/update → version bump ✓ (see UI fix below)
- `/state.buildCredentials` metadata-only (no `credentials` field; only field-*names* in `credentialFields`, no token values) ✓

Social (built-in connector via injected fetch, real durable queue):
- X OAuth start → authorizationUrl on x.com; **callback with fake code** → connection connected, accountId auto-normalized to **1111** ✓
- social policy save (enabled) ✓ · immediate create-post → run **succeeded** via queue, post resource in state ✓
- list-posts (sync) ✓ · reply ✓ · scheduled post created → **cancel** → status cancelled ✓
- unsupported op (list-news on X) surfaces failed/honest error ✓
- `/state.connections` carry **no token values** ✓ (the 1 "fail" was a false positive: `credentialFields` lists field *names*)

## UI (Orca browser → Vite → controller), screenshots in /tmp/appops-final-smoke/
- **커뮤니티**: X channel "스튜디오 X · 1111" 연결됨; 게시물/멘션/답글 rendered with metric chips (like_count/impression_count…); project selector; 예약 게시 + 자동화 정책 sections. `shot-community.png`
- **UI-originated write**: opened 게시물 작성, typed text, 게시 → "게시 작업이 생성되었습니다"; backend shows **2 create-post runs succeeded** → UI→controller→queue confirmed.
- **환경·정책 → 빌드 서명·SSH 키**: 보관함 `memory`; 2 keys with 지문/호스트/공개키/버전 only, no secrets; 수정·회전/삭제. `shot-buildkeys.png`
- **UI-originated rotate**: 수정·회전 label change → save → version 2 (validated the fix below live).
- **프로젝트 → 빌드 보안**: bound Android keystore + SSH dependency row (ssh://…/sdk.git, main, addons/private_sdk). `shot-buildsecurity.png`

## UI issue found & fixed (owned file)
- `RotateBuildCredentialModal` (BuildKeysSection.tsx) omitted `credentials` for label-only edits → backend `PUT /build-credentials/:id` requires a `credentials` object and returned `INVALID_INPUT`. **Fixed**: always send `credentials` (default `{}`); backend re-validates with stored secret and bumps version. Verified live via UI (version→2).
- No other UI defects. No root backend issues found (deletion, 409, OAuth, queue, metadata-hygiene all correct).

## Gates
- `npm run typecheck` clean (full, incl. root packages) · `tests/desktop-security.test.ts` 10/10 · `npm run build` (tsc + vite) succeeds.

## Cleanup
- Harness controller + Vite killed; my browser tab closed; ports 4319/5199 down; root 4317/5175 still 200; fixture removed. Screenshots retained under /tmp/appops-final-smoke/.
