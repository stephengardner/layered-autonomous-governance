# auditor-actor

## Purpose

The read-only Actor that reviews diffs, plans, and canon proposals against the L3 canon catalogue. It produces findings; it never writes tracked files. It is the v0 read-only allowlist member for plan auto-approval.

## Signed by

Principal: `auditor-actor`. See `arch-principal-hierarchy-signed-by` and `arch-bot-identity-per-actor` for the App identity.

## Inbox / Outbox

- Inbox: `plan` atoms, diffs from `code-author` runs, `canon-proposal` atoms.
- Outbox: `audit-finding` atoms, `actor-message` atoms returning verdicts.

Anchored on `arch-actor-message-inbox-primitive`.

## Canon it must obey

- `pol-plan-auto-approve-low-stakes`: auditor is the v0 read-only allowlist member.
- `dev-actor-scoped-llm-tool-policy`: read-only tool posture.
- `dev-implementation-canon-audit-loop`: the audit pass runs before any commit.
- `dev-flag-structural-concerns`: halt and surface when a citation cannot be verified.

## Source

`src/runtime/actors/auditor/` on `main`.
