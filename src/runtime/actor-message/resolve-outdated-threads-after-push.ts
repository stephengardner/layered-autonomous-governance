/**
 * Substrate-side sweep of outdated review threads on a pull request.
 *
 * Some review-host backends (GitHub among them) treat unresolved
 * review threads as a hard merge gate alongside the review decision
 * and CI status. When a follow-up commit changes the line a thread
 * was anchored to, the backend marks the thread `isOutdated: true`
 * but leaves it in the unresolved bucket until something calls
 * `resolveReviewThread` on it. A PR that is otherwise merge-eligible
 * stays blocked purely on those stale outdated threads.
 *
 * This helper is the substrate primitive that PR-authoring executors
 * call after opening a PR or pushing a fix-commit so the outdated-
 * thread sweep happens regardless of which actor flow drove the
 * push. It composes through the `GhClient` interface (no subprocess
 * spawn) so the same primitive serves any backend the consumer wires
 * through that seam.
 *
 * Failure posture
 * ---------------
 * - The caller is expected to wrap this in try/catch and continue on
 *   failure. A resolution glitch must NEVER fail the PR-create or
 *   fix-push flow that just succeeded.
 * - On any thrown error during the sweep, the helper rejects with a
 *   typed `ResolveThreadsError` carrying the underlying cause.
 * - The audit atom is best-effort: a put failure is swallowed and
 *   logged via the host's audit channel so a transient store error
 *   does not propagate up as a fatal resolve failure either.
 *
 * Audit trail
 * -----------
 * Each invocation writes a single atom of type `observation` with
 * `metadata.operator_action.{kind: 'resolve-outdated-threads', ...}`.
 * The `observation` + `metadata.operator_action` shape mirrors the
 * existing audit-atom convention used elsewhere in the codebase;
 * co-locating on that shape keeps the AtomType union narrow until a
 * second distinct producer justifies a dedicated type.
 */

import { randomUUID } from 'node:crypto';
import type { Atom, AtomId, PrincipalId, Time } from '../../substrate/types.js';
import type { Host } from '../../substrate/interface.js';
import type { GhClient } from '../../external/github/index.js';

/**
 * A GitHub review thread as returned by the reviewThreads(first:N)
 * GraphQL query on a pull request. Matches the wire shape of the
 * canonical query string below; the optional `path` is included for
 * audit logging and is omitted by GitHub when the thread is not
 * anchored to a file.
 */
export interface ReviewThread {
  readonly id: string;
  readonly isResolved: boolean;
  readonly isOutdated: boolean;
  readonly path?: string;
}

/**
 * Counters returned to the caller. `resolved` is the number of
 * outdated threads the helper marked resolved this invocation;
 * `stillCurrent` is the number left untouched because they remain
 * anchored to live code (those need a human acknowledgement);
 * `alreadyResolved` is the count of threads that were already in
 * terminal state before this run.
 */
export interface ResolveOutdatedThreadsResult {
  readonly resolved: number;
  readonly stillCurrent: number;
  readonly alreadyResolved: number;
  readonly atomId: AtomId | null;
}

export interface ResolveOutdatedThreadsInput {
  readonly host: Host;
  readonly ghClient: GhClient;
  /** The principal whose audit atom records the sweep. */
  readonly principal: PrincipalId;
  /** Repository owner (e.g. 'stephengardner'). */
  readonly owner: string;
  /** Repository name (e.g. 'layered-autonomous-governance'). */
  readonly repo: string;
  /** PR number to sweep. */
  readonly prNumber: number;
  /**
   * Optional clock override for deterministic tests. Defaults to
   * `() => new Date().toISOString()` (real wall clock).
   */
  readonly now?: () => string;
  /**
   * Optional unique-suffix generator for deterministic tests. Defaults
   * to `randomUUID().slice(0, 8)`.
   */
  readonly newSuffix?: () => string;
  /**
   * Optional AbortSignal forwarded to each GhClient call so a caller
   * with a revocation signal halts the sweep promptly on kill-switch.
   */
  readonly signal?: AbortSignal;
}

/**
 * Typed wrapper around any thrown error during the sweep. Callers
 * pattern-match this class to distinguish a resolve-helper failure
 * from a PR-creation or git-push failure that should propagate up.
 */
export class ResolveThreadsError extends Error {
  override readonly cause: unknown;
  constructor(message: string, cause: unknown) {
    super(message);
    this.name = 'ResolveThreadsError';
    this.cause = cause;
  }
}

