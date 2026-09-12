# v4 isolation, setup, backup, and readiness design review

Date: 2026-09-11  
Review type: read-only static design review  
Host evidence available: Linux only; no macOS or Windows runtime evidence was produced by this review

## Executive decision

v4 should not claim “fully ready” from source/C# compilation or tool detection alone. The narrow releasable contract is:

1. A runner is ready only for a specific project, target, and runner when its required tool versions and modules are present and its isolation backend has passed a current behavioral probe.
2. Windows builds run through a native AppContainer helper that validates a structured manifest, launches suspended with zero network capabilities, assigns the child to a kill-on-close JobObject before resume, and grants only per-run filesystem access. App-managed, immutable tool images are the supported default; arbitrary SDK roots are not modified opportunistically.
3. macOS `sandbox-exec` is a fail-closed, version-qualified backend rather than a generally supported security promise. Project-controlled build scripts never receive signing keys; unsigned build and trusted signing/export are separate phases.
4. Setup installs only fixed catalog artifacts with exact digests into private staged directories. Products whose redistribution, licensing, or installer behavior does not fit this model remain explicit user-provided prerequisites.
5. Portable restore is an offline/bootstrap transaction: verify and decrypt into a sibling staging directory, re-encrypt credentials under a fresh target key, fence every nonterminal operation that could write externally, then swap and health-check before retiring the old data and key.

The current Linux implementation remains useful evidence for bubblewrap only. It is not evidence for macOS sandbox inheritance, Windows SDK compatibility, AppContainer ACL cleanup, JobObject behavior, or portable restore correctness.

## Prioritized findings

| Priority | Finding | Classification | Required disposition |
|---|---|---|---|
| P0 | The generic launcher path inherits the controller's complete `process.env`; bwrap clears it internally, but a future `sandbox-exec` or Windows helper would receive host secrets. | Implementation gap | Replace the launcher prefix abstraction with a structured launch manifest and an allowlisted, replacement environment before enabling either backend. |
| P0 | `sandbox-exec` is deprecated and Apple documents the underlying sandbox interfaces as unsupported for third-party use. | Feasibility and release-evidence gap | Gate by an actual behavioral probe and tested OS-version matrix; fail closed. Do not market it as a durable Apple-supported boundary. |
| P0 | A Windows child started before JobObject assignment has a kill-tree escape race; filesystem access is DACL/SID based and profile deletion does not undo external ACL changes. | Design gap; no Windows evidence | Create suspended, assign to a no-breakaway kill-on-close job, then resume. Use crash-safe exact-ACE journaling or, preferably, stable app-managed tool images. |
| P0 | The current backup is a small logical JSON export of projects/settings with an unkeyed hash. It omits SQLite run/effect/event evidence and is neither confidential nor portable. | Implementation gap | Implement authenticated envelope encryption, SQLite online backup, complete manifest coverage, offline staged restore, path rebasing, and fresh-target-key credential re-encryption. |
| P0 | Store construction recovers jobs and queue startup follows immediately, so restoring a database can replay queued or prepared work before review. | Implementation gap | Rewrite/fence restored nonterminal operations before the restored `Store` can open or the queue can start; no restored external write may auto-replay. |
| P1 | Readiness uses “any available toolchain”, global provider connection, and global signing-key existence; the local runner is synthesized as ready. | Confirmed logic defect | Evaluate requirements per project + target + runner + operation, including isolation, versions/modules, project bindings, credentials, provider scopes, and app mapping. |
| P1 | Tool scanning finds conventional per-user installs, but securely granting an entire home directory defeats isolation; rejecting all home paths makes those detections unusable. | Contract mismatch | Support narrowly validated app-managed public tool roots outside the source/vault/data trees; treat ordinary home installs as detected-but-unusable until explicitly staged. |
| P1 | The current code detects tools but has no fixed catalog download/stage/activate lifecycle. | Implementation gap | Add a source-pinned catalog, streaming digest verification, hostile-archive defenses, atomic activation, and explicit private/manual install states. |

## 1. Runner launch contract

### Current contract problems

