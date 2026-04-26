# pr-fix-actor

## Purpose

The Actor responsible for responding to PR review feedback: it reads CodeRabbit findings, PR thread comments, and CI failures on an open PR, and dispatches fix work back through `code-author`. Default posture is deny; every action requires an explicit allow.

## Signed by

Principal: `pr-fix-actor`. See `arch-principal-hierarchy-signed-by` and `arch-bot-identity-per-actor` for the App identity that signs its work.

## Inbox / Outbox

- Inbox: PR review events, CI status atoms, `actor-message` dispatches from `cto-actor`.
- Outbox: `actor-message` atoms targeted at `code-author`, PR thread replies, escalation atoms.

Anchored on `arch-actor-message-inbox-primitive`.

## Canon it must obey

- `pol-pr-fix-default-deny`: nothing is permitted without explicit allow.
- `pol-pr-fix-agent-loop-dispatch`: the agent-loop substrate dispatches fixes.
- `pol-pr-fix-merge-denied`: it cannot merge.
- `pol-pr-fix-canon-l3-denied`: it cannot promote or edit L3 canon.
- `pol-pr-fix-pr-thread-resolve`: thread-resolution policy.
- `pol-pr-fix-pr-escalate`: escalation routing.

## Source

`src/runtime/actors/pr-fix/` on `main`.
