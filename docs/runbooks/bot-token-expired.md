# Bot token expired mid-PR

A bot identity's token (`lag-ceo`, `lag-cto`, `lag-pr-landing`, or `LAG_OPS_PAT` machine user) expired or was revoked, blocking PR open/comment/merge from automation flows.

## Symptoms

- `gh-as.mjs <bot> <command>` returns `Bad credentials` (HTTP 401).
- `cr-trigger.mjs <pr>` exits 1 with the `LAG_OPS_PAT authentication failed` renewal playbook (per PR #433 PAT preflight).
- Operator sees a PR stuck at the point where the bot would have acted (PR not opened, CR not triggered, merge not fired).
- For App identities (`lag-ceo` etc.): the token is short-lived (1 hour) and refreshes via `gh-token-for.mjs`; a 401 here usually means the GitHub App installation was revoked or the App was disabled, not just an expired token.

## Atom kinds that fire

- The bot-aware operations all route through `gh-as.mjs` which writes an `operator-action` atom on failure with `details.error` containing the HTTP status.
- No specific `bot-identity-health` atom fires today; the absence of recent `operator-action` atoms from a given bot role is the signal. Queued task #364 (bot-identity health endpoint + Console widget) closes this gap.

## Recovery steps

### LAG_OPS_PAT (machine user, classic PAT)

1. PR #433 PAT preflight already names this: the renewal playbook is in `scripts/lib/token-health.mjs:renewalInstructionsFor`. The 6-step renewal:
   1. Log in to GitHub as the `layered-autonomous-governance` machine user (NOT the operator's personal account).
   2. Open https://github.com/settings/tokens and click "Generate new token".
   3. Grant the minimum scope: Pull requests: Read and write for `cr-trigger`; broader scopes only for other scripts that need them.
   4. Set expiration to 90 days so the next preflight catches drift early.
   5. Paste the new token into `.env` at the existing `LAG_OPS_PAT=` line.
   6. Re-run the command that failed.

### App identities (lag-ceo, lag-cto, lag-pr-landing)

1. Check the App installation: https://github.com/settings/installations (operator's personal scope) or the org's settings.
2. If the installation is revoked: re-install. The App ID + private key in `.lag/apps/<bot>.{app-id,private-key.pem}` are unchanged; only the installation needs reauth.
3. If the private key is corrupted: regenerate via `node scripts/lag-actors.mjs provision <bot>` (operator-only).
4. Verify with `node scripts/gh-as.mjs <bot> api user` (should return `{login: '<bot>[bot]', ...}`).

## Prevention follow-up

- Substrate gap: per task #353 the PAT health preflight ships, but only for `LAG_OPS_PAT`. The App-identity equivalent is a periodic `node scripts/gh-as.mjs <bot> api user` health check that records `bot-identity-health` atoms. Queued as part of task #364.
- Operator action: set the PAT expiration to 90 days (not 1 year, not 30 days) so the preflight warn-floor (7 days) catches it with comfortable lead time.
- Canon hardening: `dev-cr-triggers-via-machine-user-only` is the binding canon; if the machine user is the bottleneck, the canon does NOT permit falling back to a bot App for CR triggers. The operator must rotate the PAT, not bypass the gate.

## Related

- Code: `scripts/lib/token-health.mjs`, `scripts/gh-as.mjs`, `scripts/cr-trigger.mjs`
- Canon: `dev-cr-triggers-via-machine-user-only`, `dev-no-operator-attribution-on-automation`
- Self-audit finding P2: `docs/audit/2026-05-22-perpetual-self-audit-v0.md`