- `apps/runner/sandbox.ts:7-18` models isolation as either `bwrap` or `none`, while an injected launcher is just an executable plus argv prefix. That shape cannot faithfully carry canonical read-only/read-write roots, policy version, sanitized environment, cancellation semantics, or an isolation attestation.
- `apps/runner/execute.ts:179-207` merges `process.env` into every child. The built-in bwrap command uses `--clearenv`, but that does not protect a macOS or Windows injected launcher. Passing the inherited environment to a helper and asking it to filter is too late: the helper itself has already received the secrets.
- `apps/runner/execute.ts:118-149` invokes `taskkill` asynchronously on Windows. It neither proves assignment before execution nor provides a durable parent-death contract.
- `apps/runner/remote.ts:25` treats the mere presence of a custom launcher as ready. `/health` must report probe results and backend/policy identity, not configuration presence.

### Required replacement

Use a versioned, structured `IsolationLaunchRequest` rather than a prefix:

```text
policyVersion
backend: windows-appcontainer | macos-sandbox-exec | linux-bwrap
commandKind: native | approved-batch
executable + argv
canonicalReadOnlyRoots[]
canonicalReadWriteRoots[]
workingDirectory
minimalEnvironment
timeout/cancellation channel
expected project/target/toolchain identifiers
```

The runner must construct `minimalEnvironment` from scratch. It may include platform basics and explicitly resolved tool variables, but never copy the global environment and subtract a blacklist. Credentials, provider tokens, Keychain settings, arbitrary proxy variables, and user shell initialization are absent.

All roots must be canonicalized before launch; reject aliases that overlap protected roots, filesystem roots, user-home roots, or one another with conflicting access. Reject symlinks, junctions, reparse points, and mount crossings that can reach outside the manifest. A validated app-managed root such as a sibling `dataDirectory + ".tools"` may be mounted read-only, but the store, credential vault, backup staging area, and source snapshots are separate protected roots. Never grant all of a home directory or arbitrary dot-directories merely because a scanner found an SDK there.

Health should expose backend ID, policy version, last probe time/result, supported target/tool versions, and cleanup health. A target may become ready only after a fresh allow/deny/network/kill behavioral probe; launcher presence is not readiness.

## 2. Windows AppContainer helper

Microsoft's AppContainer documentation makes filesystem access an explicit security contract: access to external resources requires both a suitable integrity label and a DACL grant to the package/capability SID. The profile also has its own persistent LocalAppData/TEMP area. See [Implementing an AppContainer](https://learn.microsoft.com/en-us/windows/win32/secauthz/implementing-an-appcontainer) and [AppContainer isolation](https://learn.microsoft.com/en-us/windows/win32/secauthz/appcontainer-isolation).

### Secure executable sequence

