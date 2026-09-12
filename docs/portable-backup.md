# Portable backup primitive and per-vault key slots

Scope: `packages/backup/archive.ts` (encrypted archive envelope) and `packages/credentials/{vault,directory-key-provider}.ts` (per-vault key slots and write locking). This document records the contract and the fixes applied for the independent Opus 5 review `docs/verification-assets/v4-backup-crypto-review.md`, and the low-severity findings intentionally left residual. It does not cover `snapshot.ts` or the restore/activation transaction (owned elsewhere).

## Archive envelope

A portable backup is a single file beginning with the magic `APPOPSB1`, followed by a JSON header and a sequence of AES-256-GCM frames. Nothing plaintext is ever written to disk.

- **Data key**: a random 32-byte key per archive. Every frame is sealed with nonce `fileNonce(8) || frameIndex(4)` so no nonce repeats within or across archives.
- **AAD** for each frame is `MAGIC || sha256(header) || frameIndex || context`, where `context` is the literal `entry` for a metadata frame and `sha256(entryMetadataJSON) || partIndex` for a data frame. This binds every data frame to its entry's kind/path/size/digest and to its ordinal position; reordering, deleting, or splicing frames is rejected.
- **Key wrap**: the data key is sealed under a passphrase-derived key with the canonical `base` object (schema, KDF name/params, salt, file nonce) as AAD. The header digest covers the wrap, so header and body cross-authenticate.
- **End marker**: a trailing `end` frame carries the entry/byte counts; `readBackup` also requires the read position to equal the file size, which rejects trailing garbage and concatenated archives.

Frames are bounded: metadata ≤ 64 KiB, data ≤ 1 MiB, so restore memory stays bounded regardless of archive size. The format applies no compression (1:1 ciphertext-to-plaintext), so there is no expansion-bomb vector.

### Structural invariants (writer ↔ reader symmetry) — F3

`readBackup` requires entry 1 to be the `manifest` at `manifest.json`, no other manifest, and exactly one `database` at `operations.sqlite`. `writeBackup` now enforces the **same** invariants before it reports success, so a caller that emits a malformed shape fails loudly at backup time (recoverable) instead of producing a file that only fails at restore time (unrecoverable). The partial file is removed on any failure.

### Exact-path dedupe and case collisions — F2

Duplicate detection is on the **exact** path (via a bounded 16-byte digest, see F9), not a case-insensitive fold. On Linux and case-sensitive volumes `Assets/Logo.png` and `assets/logo.png` are distinct files and both are backed up. Case collisions are a **restore-target** concern, not an archive concern: restore rejects a case-insensitive collision on the target *before* activation (target creation uses `O_EXCL`, owned by the restore transaction). The archive never silently renames.

### Source entry rules — F12, F6, F14

- An entry sets **either** `data` **or** `file`, never both (rejected — mixing would take bytes from one and the mode bit from the other).
- Failures opening a source file are mapped to `BACKUP_UNSAFE_FILE` and never carry the absolute host path (previously a raw `ELOOP`/`ENOENT`/`EACCES` errno leaked the path to the UI and logs).
- `backupPath` rejects traversal, absolute paths, backslashes, empty/`.`/`..` components, trailing dot/space, Windows device names, control bytes `\x00–\x1f` **and `\x7f`**, a total length over 2048, and any single component over **255 bytes** (which would otherwise surface as a raw `ENAMETOOLONG` at restore).

### KDF work factor and versioning — F4

The passphrase-derived key uses scrypt with `maxmem = 64 MiB`:

| Schema | Parameters | Written | Read |
|---|---|---|---|
| 1 | `N=2^15, r=8, p=1` | no | yes (pre-release compatibility) |
| 2 | `N=2^15, r=8, p=3` | yes | yes |

New archives are written as **schema 2**. Schema 1 remains readable so pre-release archives keep opening. The OWASP Password Storage Cheat Sheet gives the scrypt minimum as `N=2^17, r=8, p=1` and lists `N=2^15, r=8, p=3` as an equivalent-strength alternative; raising `p` rather than `N` keeps memory at 32 MiB (under the 64 MiB cap) while clearing the minimum, and stays well inside OWASP's sub-second budget (~340 ms on the review host). The header's `schema`/`N`/`p` are validated against the known set and are authenticated (they are part of the wrap AAD and the header digest), so altering them is rejected.

