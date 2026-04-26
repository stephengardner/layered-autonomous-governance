# pr-landing-agent

## Purpose

The Actor that observes merge readiness and lands PRs whose required checks have passed. It does not author code; it observes status, validates fence-required checks, and merges or escalates.

## Signed by

Principal: `pr-landing-agent`. The bot identity is `lag-pr-landing` per `arch-bot-identity-per-actor`. See `arch-principal-hierarchy-signed-by` for the principal chain.

## Inbox / Outbox

- Inbox: `pull-request` atoms, CI status atoms, review-state atoms.
- Outbox: `merge` atoms, escalation `actor-message` atoms.

Anchored on `arch-actor-message-inbox-primitive`.

## Canon it must obey

- `dev-multi-surface-review-observation`: review state is observed across surfaces.
- `arch-bot-identity-per-actor`: identity is `lag-pr-landing`, distinct from other Actors.
- `dev-coderabbit-required-status-check-non-negotiable`: the CodeRabbit required check gates merge.
- `dev-required-checks-must-cover-all-meaningful-ci`: required checks are kept in sync with meaningful CI.

## Source

`src/runtime/actors/pr-landing/` on `main`.