1. Accept a length-bounded structured request over stdin or a named pipe; never construct it from a shell command string.
2. Resolve and validate the full executable path, working directory, and every root. Require a per-run unique, sanitized profile name. [`CreateAppContainerProfile`](https://learn.microsoft.com/en-us/windows/win32/api/userenv/nf-userenv-createappcontainerprofile) limits the name and creates a per-user profile; a collision is a stale-run error, not permission to reuse another run's profile.
3. Create the run's copied source snapshot, output, home, and temp directories under an app-owned run root with security descriptors that grant this run SID modify access and carry the required low-integrity label. These directories are disposable; do not grant the container access to the original project. The shared tool store contains only non-secret immutable files and may be initialized once with a stable read/execute grant for AppContainer packages. For any remaining ACL mutation, durably journal the exact path, SID, ACE/mandatory-label type, mask, inheritance flags, and operation before applying it. Do not replace whole DACLs. Do not use hard links when staging tools because the link shares the source file object's ACL.
4. Create pipes and a JobObject first. Set `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`; do not permit breakaway. The helper remains alive while proxying stdout/stderr, and parent disconnect closes or terminates the job.
5. Build `STARTUPINFOEX` with two attributes: `PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES` and `PROC_THREAD_ATTRIBUTE_HANDLE_LIST`. The security capabilities contain the run's AppContainer SID and **zero capability SIDs**, so no internet/private-network capability is granted. Limit inherited handles to the explicit stdio set. Attribute buffers must remain alive until the process has been created and the attribute list deleted. See [`UpdateProcThreadAttribute`](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute).
6. Call `CreateProcessW` with an exact application path, mutable correctly quoted command-line buffer, a sorted double-NUL Unicode environment block, `EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT | CREATE_SUSPENDED`, and no shell. See [`CreateProcessW`](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-createprocessw) and [process creation flags](https://learn.microsoft.com/en-us/windows/win32/procthread/process-creation-flags).
7. Call `AssignProcessToJobObject` while the primary thread is suspended; if it fails, terminate the process and fail the run. Only then resume. Descendants are associated by default when breakaway is not allowed; current Windows supports nested jobs, but assignment failure in a restrictive host job must fail closed. See [`AssignProcessToJobObject`](https://learn.microsoft.com/en-us/windows/win32/api/jobapi2/nf-jobapi2-assignprocesstojobobject) and [Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects).
8. On normal completion, cancellation, parent loss, or helper failure: terminate/wait for the job, close child handles, remove only the journaled run-SID ACEs, close profile handles, and delete the profile. Microsoft states that a failed [`DeleteAppContainerProfile`](https://learn.microsoft.com/en-us/windows/win32/api/userenv/nf-userenv-deleteappcontainerprofile) leaves profile status undetermined and should be retried. Startup repair must replay cleanup journals before reporting healthy.

### Important compatibility limits

- A zero-capability AppContainer is the correct default for no networking. Test DNS, IPv4/IPv6 internet, local network, and loopback because Windows treats these as distinct capability paths; do not weaken the token to make one SDK pass. See Microsoft's [network isolation guidance](https://learn.microsoft.com/en-us/windows/apps/develop/networking/sockets) and [AppContainer IPC restrictions](https://learn.microsoft.com/en-us/windows/apps/develop/communication/interprocess-communication).
- Visual Studio/MSBuild, Windows SDK tools, Unity, and Unreal may depend on registry views, COM, named pipes, services, licensing, or DLL discovery not present in an AppContainer. Source compilation of the helper proves none of these. Do not add broad capabilities such as registry access speculatively; mark that exact engine/target unavailable until its native smoke test passes.
- Windows plans currently resolve `gradlew.bat` and Unreal `RunUAT.bat`. `CreateProcessW` does not execute batch files directly. Keep the normal request shell-free; if batch support is unavoidable, make it an explicit `approved-batch` command kind generated only by the trusted planner, invoke the fixed full path to `cmd.exe`, reject command metacharacters/control characters, and test Windows quoting with hostile paths. Prefer a native Java/Gradle entry point where feasible. Unreal's nested batch behavior requires real-Windows evidence.
- App-managed immutable tool images are much safer than per-run ACL changes to arbitrary vendor installs. A stable `ALL APPLICATION PACKAGES` read/execute grant is acceptable only because that managed root is defined to contain public, non-secret tool binaries; never apply it to a vendor install, project, cache, credential, or user directory. If external roots are ever allowed, use the exact-ACE/mandatory-label journal and crash recovery above. Deleting an AppContainer profile does not remove access-control changes placed on those roots.

## 3. macOS sandbox and signing

Apple DTS states that `sandbox-exec` is deprecated and `sandbox.h` is unsupported; this is a release-risk fact, not merely missing local testing. See [Apple Developer Forums thread 661939](https://developer.apple.com/forums/thread/661939). Apple's supported application-facing model is the signed [App Sandbox](https://developer.apple.com/documentation/xcode/configuring-the-macos-app-sandbox), which does not directly solve arbitrary third-party compiler execution.

If v4 still ships a `sandbox-exec` backend, its contract should be narrow and fail closed:

- Generate a deny-default profile from canonical trusted paths only; pass the profile as argv, never through a shell. Escape/reject newline, NUL, and profile syntax injection.
- Permit process execution/fork plus read-only system/runtime and app-managed tool roots. Permit writes only to the unique run snapshot, output, home, and temp roots. Deny all networking.
- Create a unique private temp directory and set at least `HOME`, `TMPDIR`, `CFFIXED_USER_HOME`, XDG cache/config variables, Xcode DerivedData, Clang module cache, and engine-specific caches/logs into run-owned locations. Do not broadly allow `/tmp`; on macOS aliases such as `/private/tmp` must be covered by canonicalization tests.
- Child processes inherit an App Sandbox in Apple's documented model; `sandbox-exec` inheritance and daemonized descendant cancellation still require behavioral tests for the exact deployed profile and OS. See Apple's archived [App Sandbox entitlement reference](https://developer.apple.com/library/archive/documentation/Miscellaneous/Reference/EntitlementKeyReference/Chapters/EnablingAppSandbox.html).

Signing must be a separate trust domain. Xcode, Unity, and Unreal projects can execute project-controlled build scripts, so the build phase must not see login Keychains, `~/Library/Keychains`, certificate private keys, provisioning profiles, or signing passwords. Build unsigned where the toolchain supports it, commit and attest the immutable output, then invoke a controller-owned trusted signing/export phase that cannot execute project scripts and reads only that attested artifact plus a temporary signing workspace. Use [Keychain Services](https://developer.apple.com/documentation/security/keychain-services/) only in that trusted phase. If an engine's supported export path cannot be proven to avoid project code after keys are exposed, signing for that target is unavailable—not a reason to mount a temporary Keychain into the untrusted build.

## 4. Fixed-catalog setup manager

The current implementation scans existing installations; no verified download/stage/activate lifecycle exists. The setup manager should use catalogs pinned with the application release rather than a mutable “latest” feed. Every entry needs platform/architecture, exact official HTTPS URL and allowed redirect origins, byte size bound, SHA-256, archive type, expected internal layout, expected version output, signature/notarization expectation, and license identifier.

Required lifecycle:

1. Download to a new `.partial` file with a byte cap and incremental digest. Resume only after a valid `206 Content-Range` matching the local offset plus a stable ETag/Last-Modified via `If-Range`; a `200` response restarts rather than appends.
2. Verify the exact digest before extraction or execution. Where available, also verify Authenticode, Apple code signing/notarization, or the vendor's detached signature; this supplements rather than replaces the pinned digest.
3. Extract into a new private staging directory with limits on entries, expanded size, and path depth. Reject absolute paths, `..`, symlinks, hardlinks, devices, reparse points, and case-folding collisions. Validate expected binaries, versions, and internal layout.
4. Atomically rename to an immutable version/content-addressed app-managed tool directory and update a small pointer. Never overwrite the active version in place. Cancellation or power loss leaves only a reclaimable staging directory.
5. Feed resolved paths through per-service `ToolSettings`/build options; do not mutate global `process.env`.

Xcode, Unity, Unreal, Windows SDK/Visual Studio, and other licensed or account-gated packages generally need a user-selected staged import or explicit external prerequisite. Copy into private staging (no hardlinks), verify digest/signature/version, and record consent/license state. Do not guess private URLs, store installer credentials, silently accept licenses, or run a host-wide elevated installer under the build sandbox. Android SDK package licenses and exact component revisions also need explicit receipts and fixed package identities.

## 5. Portable complete backup and restore

### Current gaps

- `apps/controller/operations.ts:48-70` exports only projects and settings to a size-limited JSON document with an unkeyed SHA-256. An attacker can modify the payload and recompute the hash; the export omits operation history and credentials.
- `packages/storage/index.ts:35-110` opens and recovers the database during `Store` construction. `AppService.start` then starts the queue. A restored `queued`, `prepared`, `running`, or `dispatched` write can therefore execute before a user reviews it.
- `packages/credentials/vault.ts` encrypts records with an OS-keyring master key obtained through a fixed account in `packages/credentials/key-provider.ts`. Copying vault ciphertext to another machine cannot decrypt it, while overwriting the target's fixed key before a filesystem commit can strand either the old or new vault.
- Snapshot exclusion currently receives the store directory, but an injected credential vault may live elsewhere. Credential vaults, backup staging, managed tools, key material, and backup destinations must be registered protected roots. A backup destination inside a project/source tree must be rejected to prevent recursive or secret-bearing snapshots.

### Archive contract

- Fence controller mutations for the backup checkpoint, then use SQLite's online backup facility instead of copying the database/WAL files. Node exposes [`sqlite.backup`](https://nodejs.org/api/sqlite.html#sqlitebackupsource-db-path-options) starting in Node 22.16.0; the current `>=22.13` engine range therefore needs a runtime guard, engine-floor change, or another safe implementation. SQLite documents the consistency properties of the [online backup API](https://www.sqlite.org/backup.html).
- Include the SQLite backup (projects, runs, effects, events, settings), portable vault records, required artifacts/media, and a versioned manifest. Exclude source snapshots, the destination/backups themselves, partial downloads, caches, transient operation directories, and reproducible tool binaries; include tool catalog identities/digests so requirements can be reconstructed.
- Rebase internal artifact paths at restore and rehash every restored file. External project roots are never assumed to exist on the target; mark them `relink_required`. Connections, remote runners, app mappings, and readiness become unverified until rechecked.
- Use a random data-encryption key and AEAD encryption for archive entries or bounded chunks, with unique nonces and AAD containing archive schema, entry path, size, and digest. Wrap the DEK under a passphrase-derived key using a versioned, bounded-memory KDF (scrypt or Argon2id), a random salt of at least 16 bytes, and authenticated parameters. Node's [crypto API](https://nodejs.org/api/crypto.html) provides scrypt and authenticated cipher primitives. Never write a plaintext vault export to disk.

### Restore transaction

1. While the live controller remains untouched, stream-decrypt into a new sibling staging directory; authenticate entries before accepting them and enforce the same hostile-path and size limits as setup extraction.
2. Run SQLite integrity and foreign-key checks and validate archive/schema/catalog versions. Reject absolute internal paths and any manifest reference that escapes staging.
3. **Before constructing `Store` on the staged database**, fence every nonterminal restored operation. At minimum, any operation with a write effect or external intent becomes `action_required/restored_review_required`; preserve run/effect/event/idempotency evidence exactly and record a restore event. Prefer pausing all nonterminal work and disabling automation until explicit review. There must be no automatic provider, deployment, signing, or build replay.
4. Never copy an OS-wrapped key blob. Export the source vault data key into the archive's authenticated encrypted key bundle (or export records under an equivalent portable vault envelope), then unwrap it only in memory during restore. Rewrap it into a new versioned target OS-keyring slot, or rotate by re-encrypting every credential under a fresh target key and the current vault AAD/format. Introduce keyring slots keyed by a vault-key ID plus an on-disk pointer; the present fixed-account `KeyProvider` needs create/select/delete slot operations. Create the new slot without overwriting the live slot.
5. Write an authenticated pending-restore marker, stop services, close SQLite, and let a bootstrap process atomically swap the staged and live data directories. This cannot be a live `Store` method, particularly on Windows where open files block replacement.
6. Boot with the staged pointer/key, run health and integrity checks, and retain the old directory and old key slot until success. Roll back both pointer and directory on any failure. Only then schedule recovery deletion of the old directory/key.

The restore migration must define an explicit legal transition for fenced operations. Current retry semantics are not enough if an `action_required` run cannot be resumed safely; user review must create a new attempt or an auditable resume action while retaining the original external-intent evidence.

## 6. Readiness must be project- and target-specific

`apps/controller/operations.ts:35-42` currently reports toolchains ready when `some(toolchain.available)`, provider readiness from any global connected account, and signing readiness from any Android key. It also synthesizes the local runner as ready. This allows an unrelated Godot installation or key to satisfy an Android/iOS/Unreal project.

Compute a requirement result for `(project revision, target, operation, candidate runner)` with `ready | action_required | unavailable`, reason codes, and evidence timestamps:

| Target family | Minimum target-specific requirements |
|---|---|
| Godot | Matching editor, target export template/preset, and target extras; Android needs exact JDK/SDK components, iOS finalization needs a proven Mac/Xcode/signing path. |
| Unity | Matching editor, installed target module, valid license state, build profile; Android adds JDK/SDK/NDK, iOS adds Mac/Xcode/signing. |
| Unreal | Matching engine/UAT, plugins and target compiler/SDK; Windows needs validated VS Build Tools/Windows SDK, Android its exact JDK/SDK/NDK, iOS Mac/Xcode/signing. |
| Native Android | Wrapper/distribution, JDK, exact compile SDK/build tools, required offline dependency cache, license receipts, and a release key bound to this project. |
| Native iOS | Ready Mac isolation backend, selected compatible Xcode/license, scheme/export options, and team/certificate/profile bound to the project bundle identifier. |

Deployment readiness additionally requires an allowed project connection, required scopes/roles, correct provider app mapping for the package/bundle ID, a compatible signed artifact, and satisfied policy. A globally connected account or globally present key is not sufficient. Remote readiness must compare the runner's actual target/tool versions and current isolation attestation, not just platform, protocol, and `body.ready`.

## Essential acceptance tests

These tests are release gates. Native OS tests distinguish compiled implementation from actual security evidence.

### Windows-native

- Inspect the child token and prove `TokenIsAppContainer`, the expected AppContainer SID, and no network capability SIDs.
- Prove read/write only in run source/output/temp; prove tool roots are read/execute only; prove sentinels in store, vault, user home, sibling projects, backup staging, and unrelated temp paths are unreadable/unwritable.
- Test DNS, IPv4, IPv6, internet, LAN, and loopback denial. Test stdout/stderr handle inheritance and absence of unrelated inherited handles.
- Spawn a child and grandchild, including a stubborn/detached attempt; cancellation, helper crash, and coordinator death must leave none alive.
- Force failure after every ACL/profile/job step. On restart, remove only the exact run ACEs and profile; concurrent unrelated ACL edits must survive.
- Exercise paths containing spaces and shell metacharacters. Run real smoke builds for each supported Windows SDK/engine combination; a C# compile-only CI job is separately useful but not readiness evidence.

### macOS-native

- Probe allowed writes and forbidden store/vault/home reads, tool-root writes, network access, canonical `/tmp` aliases, symlink escapes, child/grandchild inheritance, cancellation, and helper death on every supported macOS version.
- Run real engine/Xcode builds with redirected HOME/TMP/caches. During the untrusted build, assert that Keychain private keys and provisioning credentials are inaccessible.
- Prove trusted signing consumes only an attested immutable output and does not execute project build phases. If that proof fails for a target, the target remains unavailable.

### Setup manager

- Reject wrong digest/size, disallowed redirects, resume offset/ETag mismatch, truncation, archive traversal, symlink/hardlink/reparse/device entries, case collisions, expansion bombs, and false version layouts.
- Inject cancellation/crash at download, verify, extract, rename, and activate; the old tool version must remain usable and partial state must be safely reclaimable.
- Prove managed roots exclude store/vault/source/backup roots and are mounted read-only in builds. Prove private installers require explicit staged input and never trigger silent elevation/license acceptance.

### Backup/restore

- Back up while WAL writes occur and verify SQLite integrity, relationships, and a complete run/effect/event round trip. Validate large artifacts with bounded memory.
- Reject wrong passphrases, altered manifest/ciphertext/tag/KDF parameters, duplicate paths, path traversal, expansion bombs, and unsupported future schemas without touching live state.
- Restore onto a clean machine and one with an existing vault. Inject failure at every key-slot, staging, pointer, swap, boot-health, and cleanup boundary; either the old or new state must remain bootable, never a mixed state.
- Seed queued/prepared/running/dispatched external writes before backup. After restore, assert zero provider/network calls and explicit review state while preserving idempotency/effect/event evidence.
- Verify project relinking, artifact path rebasing/digests, runner/provider re-verification, source/vault/backup exclusion, and non-recursive repeated backups.

### Readiness

- An unrelated installed tool must not make another project/target ready. A detected home-directory tool must be unusable until safely staged or explicitly validated.
- The same project with two targets must produce different requirements. A remote runner with the right OS but wrong SDK/module or a stale/failed isolation probe must remain unavailable.
- A valid key for project A and a connected provider account without the required app/scope must not satisfy project B.

## Release evidence boundary

| Area | Evidence in this review | Still required before “fully ready” |
|---|---|---|
| Linux bwrap | Existing implementation/static tests were inspectable. | Preserve regression tests; not evidence for other OSes. |
| Windows helper/AppContainer/Job/ACL | Design checked against primary Microsoft contracts. | Native compile plus behavioral AppContainer, ACL-crash-recovery, kill-tree, network, and real SDK/engine runs on supported Windows versions. |
| macOS sandbox/signing | Design checked against Apple documentation; `sandbox-exec` support risk confirmed. | Behavioral matrix on every supported macOS version and engine; independent unsigned-build/trusted-sign proof. |
| Setup manager | No current implementation. | Catalog provenance review, hostile-input/fault-injection tests, and per-vendor license/redistribution decisions. |
| Portable backup/restore | Current export and storage/vault recovery code were inspectable; proposed transaction is not implemented. | Crypto vectors, SQLite concurrency, clean/existing-keyring portability, external-write no-replay, and crash-atomic restore tests. |
| Readiness | Aggregate readiness flaws are present in current controller code. | Requirement evaluator tests across every supported project/target/runner and negative binding cases. |

Until those native gates pass, expose the affected target as `unavailable` or `action_required` with a precise reason. Absence of test hardware is an evidence gap, not permission to infer readiness from source compilation or tool discovery.