### Cancellation — `{ signal?: AbortSignal }`

`writeBackup` and `readBackup` take an optional trailing options object; the positional API is unchanged. The signal is checked at start, around the KDF handoff, and during the frame I/O loops. Cancellation surfaces as an `AppError` with code `BACKUP_CANCELLED`. On any failure mid-entry, `readBackup` invokes the sink's optional `abort()` so a caller writing to a staging file can close its handle and drop the partial file; `BackupEntrySink.abort?()` is optional and existing sinks are unaffected.

## Per-vault key slots and write locking

Each vault directory owns a separate OS-keyring slot (`key-slot.json` → a `vault-<uuid>` account), so a restored vault can be staged without replacing the live key and legacy vaults keep their original shared account.

### Cross-process key-creation exclusion — F1, F5

Master-key creation and every destructive write (`set`, `remove`, and the key mint inside them) run under a **cross-process exclusive lock** on the canonical vault directory (`.vault.lock`, published with `O_CREAT|O_EXCL`). Previously two vaults constructed on one empty directory could both observe "no key", both mint a master key, and the second overwrite would strand the first credential permanently. Now a losing racer re-reads the freshly minted key instead of minting its own. `remove()` runs under the same lock so it cannot interleave with a snapshot (which would list an id and then fail to read it) or race a concurrent `set` on the same id.

Stale locks are reclaimed safely: a lock whose recorded owner PID is gone on this host, or whose timestamp is older than the stale threshold (30 s — an individual write is sub-second), is moved aside with an atomic `rename` (only one racer wins) and re-created. The real mutual exclusion remains the `O_EXCL` create, so reclamation can never let two owners coexist.

### Read-only status probe — F7

`DirectoryKeyProvider.getKey()` is read-only: it resolves an existing slot or a legacy directory but never creates a directory or a slot file. A slot is allocated only on the first `setKey`, published durably (file `fsync` plus a best-effort parent-directory `fsync`). A `status()` availability probe therefore no longer materializes a slot in a directory the user never wrote to — which also protects the restore staging contract (F8): staging must establish its own slot on first write rather than inheriting one from a preflight probe.

### Bounded snapshot — F9, F13 (partial)

`snapshotRecords()` is bounded by both a 10,000-record count cap and an explicit **64 MiB total-plaintext cap**, and the duplicate-path set in the archive stores 16-byte digests (≈ 3 MB at the entry limit) rather than full paths (which could reach ~920 MB).

## Intentionally residual low-severity findings

These were judged not worth the change now and are recorded so they are not re-litigated.

- **F8 (contract note, not a defect):** the legacy detector binds a slotless directory that already holds `*.cred.json` to the shared default account. This is correct for the upgrade case. Restore must create the staging slot *before* writing any ciphertext into staging (or write only through a vault whose provider has already resolved), or staging would be misclassified as legacy. The F7 fix (no slot on read) supports this; enforcement is in the restore transaction, out of scope here.
- **F11 (double read):** each source file is streamed once to compute size/digest and again to emit frames, and a file changed between passes discards the whole archive after the fact. Single-pass framing with a trailing per-entry digest would avoid the second read; deferred to keep the AAD binding simple. Callers should treat concurrent modification of a source file as discarding the backup.
- **F13 (heap plaintext):** `snapshotRecords()` returns decrypted credentials as JavaScript strings that cannot be zeroed, and holds the in-memory write lock across all sequential decrypts. The on-disk requirement (no plaintext vault written) is met; this is residual heap exposure and a within-instance write-stall during a fenced backup checkpoint, not a disk or cross-instance correctness issue.
- **F15 (cosmetic):** the credential layer mixes a user-facing Korean `storage_corrupted` message with developer-facing English messages elsewhere. Left as-is; the Korean message matches the app's user-facing surface.