/**
 * Canonical reviewThreads listing query. Mirrors the query string in
 * `scripts/resolve-outdated-threads.mjs` so a drift between the CLI
 * path and the substrate path is impossible at read time.
 */
const LIST_QUERY = `query($owner:String!, $name:String!, $n:Int!, $cursor:String){
  repository(owner:$owner, name:$name){
    pullRequest(number:$n){
      reviewThreads(first:100, after:$cursor){
        nodes{ id isResolved isOutdated path }
        pageInfo{ hasNextPage endCursor }
      }
    }
  }
}`;

/**
 * Canonical resolveReviewThread mutation. Mirrors the same string in
 * `scripts/resolve-outdated-threads.mjs`.
 */
const RESOLVE_MUTATION = `mutation($id:ID!){
  resolveReviewThread(input:{threadId:$id}){
    thread{ id isResolved }
  }
}`;

/**
 * Cap on pagination iterations. Same posture as the CLI counterpart:
 * a theoretical safety net against a misbehaving server that returns
 * `hasNextPage=true` indefinitely (or with an unchanged endCursor).
 * Beyond this cap, the helper surfaces truncation as a hard failure
 * rather than spinning forever.
 */
const MAX_PAGES = 50;

interface ReviewThreadsPage {
  readonly nodes: ReadonlyArray<ReviewThread>;
  readonly pageInfo: { readonly hasNextPage: boolean; readonly endCursor: string | null };
}

interface ReviewThreadsResponse {
  readonly repository: { readonly pullRequest: { readonly reviewThreads: ReviewThreadsPage } } | null;
}

interface ResolveThreadResponse {
  readonly resolveReviewThread: { readonly thread: { readonly id: string; readonly isResolved: boolean } };
}

/**
 * Bucket review threads into the three states the resolver acts on.
 * Pure function over the GraphQL shape; tests use this directly.
 *
 *  - resolveTargets: unresolved AND outdated (anchored line changed;
 *    safe to mark resolved without operator review).
 *  - stillCurrent: unresolved AND NOT outdated (anchored line still
 *    exists; the suggestion may still apply; LEFT for a human).
 *  - alreadyResolved: terminal state, no action needed.
 */
export function classifyReviewThreads(
  threads: ReadonlyArray<ReviewThread>,
): {
  readonly resolveTargets: ReadonlyArray<ReviewThread>;
  readonly stillCurrent: ReadonlyArray<ReviewThread>;
  readonly alreadyResolved: ReadonlyArray<ReviewThread>;
} {
  const resolveTargets: ReviewThread[] = [];
  const stillCurrent: ReviewThread[] = [];
  const alreadyResolved: ReviewThread[] = [];
  for (const t of threads) {
    if (t.isResolved) alreadyResolved.push(t);
    else if (t.isOutdated) resolveTargets.push(t);
    else stillCurrent.push(t);
  }
  return { resolveTargets, stillCurrent, alreadyResolved };
}

/**
 * Page through every review thread on the PR via GraphQL. Bounded by
 * MAX_PAGES + same-cursor detection: a server that returns
 * hasNextPage=true with an unchanged endCursor is treated as a
 * truncation event rather than an infinite loop.
 */
async function listAllReviewThreads(
  ghClient: GhClient,
  owner: string,
  repo: string,
  prNumber: number,
  signal?: AbortSignal,
): Promise<ReadonlyArray<ReviewThread>> {
  const all: ReviewThread[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < MAX_PAGES; i += 1) {
    const vars: Record<string, unknown> = { owner, name: repo, n: prNumber };
    if (cursor !== null) vars['cursor'] = cursor;
    const opts = signal !== undefined ? { signal } : undefined;
    const data = await ghClient.graphql<ReviewThreadsResponse>(LIST_QUERY, vars, opts);
    const page = data.repository?.pullRequest?.reviewThreads;
    // A missing reviewThreads payload usually means the repo or PR
    // lookup failed (deleted PR, wrong owner/repo, auth scope drop).
    // Treat it as a hard error rather than a silent no-op so the
    // caller does not write a misleading `resolved=0` audit atom for
    // what is actually a query-shape failure.
    if (!page) {
      throw new ResolveThreadsError(
        `reviewThreads query returned no payload for ${owner}/${repo}#${prNumber}`,
        null,
      );
    }
    for (const node of page.nodes) all.push(node);
    if (!page.pageInfo.hasNextPage) return all;
    const next = page.pageInfo.endCursor;
    if (next === null || next === cursor) {
      // Cursor stuck: surface as truncation rather than spinning.
      throw new ResolveThreadsError(
        `reviewThreads pagination cursor stuck at ${String(cursor)}`,
        null,
      );
    }
    cursor = next;
  }
  // Hit MAX_PAGES without exhausting the result set; treat as a
  // hard truncation rather than silently dropping the tail.
  throw new ResolveThreadsError(
    `reviewThreads pagination exceeded MAX_PAGES=${MAX_PAGES}`,
    null,
  );
}

