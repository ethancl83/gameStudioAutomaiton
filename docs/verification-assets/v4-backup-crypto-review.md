# v4 portable backup primitive and per-vault key slot review

Date: 2026-09-11
Review type: independent read-only review (no source edits, no OS keyring writes, no commits)
Reviewer model: Opus 5 (high effort)
Host evidence: Linux, Node v22.22.1

## Scope

Frozen scope for this review, as dispatched:

| File | Scope |
|---|---|
| `packages/backup/archive.ts` | whole file |
| `packages/credentials/directory-key-provider.ts` | whole file |
| `packages/credentials/vault.ts` | `snapshotRecords` and the new `DirectoryKeyProvider` default |
| `tests/portable-backup.test.ts` | whole file |

Requirement baseline: `docs/verification-assets/v4-design-review.md` section 5 (Portable complete backup and restore) plus its backup/restore acceptance test list.

Explicitly **out of scope** and not reviewed: `packages/backup/snapshot.ts`, `apps/controller/*`, activation/bootstrap/swap code. `snapshot.ts:29-45` was read only to determine whether an archive-side contract gap is currently live or latent; no finding below is raised against it.

## Bottom line

The envelope cryptography is sound. Every confidentiality and integrity property I probed held: per-frame AEAD with a unique nonce, AAD binding of the file magic, header digest, frame index, entry metadata digest, and part index. Frame reorder, frame deletion, cross-archive splice, foreign header, trailing-garbage append, KDF-parameter tampering, schema bump, single-bit ciphertext flip, truncation, and wrong password are all rejected, and a wrong password never reaches the entry callback. Frames are capped at 1 MiB so restore memory stays bounded. No plaintext credential material reaches disk.

The defects are on the edges of that core: two confirmed data-loss or availability bugs in the credential layer, one class of archive that the writer produces successfully and the reader can never read, a KDF work factor below the current OWASP minimum, and unmapped filesystem errors that leak absolute host paths.

**This review does not bless full backup readiness.** The three passing tests in `tests/portable-backup.test.ts` exercise the primitives and one happy-path snapshot round trip. They do not cover the restore transaction's failure injection, the pointer/swap/boot-health boundaries, or the "no provider call after restore" assertion that section 5 requires. Readiness must be judged after the restore and bootstrap code lands.

## Findings

Severity reflects impact on a released backup feature. Every finding marked **Confirmed** was reproduced by a throwaway probe test run against the working tree; probes were read-only and used temp directories and injected fake key providers only.

### F1 (High, Confirmed) Two vault instances on one empty directory silently destroy credentials

`packages/credentials/vault.ts:266-268` generates a fresh master key whenever `getKey()` returns undefined and the directory holds no ciphertext, then writes it through `packages/credentials/directory-key-provider.ts:60`. The check at `vault.ts:260` and the fresh-key write at `vault.ts:266-267` are not one atomic step, and `#withWriteLock` (`vault.ts:289-293`) is per-instance. The slot file does not help: both instances resolve the *same* slot account, so the second `setKey` overwrites the first key inside a live slot.

Failure scenario: two `CredentialVault` objects are constructed on the same empty directory and each writes one credential concurrently. Both pass the empty-vault check, both mint a key, the second overwrite wins, and the first record is permanently undecryptable.

```
V5 keyring accounts: [ 'vault-f05dc2fa-aa93-44c5-a71b-bfb1c44f4c84' ]
V5 get one => "decrypt_failed"
V5 get two => {"token":"fixture-two"}
```

This is the exact hazard section 5 step 4 names: "Create the new slot without overwriting the live slot." The slot indirection satisfies the *cross-directory* half of that requirement; the *within-slot* half is still open. Restore makes this reachable because staging and live vaults are constructed near each other in time, and any controller path that builds a second vault on a directory another component already holds will hit it.

Suggested fix: make key creation the sole writer under a cross-instance guard. Create the master key atomically with the slot record, or write the key through an exclusive `O_CREAT|O_EXCL` sentinel in the vault directory so a losing racer re-reads instead of minting. A keyring-level compare-and-set is not available, so the exclusion has to live on disk next to the slot file.

