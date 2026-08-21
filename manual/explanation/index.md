# Design decisions

This section is the **why** of GL3: design documents and architecture decision
records (ADRs). Nothing here is a manual; for how to do things, see the
[guides](/guides/create-a-plugin).

## Where the "why" currently lives

- `docs/ENGINEERING-NOTES.md`: why parts of the codebase look the way they do.
  Every item there cost real debugging time. `NOTES.md` is the short version.
- `docs/STATUS.md`: project status, milestone history, and per-cluster decisions.
- `SPEC.md`: what to build.
- Feature design docs are written before a feature lands and cover it end to end
  (architecture, data flow, errors, testing, out of scope).

New single-decision records land here as ADRs.

## Design docs vs ADRs

- A **design doc** covers a feature end to end and is written before the feature
  lands.
- An **ADR** records one decision: the context, the options, the choice, and its
  consequences. ADRs are dated, numbered, and immutable; a reversed decision gets a
  *new* ADR that supersedes the old one, never an edit.

## Writing an ADR

Copy [`adr/template.md`](./adr/template) to `adr/NNNN-short-title.md` with the next
free number. Keep it under a page. The test of a good ADR: a contributor two years
from now understands why the obvious alternative was rejected.

## Index

| # | Date | Decision |
|---|---|---|
| [0001](./adr/0001-detective-reports-expire-not-consume) | 2026-08-18 | Detective reports expire by time; attacking does not consume them |