/**
 * Resolve one review thread via the GraphQL mutation. Throws if the
 * server response does not confirm `isResolved: true`.
 */
async function resolveOneThread(
  ghClient: GhClient,
  threadId: string,
  signal?: AbortSignal,
): Promise<void> {
  const opts = signal !== undefined ? { signal } : undefined;
  const data = await ghClient.graphql<ResolveThreadResponse>(
    RESOLVE_MUTATION,
    { id: threadId },
    opts,
  );
  if (data.resolveReviewThread?.thread?.isResolved !== true) {
    throw new ResolveThreadsError(
      `resolveReviewThread returned isResolved=false for thread ${threadId}`,
      null,
    );
  }
}

/**
 * Construct the audit atom recording the sweep result. The
 * `observation` + `metadata.operator_action` shape mirrors the
 * existing convention in `scripts/gh-as.mjs`; renaming or widening
 * AtomType for a single new producer would be premature.
 */
function buildAuditAtom(input: {
  readonly nowIso: Time;
  readonly suffix: string;
  readonly principal: PrincipalId;
  readonly owner: string;
  readonly repo: string;
  readonly prNumber: number;
  readonly resolved: number;
  readonly stillCurrent: number;
  readonly alreadyResolved: number;
  readonly error: string | null;
}): Atom {
  const id = `op-action-resolve-threads-${input.prNumber}-${Date.parse(input.nowIso)}-${input.suffix}` as AtomId;
  const summary = input.error !== null
    ? `resolve-outdated-threads on PR ${input.owner}/${input.repo}#${input.prNumber} failed: ${input.error}`
    : `resolve-outdated-threads on PR ${input.owner}/${input.repo}#${input.prNumber}: resolved=${input.resolved} still-current=${input.stillCurrent} already-resolved=${input.alreadyResolved}`;
  return {
    schema_version: 1,
    id,
    content: summary,
    type: 'observation',
    layer: 'L1',
    provenance: {
      kind: 'agent-observed',
      source: {
        tool: 'resolve-outdated-threads-after-push',
        agent_id: String(input.principal),
      },
      derived_from: [],
    },
    confidence: 1,
    created_at: input.nowIso,
    last_reinforced_at: input.nowIso,
    expires_at: null,
    supersedes: [],
    superseded_by: [],
    scope: 'project',
    signals: {
      agrees_with: [],
      conflicts_with: [],
      validation_status: 'unchecked',
      last_validated_at: null,
    },
    principal_id: input.principal,
    taint: 'clean',
    metadata: {
      operator_action: {
        kind: 'resolve-outdated-threads',
        pr: { owner: input.owner, repo: input.repo, number: input.prNumber },
        resolved: input.resolved,
        still_current: input.stillCurrent,
        already_resolved: input.alreadyResolved,
        ...(input.error !== null ? { error: input.error } : {}),
        started_at: input.nowIso,
      },
    },
  };
}

/**
 * Sweep outdated review threads on the given PR. Intended to run from
 * the post-PR-creation or post-fix-push path of any PR-authoring
 * actor flow; failures in this helper MUST NOT propagate up as flow
 * failures (the caller's PR or fix-push has already landed).
 *
 * Resolution order:
 *   1. List every review thread via paginated GraphQL.
 *   2. Bucket into outdated / current / already-resolved via
 *      `classifyReviewThreads`.
 *   3. Call `resolveReviewThread` on every outdated entry; a single
 *      thread failure rejects the whole sweep with
 *      `ResolveThreadsError` so the caller's catch sees one typed
 *      error rather than partial counts.
 *   4. Write the audit atom (best-effort; an atom-store failure does
 *      NOT propagate, but is recorded via the host's audit channel).
 *
 * Returns the bucket counts so the caller can log them. The atom id
 * is null when the atom-store write failed; the GitHub-side
 * resolution still happened.
 */
