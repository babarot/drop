# ADR-007: The Synced version and how push and pull handle conflicts

## Status

Accepted

## Context

With automatic push and explicit pull (ADR-006), each machine's folder can fall behind drop or move
ahead of it, and both can happen at once. A push must never overwrite newer content on drop with an
old folder, and a pull must never silently drop or overwrite a local change. The CLI also reads and
writes files in a directory that other programs (editors, AI agents) write to at the same time.

## Decision

### The Synced version always points at a Version on drop

For each Site the CLI's state keeps the Synced version: the number, Entry and file list (a hash per
Path) of the Version on drop that the folder last matched. It is set only from a Version that drop
committed or that was pulled, never rebuilt from the local files. If it were rebuilt from local files
after a pull that kept local-only changes, those changes would look already sent and the next pull
would overwrite them with the old remote content.

### A push sends the whole tree with base

A push asks `POST /objects/missing` about every hash in the tree, uploads the missing Objects, and
commits with `PUT /tree` carrying the whole tree and `base` = the Synced version. If drop has moved
past `base`, the commit returns 409 and nothing is overwritten; the CLI stops for that Site and asks
for a pull.

- Every hash is asked about, not only the ones missing from the Synced version: Files from before
  ADR-004 live under old keys, and `PUT /tree` requires content-addressed Objects.
- `PATCH /tree` is not used. It applies a change to one name of an old asset pair to both names,
  which does not match the per-Path state the CLI keeps.

### A pull compares three ways, per Path

When both sides moved, a pull compares the Synced version, the local folder and the current remote
tree Path by Path. A value is a hash or "absent", and absent is a value too: deleting a file is a
change. A Path changed on one side takes that side; changed on both sides to different results is a
conflict, including "changed here, deleted there".

If there is any conflict, nothing is written to that Site. The user chooses:

- `drop pull --theirs` takes drop. The local files it discards are copied to a backup under the
  CLI's state directory first, not uploaded as a Version (that would use up the history limit).
- `drop push --force` takes the local folder, committing with drop's latest number as `base`. The
  remote content stays in the history as the previous Version.

### Ignoring applies only to untracked files

The default ignores (`.git/`, `node_modules/`, `.env*` and so on) and `.dropignore` only keep new
files from being added, as in git. A Path in the Synced version is tracked and is scanned even if a
rule matches it, so files uploaded in the UI (a `node_modules/` inside a dropped site) are not
deleted by the next push.

### Writing and reading files defensively

- A pull refuses to write through a symbolic link in a Path, and treats writing over a local file
  that exists but was not scanned (an ignored, untracked `.env`) as a conflict.
- Right before writing, a pull checks that the local files are still what it scanned.
- Paths that differ only in case are checked against the whole tree after the pull (what comes from
  drop plus what stays local), since a case-insensitive disk cannot hold both.
- A push reads each file through a handle opened with `O_NOFOLLOW` and checks it is the same file
  (dev and ino) with the same hash as at scan time, so a file swapped for a link after the scan is
  not sent.

## Consequences

- An old folder cannot overwrite newer content on drop; the server enforces it inside the same
  batch as the commit.
- A conflict never leaves half a merge in a Site: conflicts are found before anything is written,
  and then the user picks a side. Applying a pull is not atomic, though. Files are removed and
  written one by one, and a failure partway (a symbolic link in a Path, a disk error) leaves the
  files written so far while the Synced version stays old. The next pull compares again from there:
  a file already written matches drop and is left alone.
- Known limit: a process that can write the sync directory can still race the scan by swapping a
  directory for a link while it is being walked. Preventing it needs opening each level relative to
  a checked directory without following links (`openat`), which Bun and Node do not offer. Such a
  process normally runs as the user and can read those files itself; the exception is a sandboxed
  agent that can write the sync directory but not read outside it.
