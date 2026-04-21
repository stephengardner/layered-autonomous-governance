/**
 * ReviewTriggerAdapter: the seam that lets pr-landing (or any future
 * actor that consumes PR reviews) ASK an external reviewer service
 * to run against a PR out-of-band.
 *
 * Problem this closes: CodeRabbit and similar SaaS reviewers have
 * anti-loop logic that silently ignores comments from `[bot]`
 * accounts (GitHub Apps). When the whole automation flow opens PRs
 * as a bot, the reviewer's own `auto_review` sometimes fires and
 * sometimes does not (rate limits, queue depth, config edge cases),
 * and the usual "@coderabbitai review" comment nudge from a bot
 * also gets ignored by the anti-loop. The only reliable
 * third-party-reviewable surface is a comment from a `type=User`
 * account. This adapter exposes that capability as a first-class,
 * pluggable seam so:
 *
 * - pr-landing has one place to call when it observes "reviewer
 *   hasn't engaged after N min" instead of reaching into raw HTTP
 *   from the actor body,
 * - implementations are swappable: the first concrete form
 *   (UserAccountCommentTrigger below) uses a PAT held by a
 *   purpose-built machine-user principal; a future form could drive
 *   a reviewer's own API once they publish one, or post via a
 *   different channel entirely,
 * - callers never hardcode reviewer names or logins (the trigger
 *   body is passed in per-call, and the machine-user prefix is a
 *   config knob).
 *
 * Per the framework-code directive, this module knows nothing about
 * which specific reviewer or which specific account is used;
 * vendor-specific strings live in configuration or canon.
 */

import type { ActorAdapter } from '../types.js';
import type { PrIdentifier } from './adapter.js';

/**
 * Outcome of a trigger attempt. The adapter either POSTed the
 * comment, short-circuited because dry-run is set, or was unable to
 * post (auth error, HTTP failure). Callers should treat `posted` as
 * the single source of truth; `failure` carries diagnostic text for
 * audit + escalation messages.
 */
export interface ReviewTriggerOutcome {
  readonly posted: boolean;
  readonly dryRun?: boolean;
  /**
   * Identifier of the comment the adapter posted, when known. May
   * be absent for dry-runs or for implementations that do not
   * produce a comment surface.
   */
  readonly commentId?: string;
  /**
   * When posted is false AND dryRun is falsy, this field carries
   * the reason (HTTP status, 'missing-token', 'unauthorized', etc.)
   * so callers can include it in an escalation message without
   * having to decode the implementation-specific error.
   */
  readonly failure?: string;
}

export interface ReviewTriggerAdapter extends ActorAdapter {
  /**
   * Post a trigger comment on `pr` asking the external reviewer to
   * run. `body` is the full comment text (e.g., "@coderabbitai
   * review"); callers construct it so this adapter stays
   * reviewer-agnostic.
   */
  triggerReview(pr: PrIdentifier, body: string): Promise<ReviewTriggerOutcome>;
}

// ---------------------------------------------------------------------------
// Concrete: UserAccountCommentTrigger (machine-user via PAT)
// ---------------------------------------------------------------------------

export interface UserAccountCommentTriggerOptions {
  /**
   * Fetch returning a PAT (or equivalent bearer) that authenticates
   * AS a GitHub User account (type=User, not type=Bot). The factory
   * is async so secret-store indirection is legal. Return `null` if
   * the secret is unavailable in the current environment; the
   * adapter then returns `{posted:false, failure:'missing-token'}`
   * rather than throwing, so callers can surface a clean
   * operator-escalation.
   */
  readonly getToken: () => Promise<string | null>;
  /**
   * When true, `triggerReview` short-circuits before the POST and
   * returns `{posted:false, dryRun:true}`. Mirrors the pattern on
   * GitHubPrReviewAdapter so dry-run semantics stay consistent.
   */
  readonly dryRun?: boolean;
  /**
   * HTTP client override. Defaults to global `fetch`. Test code
   * supplies a stub that asserts request shape + returns canned
   * responses; production code uses the default.
   */
  readonly fetchImpl?: typeof fetch;
  /**
   * Overrides the GitHub REST API base. Default
   * `https://api.github.com`. Tests set this to a mock server URL.
   */
  readonly apiBase?: string;
  /**
   * Human-readable name of the machine-user identity this adapter
   * is acting as, for audit + log readability. Not used in the HTTP
   * call itself (GitHub reads the token, not this string).
   */
  readonly actingAs?: string;
}

