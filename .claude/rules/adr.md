---
paths:
  - "src/**"
  - "app/src/**"
  - "shared/**"
---

# ADR (Architecture Decision Record)

When you make a significant architectural decision (what to share and what not to share, a design decision that
spans several runtimes (the Worker/SSR in `src/`, the React SPA in `app/src/`, and `shared/` across both), and the
like), record it as an ADR in `docs/adr/`. The value lies less in the decision itself than in recording "why it was
decided that way" and "what was deliberately not shared".

## Format

```
# ADR-NNN: {Title}

## Status

Accepted | Deprecated | Superseded

## Context
## Decision
## Consequences
```

- File name: `{NNN}-{kebab-case}.md` (e.g. `001-page-menu-sharing.md`)
- The H1 starts with `ADR-NNN:`, and the number matches the file name's prefix
- Required H2s: Status, Context, Decision, Consequences
- The Status value is one of `Accepted` / `Deprecated` / `Superseded`
- If the path to the decision is long, you may add a `## History`

Example: `docs/adr/001-page-menu-sharing.md`