### F2 (High, Confirmed) Case-insensitive duplicate detection makes case-distinct trees unbackupable

`packages/backup/archive.ts:81-82` normalizes each path with `normalize('NFC').toLowerCase()` before the duplicate check, and `archive.ts:123-124` repeats it on the read side. On Linux and case-sensitive macOS volumes, `Assets/Logo.png` and `assets/logo.png` are distinct files that legitimately coexist in a project tree.

Failure scenario: a source tree containing any two paths that differ only by case. `writeBackup` aborts with `백업 항목이 중복되었거나 너무 많습니다.`, deletes the partial archive at `archive.ts:90`, and the user can never produce a backup. The message names neither colliding path, so the user has no way to find the offending files.

Confirmed: `a/b.bin` plus `A/B.bin` rejects at write time and the output file is removed (probe observed `ENOENT` on the destination afterwards).

Suggested fix: dedupe on the exact path so the archive stays well-formed, and treat case collision as a separate, named condition. Either record a case-collision list in the manifest and let restore rename on case-insensitive targets, or fail with a `BACKUP_PATH_COLLISION` error that lists both paths. Keep the exact-path `Set` for the real invariant (no duplicate frames).

### F3 (Medium-High, Confirmed) The writer does not enforce the invariants the reader requires

`readBackup` demands that entry 1 be `kind:'manifest'` at path `manifest.json`, that no other manifest appear (`archive.ts:126`), and that exactly one `database` entry exist at `operations.sqlite` (`archive.ts:127`, plus the `!hasDatabase` gate at `archive.ts:119`). `writeBackup` (`archive.ts:80-89`) checks only duplicates, entry count, and total bytes.

Failure scenario: a caller emits entries in any other shape. `writeBackup` returns a summary, sets `complete=true`, keeps the file, and reports success. `readBackup` then throws on every attempt. The user holds a file they believe is a backup and it is unrecoverable.

Four variants confirmed, all written successfully and all unreadable:

| Archive shape | `writeBackup` result |
|---|---|
| no manifest entry | succeeded, `{"entries":1,"bytes":1}` |
| manifest but no database | succeeded, `{"entries":2,"bytes":3}` |
| two manifest entries | succeeded, `{"entries":3,"bytes":5}` |
| database at `other.sqlite` | succeeded |

Today's only caller, `snapshot.ts:36-38`, happens to emit manifest then database first, so this is latent rather than live. It becomes live the moment a second caller appears or the generator is reordered, and a latent silent-corruption path in a backup writer is worth closing before release.

Suggested fix: enforce the same three invariants in `writeBackup` before `complete=true`, or factor the shared structural validation into one function both directions call. Failing loudly at backup time is recoverable; failing at restore time is not.

### F4 (Medium) scrypt work factor is below the current OWASP minimum

`archive.ts:34` derives with `N=32768 (2^15), r=8, p=1, maxmem=64 MiB`, pinned again at `archive.ts:68` and validated at `archive.ts:103`.

The OWASP Password Storage Cheat Sheet gives the minimum as `N=2^17 (128 MiB), r=8, p=1`, with these equivalent-strength alternatives: `N=2^16, r=8, p=2`; `N=2^15, r=8, p=3`; `N=2^14, r=8, p=5`; `N=2^13, r=8, p=10`. The configuration here is `N=2^15` paired with `p=1`, which is one third of the listed `N=2^15` option and below every alternative on the list. OWASP's stated budget is that "calculating a hash should take less than one second."

Measured on this host:

| Parameters | Time per derivation | Memory |
|---|---|---|
| `N=2^15, r=8, p=1` (current) | 200 ms | 32 MiB |
| `N=2^15, r=8, p=3` | 341 ms | 32 MiB |
| `N=2^17, r=8, p=1` | 506 ms | 128 MiB |