const DEFAULT_API_BASE = 'https://api.github.com';

/**
 * Concrete ReviewTriggerAdapter that posts the trigger comment as
 * a GitHub User account authenticated via a PAT. The token is
 * fetched per-invocation (no caching at this layer) so rotations
 * or secret-store changes are picked up immediately; the
 * implementation trades one extra getToken() await for
 * correctness-over-performance.
 *
 * Why "User account" and not App installation token: CodeRabbit's
 * anti-loop ignores comments from `[bot]` accounts. Only a
 * type=User commenter reliably triggers a CR response, which is
 * what the canon-level directive
 * `dev-coderabbit-required-status-check-non-negotiable` forces us
 * to route around.
 */
export class UserAccountCommentTrigger implements ReviewTriggerAdapter {
  readonly name = 'user-account-comment-trigger';
  readonly version = '0.1.0';

  private readonly getToken: () => Promise<string | null>;
  private readonly dryRun: boolean;
  private readonly fetchImpl: typeof fetch;
  private readonly apiBase: string;
  private readonly actingAs: string | undefined;

  constructor(options: UserAccountCommentTriggerOptions) {
    this.getToken = options.getToken;
    this.dryRun = options.dryRun ?? false;
    // Cast to typeof fetch because `globalThis.fetch` is typed as
    // `typeof fetch | undefined` in some lib configurations; the
    // Node 22 runtime this repo ships against always has it.
    this.fetchImpl = options.fetchImpl ?? (globalThis.fetch as typeof fetch);
    this.apiBase = options.apiBase ?? DEFAULT_API_BASE;
    if (options.actingAs !== undefined) this.actingAs = options.actingAs;
  }

  async triggerReview(pr: PrIdentifier, body: string): Promise<ReviewTriggerOutcome> {
    if (this.dryRun) {
      return { posted: false, dryRun: true };
    }
    const token = await this.getToken();
    if (token === null || token === '') {
      return { posted: false, failure: 'missing-token' };
    }
    const url = `${this.apiBase}/repos/${pr.owner}/${pr.repo}/issues/${pr.number}/comments`;
    let response;
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'X-GitHub-Api-Version': '2022-11-28',
          'Content-Type': 'application/json',
          // `User-Agent` is required by GitHub for all API calls;
          // without it, some endpoints return 403 with an unclear
          // error. The value identifies the adapter in GitHub's
          // access logs (useful when debugging which machine-user
          // call did what).
          'User-Agent': `lag-review-trigger${this.actingAs !== undefined ? `/${this.actingAs}` : ''}`,
        },
        body: JSON.stringify({ body }),
      });
    } catch (err) {
      return {
        posted: false,
        failure: `network: ${(err as Error)?.message ?? String(err)}`,
      };
    }
    if (!response.ok) {
      const status = response.status;
      let detail = '';
      try {
        const text = await response.text();
        detail = text.slice(0, 200);
      } catch {
        // If reading the body also fails, we still report status.
      }
      return {
        posted: false,
        failure: `http-${status}${detail !== '' ? `: ${detail}` : ''}`,
      };
    }
    let json: { id?: number } = {};
    try {
      json = (await response.json()) as { id?: number };
    } catch {
      // Response is 2xx but body is not JSON. Treat as posted
      // without a commentId; caller's audit will still record
      // posted=true.
    }
    const commentId = typeof json.id === 'number' ? String(json.id) : undefined;
    return {
      posted: true,
      ...(commentId !== undefined ? { commentId } : {}),
    };
  }
}

/**
 * Convenience: build a getToken function that reads from a process
 * env var. Separated so callers can plumb any secret source (env,
 * Secret Manager, file-backed store) with zero changes to the
 * adapter itself. For CI, `getTokenFromEnv('LAG_OPS_PAT')` is the
 * one-liner.
 */
export function getTokenFromEnv(varName: string): () => Promise<string | null> {
  return async () => {
    const raw = process.env[varName];
    if (raw === undefined || raw.trim() === '') return null;
    return raw;
  };
}
