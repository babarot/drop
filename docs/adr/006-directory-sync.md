# ADR-006: Syncing a directory with drop (automatic push, explicit pull)

## Status

Accepted

## Context

Putting a document on drop meant calling the HTTP API: whoever writes the file (often an AI agent)
needs an API key and has to learn the API. We want the whole interface to be "write files into a
directory". The same remote drop is also used from more than one machine (a personal one and a work
one), so whatever is written on either must reach it.

Nobody writes the same Site from two machines at the same time. What is needed is that both machines
can upload to one drop and pick up what the other uploaded.

## Decision

### Automatic push, explicit pull

Changes in the sync directory are pushed to drop. Changes on drop reach a machine only when the user
runs `drop pull`. This is the same split as git: the sync directory on each machine is that
machine's working tree, and drop is the shared remote.

Pushing runs both as a resident process (`drop watch`) and as an explicit command (`drop push`).
Whether a resident process is allowed on a work machine is not known, so neither is the only way.
`drop watch` only decides when to call the same push.

### One sync directory; one folder is one Site

There is one sync directory (`~/drop` by default). Each folder directly under it is one Site, and the
folder name is its Source name. A single file directly under it is not synced; a warning is shown
instead. With one rule there is no question whether `memo.html` and `memo/` are the same Site.

### What syncing does not touch

- Whether a Site is Published or Private is switched only in the UI. Writing a file never publishes anything.
- Deleting a folder detaches the Site: it is taken out of syncing and the next pull does not
  recreate it (`drop pull --include` brings it back). The Site on drop is not deleted, so deleting a
  folder by mistake does not lose its history. Sites are deleted only in the UI.
- The Entry of a Site that is already synced is never chosen by the CLI. It keeps the Synced
  version's Entry, so an Entry picked in the UI is not overwritten. For a new folder the CLI picks
  the Entry with the same rule as Ingest (`index.html` at the root, else the only HTML file).
- Renaming a folder is not detected. The old name is a deleted folder and the new name is a new
  folder. The Source name does not change on replace and the SPA matches re-drops by it, so making
  it writable for the CLI would break that.
- A new folder is not created as a Site when drop already has a Site with the same Source name that
  this machine does not track. The CLI asks for a pull first, so a Site created on the other machine
  is not duplicated.

## Consequences

- An agent only needs to be told "write here". Credentials stay with the CLI.
- Two machines work with one drop without real-time sync: no echo between machines, no deletions
  propagating behind the user's back. The cost is that the user has to remember to pull.
- How a push and a pull handle a remote that moved on is in ADR-007.
- Options not taken: real-time two-way sync (the same class of problems as Dropbox, and when it
  breaks it can delete local files), several sync directories (can be added later), and deriving
  the public state from the directory layout (a file written by mistake would be published).