Both compliant options land well inside the one-second budget. `N=2^15, r=8, p=3` is the cheaper change because it keeps memory at 32 MiB and therefore works under the existing 64 MiB `maxmem` cap with no other edit. It matters here because `passwordValue` (`archive.ts:29-31`) admits any 12-character password, and the archive is designed to be portable, so an offline attacker gets the file and unlimited guesses.

Related: `archive.ts:103` hard-pins the exact triple, so raising the work factor requires bumping `schema`. Section 5 asks for a "versioned, bounded-memory KDF"; the version field exists but there is no acceptance path for a second parameter set, which means old archives break on any future raise. Decide now whether `schema:2` archives should be readable alongside `schema:1`, and add the branch while there is only one shipped version.

### F5 (Medium, Confirmed) `remove()` bypasses the write lock, so `snapshotRecords()` is not atomic

`vault.ts:189-197` runs the whole snapshot inside `#withWriteLock` so that `set` cannot interleave. `vault.ts:166-169` deletes without taking that lock.

Failure scenario: a credential is removed while a backup is being created. `listIds()` has already returned the id, `get(id)` then raises `credential_not_found`, and the entire backup fails rather than the snapshot observing a consistent set.

```
V4 attempt 0 snapshot failed: credential_not_found
```

Reproduced on the first attempt with `Promise.all([vault.snapshotRecords(), vault.remove('id20')])`.

Suggested fix: route `remove()` through `#withWriteLock`. This also fixes the unrelated `remove`/`set` ordering gap on the same id.

### F6 (Medium, Confirmed) Raw filesystem errors escape `writeBackup` and leak absolute host paths

`archive.ts:53` opens source files with `O_RDONLY|O_NOFOLLOW` and does not map failures. `ELOOP`, `ENOENT`, `EACCES`, and `EMFILE` propagate as `NodeJS.ErrnoException`, not `AppError`, so nothing downstream can match on a `BACKUP_*` code and the message carries the full host path.

Observed, for a symlinked source file:

```
ELOOP: too many symbolic links encountered, open '/tmp/fprobe-t3qg4L/src/link.bin'
```

The behavior is also inconsistent: a directory passed as a source is correctly mapped to `BACKUP_INVALID` at `archive.ts:54`, while a symlink is not. Since `packages/domain/errors.ts:23` provides `redact` and the controller surfaces messages to the UI and logs, an absolute path from the user's machine will reach both.

Suggested fix: wrap the `open` at `archive.ts:53` and translate errno to the existing `BACKUP_INVALID` or a dedicated `BACKUP_UNSAFE_FILE`, matching how `snapshot.ts` already classifies link and special files.

### F7 (Low, Confirmed) `status()` mutates the disk

`vault.ts:73` calls `getKey()`, which routes through `DirectoryKeyProvider.resolve()` (`directory-key-provider.ts:32-58`). On a directory that does not exist, `resolve()` runs `mkdir` at line 37 and writes `key-slot.json` at lines 39-48.

```
V1 status= {"available":true,"backend":"os-keyring"}
V1 directory now contains: [ 'key-slot.json' ]
V1 keyring accounts after status(): []
```

A read-only availability probe therefore creates a directory and commits a slot identity. No keyring write happens, so nothing is destroyed, but a restore preflight that checks target vault status will leave a slot pointer in a directory that a later swap may replace, and any status call materializes a path the user never asked for.

Suggested fix: give `DirectoryKeyProvider` a read-only resolution mode used by `status()`, which reports the absent-directory case without allocating. Allocate the slot on the first `setKey` instead.

### F8 (Low) Legacy detection is content-based and will misfire on a seeded staging tree

`directory-key-provider.ts:38` classifies a directory as legacy when any `*.cred.json` is present and no slot file exists, and returns the shared default keyring account. The behavior is correct for the upgrade case and is covered by the existing test.

The hazard is for the restore code being written now. If staging ever receives vault ciphertext on disk before the staging vault's key slot is established, the provider will classify the staging directory as legacy and bind it to the shared default account instead of a fresh slot, which is precisely the outcome section 5 step 4 forbids. This is a contract note, not a defect in the current file: restore must create the staging slot first, or write records only through a vault whose provider has already resolved.

