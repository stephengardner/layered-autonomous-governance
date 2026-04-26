# resume-author-agent-loop-adapter

## Purpose

The adapter Actor that bridges agent-loop runs back into the substrate: it transcribes the agent's session, classifies actions, and emits the `plan`, `pull-request`, and `actor-message` atoms the rest of the Actors consume. It does not mutate tracked files directly; its outputs are atoms.

## Signed by

Principal: `resume-author-agent-loop-adapter`. See `arch-principal-hierarchy-signed-by` for the principal chain and `arch-bot-identity-per-actor` for the App identity that signs its outputs.

## Inbox / Outbox

- Inbox: agent-loop session events, `intent` atoms scoping a run.
- Outbox: `plan` atoms, `actor-message` atoms targeted at downstream Actors, `audit-finding` atoms when classification is ambiguous.

Anchored on `arch-actor-message-inbox-primitive`.

## Canon it must obey

- `arch-actor-message-inbox-primitive`: outputs route through the actor-message inbox primitive.
- `arch-atomstore-source-of-truth`: every output is an atom in the AtomStore.
- `arch-host-interface-boundary`: the adapter operates inside the Host boundary; external effects flow through ActorAdapters.
- `dev-flag-structural-concerns`: halt and surface when a session event cannot be classified.

## Source

`src/runtime/actors/resume-author-agent-loop-adapter/` on `main`.
