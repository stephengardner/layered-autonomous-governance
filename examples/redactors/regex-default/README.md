# RegexRedactor (reference adapter)

A regex-pattern `Redactor` for the agentic actor loop. Covers common
third-party secret formats (AWS, GitHub PAT/App, JWT). Org-specific
patterns are the operator's responsibility - extend or replace.

## Indie path

Copy this directory under your app and import:

```ts
import { RegexRedactor } from './redactors/regex-default';
const redactor = new RegexRedactor();
```

## Extending patterns

```ts
import { RegexRedactor, DEFAULT_PATTERNS } from './redactors/regex-default';
const redactor = new RegexRedactor([
  ...DEFAULT_PATTERNS,
  { name: 'org-customer-id', pattern: /\bCUST-[A-Z0-9]{12}\b/g, replacement: '[REDACTED:customer-id]' },
]);
```

## What this adapter does NOT cover

- Customer data (PII, addresses, emails).
- Org-internal API tokens with custom shapes.
- AWS secret access keys. A 40-char base64-ish pattern collides with
  git commit SHAs (40 hex) and JWT segments, so the default set
  intentionally omits this. Operators who need it should ship a
  context-aware match (e.g., scan only AWS-CLI tool output, or look
  for an `aws_secret_access_key=` assignment context).
- Inline base64-encoded credentials inside larger strings.

For those, ship your own `Redactor` implementation against the
substrate seam at `src/substrate/redactor.ts`.

## Failure mode

Non-string input throws. The substrate contract treats a thrown
redactor as a `catastrophic` failure that halts the agent session
before any unredacted content reaches the atom store.