Confirmed correct today: a legacy directory gains no slot file even after a subsequent write through `DirectoryKeyProvider`, and the legacy keyring account is reused rather than replaced.

```
V2 dir after write through DirectoryKeyProvider: [ 'added.cred.json', 'old.cred.json' ]
V2 keyring accounts after write: [ 'legacy' ]
```

### F9 (Low, Measured) The duplicate-path `Set` is not bounded

`archive.ts:72` and `archive.ts:114` retain every normalized path for the life of the operation. Paths may be 2048 characters (`archive.ts:20`) and entries may number 100,000 (`archive.ts:9`).

Measured with 2,000 entries at 1,849-character paths: 18.4 MB heap delta, roughly 9.2 KB per entry. Extrapolated to the 100,000-entry limit that is about 920 MB, in a primitive whose stated property is bounded memory. Reaching it requires a valid password, so this is self-inflicted rather than an unauthenticated attack, but the limits are the contract and the contract currently permits it.

Suggested fix: store a truncated digest of the normalized path instead of the path itself. A 16-byte digest caps the set at about 3 MB at the entry limit.

### F10 (Low, Confirmed) `BackupEntrySink` has no abort hook

`archive.ts:13` defines `write` and `finish` only. On any failure inside the entry loop (`archive.ts:128-130`) the sink is abandoned with no callback, so a caller writing to a staging file has no place to close the handle or delete the partial file.

```
F3 sink threw => disk full   bytes handed to sink before failure = 1048579   finish calls = 2
```

Two earlier entries had already been finished, and the failing sink received a megabyte before the error. The doc comment at `archive.ts:93` says the caller writes only to a fresh staging tree, which makes leftover partials tolerable, but leaked file descriptors are not. Add `abort?(): Promise<void>` and invoke it from a `catch` around the loop body.

### F11 (Low) Every source file is read twice

`describe()` streams the entry once to compute size and digest (`archive.ts:58-62`), then `archive.ts:86` streams it again to emit frames. With `BACKUP_LIMITS.file` at 64 GiB, a single large entry can mean 128 GiB of reads.

The consistency check at `archive.ts:87` correctly catches a file that changed between passes, but it aborts the *entire* archive after all preceding work. Consider hashing during the single framing pass and emitting the digest in a trailing per-entry frame, or at minimum documenting that concurrent modification of any source file discards the whole backup.

### F12 (Low, Confirmed) `data` and `file` set together produce inconsistent metadata

`archive.ts:51` makes `entry.data` win, while `archive.ts:61` derives `executable` from `entry.file`. The resulting metadata mixes one source's bytes with the other's mode bit:

```
{"kind":"data","path":"mixed.bin","size":9,"sha256":"7bd73d...","executable":false}
```

`BackupEntry` (`archive.ts:11`) types both fields optional with no exclusivity. Make them a discriminated union, or reject entries that set both.

### F13 (Low) `snapshotRecords()` returns plaintext that cannot be wiped

`vault.ts:189-197` builds a `Record<string, Credentials>` of up to 10,000 decrypted records. `Credentials` values are JavaScript strings, so no caller can zero them; they persist in the heap until collection, and the doc comment's "must never persist this object" is unenforceable. The on-disk requirement from section 5 is met (nothing plaintext is written), so this is residual heap exposure rather than a violation.

If tightening is wanted, yield records one at a time through an async generator so only one credential is live at a time, and expose values as `Buffer` so the caller can zero them the way `snapshot.ts` already attempts.

Separately, the snapshot holds the vault write lock across all 10,000 sequential decrypt operations, blocking every write for the duration.

### F14 (Low) Path hygiene gaps in `backupPath`