export async function resolveOutdatedThreadsAfterPush(
  input: ResolveOutdatedThreadsInput,
): Promise<ResolveOutdatedThreadsResult> {
  const now = input.now ?? (() => new Date().toISOString());
  const newSuffix = input.newSuffix ?? (() => randomUUID().slice(0, 8));
  const nowIso = now() as Time;

  let threads: ReadonlyArray<ReviewThread>;
  try {
    threads = await listAllReviewThreads(
      input.ghClient,
      input.owner,
      input.repo,
      input.prNumber,
      input.signal,
    );
  } catch (err) {
    const wrapped = err instanceof ResolveThreadsError
      ? err
      : new ResolveThreadsError(
        `failed to list review threads for PR ${input.prNumber}`,
        err,
      );
    // Record the failure as an audit atom before rethrowing so the
    // operator has a single chain of artifacts to walk when the
    // caller's catch decides whether to escalate.
    await writeAuditAtomBestEffort({
      host: input.host,
      atom: buildAuditAtom({
        nowIso,
        suffix: newSuffix(),
        principal: input.principal,
        owner: input.owner,
        repo: input.repo,
        prNumber: input.prNumber,
        resolved: 0,
        stillCurrent: 0,
        alreadyResolved: 0,
        error: wrapped.message,
      }),
    });
    throw wrapped;
  }

  const { resolveTargets, stillCurrent, alreadyResolved } = classifyReviewThreads(threads);

  // Track threads we have already marked resolved this run. Carried
  // into the error-path audit atom so a partial sweep records its
  // partial progress rather than under-reporting resolved=0 when
  // earlier threads in the loop already succeeded.
  let resolvedCount = 0;
  for (const t of resolveTargets) {
    try {
      await resolveOneThread(input.ghClient, t.id, input.signal);
      resolvedCount += 1;
    } catch (err) {
      const wrapped = err instanceof ResolveThreadsError
        ? err
        : new ResolveThreadsError(
          `failed to resolve thread ${t.id} on PR ${input.prNumber}`,
          err,
        );
      // Same posture as the listing failure: record + rethrow so the
      // caller's catch has the option to escalate while the audit
      // chain still carries the failure mode.
      await writeAuditAtomBestEffort({
        host: input.host,
        atom: buildAuditAtom({
          nowIso,
          suffix: newSuffix(),
          principal: input.principal,
          owner: input.owner,
          repo: input.repo,
          prNumber: input.prNumber,
          resolved: resolvedCount,
          stillCurrent: stillCurrent.length,
          alreadyResolved: alreadyResolved.length,
          error: wrapped.message,
        }),
      });
      throw wrapped;
    }
  }

  const atom = buildAuditAtom({
    nowIso,
    suffix: newSuffix(),
    principal: input.principal,
    owner: input.owner,
    repo: input.repo,
    prNumber: input.prNumber,
    resolved: resolvedCount,
    stillCurrent: stillCurrent.length,
    alreadyResolved: alreadyResolved.length,
    error: null,
  });
  const atomId = await writeAuditAtomBestEffort({ host: input.host, atom });

  return {
    resolved: resolvedCount,
    stillCurrent: stillCurrent.length,
    alreadyResolved: alreadyResolved.length,
    atomId,
  };
}

/**
 * Persist the audit atom. Failures are swallowed because the GitHub
 * side has already mutated; we record the put failure via the audit
 * channel so an operator can diagnose store breakage without losing
 * the sweep result.
 */
async function writeAuditAtomBestEffort(input: {
  readonly host: Host;
  readonly atom: Atom;
}): Promise<AtomId | null> {
  try {
    await input.host.atoms.put(input.atom);
    return input.atom.id;
  } catch (err) {
    // Auditor seam: record the put failure without surfacing it.
    try {
      await input.host.auditor.log({
        kind: 'write',
        principal_id: input.atom.principal_id,
        timestamp: input.atom.created_at,
        refs: { atom_ids: [input.atom.id] },
        details: {
          source: 'resolve-outdated-threads-after-push',
          reason: err instanceof Error ? err.message : String(err),
        },
      });
    } catch {
      // Audit-channel failure must not propagate either.
    }
    return null;
  }
}
