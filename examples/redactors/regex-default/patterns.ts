/**
 * Default regex pattern set for the reference RegexRedactor.
 *
 * Each entry: { name, pattern, replacement }. Patterns are NOT
 * exhaustive; orgs swap in their own (or compose with these).
 * Document the rationale per pattern so a reader sees why each is
 * in the set.
 *
 * Conventions
 * -----------
 * - `pattern` MUST use the global flag (`/g`) so all matches in a
 *   string get replaced, not just the first.
 * - `pattern` MUST anchor on word boundaries (`\b`) so partial
 *   matches inside larger strings still hit (e.g. "see token AKIA...
 *   in logs" should redact).
 * - `replacement` is `[REDACTED:<name>]`; the marker preserves
 *   provenance of the redaction (audits know which pattern fired);
 *   replacing with empty string would lose that signal.
 * - Replacements MUST NOT themselves match any pattern in this set
 *   (idempotence: redacting twice equals redacting once).
 */

export interface RedactionPattern {
  readonly name: string;
  readonly pattern: RegExp;
  readonly replacement: string;
}

export const DEFAULT_PATTERNS: ReadonlyArray<RedactionPattern> = [
  // AWS access key id format: AKIA followed by 16 uppercase alphanumeric.
  { name: 'aws-access-key', pattern: /\bAKIA[0-9A-Z]{16}\b/g, replacement: '[REDACTED:aws-access-key]' },
  // NOTE: AWS secret access keys are 40 chars of base64-ish, but a tight
  // regex is impossible without false positives on git SHAs (40 hex),
  // JWTs, base64-encoded blobs. A blanket /\b[A-Za-z0-9/+=]{40}\b/g
  // would redact every `git log` / `git show` line in a code-author
  // transcript, breaking debug-ability. Operators who need this should
  // ship an org-specific Redactor with context-aware matching (e.g.,
  // scan only AWS-CLI tool output, or look for `aws_secret_access_key=`
  // assignment context). Intentionally NOT included in defaults.
  // GitHub Personal Access Tokens: ghp_/ghu_/ghr_ + 36 chars.
  { name: 'github-pat', pattern: /\bgh[pur]_[A-Za-z0-9]{36}\b/g, replacement: '[REDACTED:github-pat]' },
  // GitHub App installation tokens: ghs_ + 36+ chars.
  { name: 'github-installation-token', pattern: /\bghs_[A-Za-z0-9]{36,}\b/g, replacement: '[REDACTED:github-installation-token]' },
  // GitHub OAuth tokens: gho_ + 36 chars.
  { name: 'github-oauth', pattern: /\bgho_[A-Za-z0-9]{36}\b/g, replacement: '[REDACTED:github-oauth]' },
  // JWT-shaped: three base64url segments separated by '.'.
  { name: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, replacement: '[REDACTED:jwt]' },
];