`archive.ts:20-21` rejects `\x00-\x1f` but not `\x7f` (DEL), and imposes a 2048-character total limit with no per-component limit. Confirmed: `backupPath('a\u007fb')` and a 2000-character single component are both accepted. Most filesystems reject a component over 255 bytes with `ENAMETOOLONG`, which surfaces as a raw errno during restore rather than a mapped archive error. Add `\x7f` to the character class and cap each component at 255 bytes.

### F15 (Cosmetic) Mixed-language error surface

`directory-key-provider.ts:54` raises a Korean message while the surrounding `vault.ts` errors are English (`vault.ts:83`, `:92`, `:241`). Pick one for the credential layer.

## Verified correct

Recording these so they are not re-litigated. Each was probed, not merely read.

**Envelope and frame construction.** The nonce is `fileNonce(8) || frameIndex(4)` with a per-archive random 32-byte data key, so no nonce repeats within or across archives. The AAD is `MAGIC || sha256(header) || frameIndex || context`, where `context` is the literal `entry` for metadata frames and `sha256(entryMetadataJSON) || partIndex` for data frames. That binds every data frame to its entry's kind, path, size, and digest, and to its ordinal position, which is exactly the ordering, path, and size binding section 5 asks for. The data key is wrapped under the scrypt key with the canonical `base` object (schema, KDF name and parameters, salt, file nonce) as AAD, and the header digest covers the wrap itself, so header and body cross-authenticate.

**Tamper rejection.** All of the following were rejected:

| Attack | Result |
|---|---|
| wrong password | rejected, `onEntry` invoked 0 times |
| single-bit ciphertext flip | rejected |
| truncation (last 7 bytes removed) | rejected |
| swap two data frames within an entry | rejected |
| delete one data frame from an entry | rejected |
| splice a frame from a different archive made with the same password | rejected |
| replace the header with another archive's header | rejected |
| append trailing bytes to a valid archive | rejected |
| alter `kdf.N` | rejected, unsupported-version message |
| alter `kdf.salt` | rejected |
| alter `fileNonce` | rejected |
| bump `schema` to 2 | rejected, unsupported-version message |
| add an unknown header field | rejected |
| path traversal, absolute, backslash, empty component, `.`, `..`, trailing dot or space, NUL, Windows device names | rejected by `backupPath` |

Trailing-garbage rejection comes from the `position !== info.size` check at `archive.ts:119`, which also means a concatenated second archive cannot smuggle frames past the end marker.

**Bounded memory.** Metadata frames are capped at 64 KiB and data frames at `min(1 MiB, remaining)` (`archive.ts:110`, `:129`). The existing test asserts the largest buffer handed to a sink is at most 1 MiB, and a 2 MiB + 77 byte artifact round-trips byte-exact. Zero-length entries round-trip correctly and produce no data frames, and the `!bytes.length` guard at `archive.ts:129` prevents a zero-length frame loop.

**Expansion bombs.** The format applies no compression, so the ciphertext-to-plaintext ratio is 1:1 by construction. `fflate` is a project dependency but `archive.ts` does not use it. Combined with the declared-size checks at `archive.ts:121` and `:124-125`, there is no amplification vector. Keep it that way if compression is added later.

**No plaintext vault on disk.** The existing test asserts the fixture credential string does not appear in the archive bytes. I confirmed the only writes `writeBackup` performs are the magic, the header, and sealed frames.

**Fail-closed key slots.** A corrupt or hostile `key-slot.json` never silently re-allocates. All of malformed JSON, `schema: 2`, an account failing the `vault-[a-f0-9-]{36}` pattern, an empty file, and a symlinked slot file produced `available:false` with `보관함의 암호화 키 위치를 확인할 수 없습니다.` rather than a new slot. Slot publication uses `link()` with `EEXIST` tolerated (`directory-key-provider.ts:46-47`), so concurrent creators converge on one winner instead of clobbering. The temp file is a dotfile ending in `.slot`, which cannot be mistaken for a credential by the legacy check.

**Fresh slots do not touch existing or legacy keys.** Two fresh vault directories get distinct slots and distinct keyring accounts, a legacy directory keeps its original account and gains no slot file, and a fresh vault created alongside a populated target leaves the target's `key-slot.json` byte-identical. The existing test asserts the last of these directly.

**Destination safety.** `open(path, 'wx', 0o600)` refuses to overwrite an existing file, and the `open` happens before the `try` block so a pre-existing file at the destination can never be deleted by the cleanup at `archive.ts:90`. On any failure the partial archive is removed. `file.sync()` runs before the operation reports success.

**Key hygiene.** The password-derived key is zeroed immediately after wrapping (`archive.ts:69`) and after unwrapping (`archive.ts:107`); the data key is zeroed in both `finally` blocks. One gap: if `derive()` throws at `archive.ts:69`, the already-generated data key from line 67 is never zeroed. Moving the `randomBytes(32)` inside the `try` closes it.

## Test coverage

The three tests in `tests/portable-backup.test.ts` pass on this host.

```
tests 3 | pass 3 | fail 0 | duration_ms 1554.99
```

`tests/credentials.test.ts` also passes (26 tests), confirming the new `DirectoryKeyProvider` default did not regress the existing vault suite.

### Covered

Multi-frame streaming with a 2 MiB artifact, absence of plaintext in the archive, the 1 MiB sink bound, wrong password with zero `onEntry` invocations, truncation, single-bit tampering, independent key slots for fresh vaults, legacy record readability, and a happy-path snapshot round trip including run and effect fencing.

### Not covered, and required by section 5's acceptance list

Section 5 asks to "Reject wrong passphrases, altered manifest/ciphertext/tag/KDF parameters, duplicate paths, path traversal, expansion bombs, and unsupported future schemas without touching live state." Four of those seven have no test. Proposed minimal defensive additions, each a few lines and none requiring adversarial payloads:

1. **Altered KDF parameters and unsupported schema.** Re-serialize the header with `kdf.N = 1024`, then with `schema = 2`, and assert `readBackup` rejects with the unsupported-version message. Covers `archive.ts:103` and the version gate that F4's upgrade path will touch.
2. **Duplicate paths.** Assert `writeBackup` rejects two entries with the same path, and assert the destination file does not exist afterwards. This test will also pin whatever F2's resolution turns out to be.
3. **Path traversal.** Table-drive `backupPath` over `../escape`, `/abs`, `a/../b`, `a//b`, `C:\x`, `con.txt`, a trailing space, and an embedded NUL, asserting each throws.
4. **Trailing garbage.** Append four bytes to a valid archive and assert rejection. Guards the `position !== info.size` invariant, which is the only defense against archive concatenation.
5. **Frame reordering.** Split the archive at frame boundaries, swap two data frames within one entry, assert rejection. This is the direct regression test for the AAD ordering binding and would catch any future refactor that drops the index from the AAD.
6. **Writer/reader structural symmetry.** Assert `writeBackup` rejects an entry list with no manifest first and no database entry. Currently fails; it is the test for F3.
7. **Corrupt slot file.** Write a malformed `key-slot.json` and assert `status()` reports unavailable rather than minting a replacement slot. Covers the fail-closed path in `directory-key-provider.ts:20-30`, which is entirely untested.
8. **Legacy directory gains no slot.** Extend the existing legacy assertion to also assert `key-slot.json` is absent after a write through `DirectoryKeyProvider` and that the keyring holds exactly one account. Pins F8's contract.

### Not covered, and outside this review

The restore-transaction acceptance items from section 5 (failure injection at every key-slot, staging, pointer, swap, boot-health, and cleanup boundary; zero provider calls after restore; artifact path rebasing and rehashing; non-recursive repeated backups; backup during concurrent WAL writes) belong to the code being written now and are not judged here.

## Recommended fix order

1. F1, then F5, both in the credential layer, both data-loss or backup-failure paths.
2. F2, which blocks backup entirely for a real class of source tree.
3. F3 and F6, cheap and both about failing at the right time with the right error.
4. F4, together with a decision on multi-version KDF acceptance while only one schema has shipped.
5. Tests 1 through 8 above.
6. The remaining low-severity items as convenient.
