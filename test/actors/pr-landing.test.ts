/**
 * PrLandingActor tests (Phase 53a).
 *
 * Covers:
 *   - observe lists unresolved comments from the adapter
 *   - classify partitions nit / suggestion / architectural
 *   - propose emits reply action + resolve action for nits,
 *     reply-only for suggestions and architectural
 *   - apply dispatches to adapter methods correctly
 *   - reflect reports done when the PR has zero comments
 *   - end-to-end composition via runActor: a PR with one nit converges
 */

import { describe, expect, it } from 'vitest';
import { createMemoryHost } from '../../src/adapters/memory/index.js';
import { runActor } from '../../src/actors/run-actor.js';
import { PrLandingActor } from '../../src/actors/pr-landing/pr-landing.js';
import type {
  PrCommentOutcome,
  PrIdentifier,
  PrReviewAdapter,
  ReviewComment,
  ReviewReplyOutcome,
} from '../../src/actors/pr-review/adapter.js';
import { samplePrincipal } from '../fixtures.js';

const PR: PrIdentifier = { owner: 'o', repo: 'r', number: 1 };

function mkComment(over: Partial<ReviewComment> = {}): ReviewComment {
  return {
    id: `c${Math.random().toString(36).slice(2, 8)}`,
    author: 'coderabbit',
    body: 'nit: use const instead of let',
    createdAt: '2026-04-19T00:00:00.000Z',
    resolved: false,
    ...over,
  };
}

class StubReviewAdapter implements PrReviewAdapter {
  readonly name = 'stub-review';
  readonly version = '0';
  replies: Array<{ commentId: string; body: string }> = [];
  resolvedIds: string[] = [];
  prComments: Array<{ body: string }> = [];
  /** Logins the stub treats as engaged. Tests mutate between iterations. */
  engagedLogins: Set<string> = new Set();
  /** Fires at the START of each iteration (before list returns); mutate stub state here. */
  beforeIteration?: (iterZeroBased: number, stub: StubReviewAdapter) => void;

  constructor(private commentsByIteration: ReviewComment[][]) {}

  private iter = 0;
  async listUnresolvedComments(): Promise<ReadonlyArray<ReviewComment>> {
    this.beforeIteration?.(this.iter, this);
    const list = this.commentsByIteration[this.iter] ?? [];
    this.iter++;
    return list;
  }
  async replyToComment(_pr: PrIdentifier, commentId: string, body: string): Promise<ReviewReplyOutcome> {
    this.replies.push({ commentId, body });
    return { commentId, replyId: `r${this.replies.length}`, posted: true };
  }
  async resolveComment(_pr: PrIdentifier, commentId: string): Promise<void> {
    this.resolvedIds.push(commentId);
  }
  async hasReviewerEngaged(_pr: PrIdentifier, logins: ReadonlyArray<string>): Promise<boolean> {
    for (const l of logins) if (this.engagedLogins.has(l)) return true;
    return false;
  }
  async postPrComment(_pr: PrIdentifier, body: string): Promise<PrCommentOutcome> {
    this.prComments.push({ body });
    // Simulate post making the bot engaged (subsequent iterations see it).
    this.engagedLogins.add('github-actions[bot]');
    return { commentId: `pc${this.prComments.length}`, posted: true };
  }
}

describe('PrLandingActor', () => {
  it('with a composeReply, produces reply + resolve for a nit comment', async () => {
    const host = createMemoryHost();
    const comment = mkComment({ id: 'nit1', body: 'nit: small typo', severity: 'nit' });
    const review = new StubReviewAdapter([[comment], []]);
    // composeReply present: the actor has substance to post, so it
    // both replies AND resolves. Without composeReply the actor stays
    // silent on replies; see the no-composer tests below.
    const actor = new PrLandingActor({
      pr: PR,
      composeReply: async (c) => `fix applied for ${c.id}`,
    });

    const report = await runActor(actor, {
      host,
      principal: samplePrincipal(),
      adapters: { review },
      budget: { maxIterations: 3 },
      origin: 'scheduled',
    });

    expect(report.haltReason).toBe('converged');
    expect(review.replies).toHaveLength(1);
    expect(review.replies[0]!.commentId).toBe('nit1');
    expect(review.resolvedIds).toEqual(['nit1']);
  });

  it('without a composeReply, resolves nits silently (no canned-ack spam)', async () => {
    // Regression guard for the PR-landing ack-spam loop: without a
    // real compose hook, the actor must not post "Thanks for the
    // review. Addressing in a follow-up" replies. It still resolves
    // nit threads because resolving IS a substantive terminal
    // action; the reply is the part that lied about intent.
    const host = createMemoryHost();
    const comment = mkComment({ id: 'nit1', body: 'nit: small typo', severity: 'nit' });
    const review = new StubReviewAdapter([[comment], []]);
    const actor = new PrLandingActor({ pr: PR });

    const report = await runActor(actor, {
      host,
      principal: samplePrincipal(),
      adapters: { review },
      budget: { maxIterations: 3 },
      origin: 'scheduled',
    });

    expect(report.haltReason).toBe('converged');
    expect(review.replies).toHaveLength(0);
    expect(review.resolvedIds).toEqual(['nit1']);
  });

  it('with a composeReply, surfaces architectural comments via pr-reply-architectural', async () => {
    const host = createMemoryHost();
    const comment = mkComment({
      id: 'arch1',
      body: 'Consider refactoring this architecture to avoid the central registry',
      severity: 'architectural',
    });
    const review = new StubReviewAdapter([[comment], []]);
    const actor = new PrLandingActor({
      pr: PR,
      composeReply: async (c) => `architectural reply for ${c.id}`,
    });

    const report = await runActor(actor, {
      host,
      principal: samplePrincipal(),
      adapters: { review },
      budget: { maxIterations: 3 },
      origin: 'scheduled',
    });

    // With no policy atoms, architectural reply is default-allowed.
    // Result: one reply, NO resolve (architectural is not auto-resolved).
    expect(report.haltReason).toBe('converged');
    expect(review.replies).toHaveLength(1);
    expect(review.resolvedIds).toEqual([]);
  });

  it('without a composeReply, architectural comments generate no reply (operator sees them directly)', async () => {
    // Regression guard: without a real compose hook, architectural
    // comments are NOT auto-replied. They remain visible to the
    // operator on the PR; the actor does not post chatter.
    const host = createMemoryHost();
    const comment = mkComment({
      id: 'arch1',
      body: 'Consider refactoring this architecture to avoid the central registry',
      severity: 'architectural',
    });
    const review = new StubReviewAdapter([[comment], []]);
    const actor = new PrLandingActor({ pr: PR });

    const report = await runActor(actor, {
      host,
      principal: samplePrincipal(),
      adapters: { review },
      budget: { maxIterations: 3 },
      origin: 'scheduled',
    });

    // No reply, no resolve: pure "nothing to do" state. The actor
    // converges because there are no unresolved in-scope actions.
    expect(review.replies).toHaveLength(0);
    expect(review.resolvedIds).toEqual([]);
  });

  it('converges immediately when there are no unresolved comments', async () => {
    const host = createMemoryHost();
    const review = new StubReviewAdapter([[]]);
    const actor = new PrLandingActor({ pr: PR });

    const report = await runActor(actor, {
      host,
      principal: samplePrincipal(),
      adapters: { review },
      budget: { maxIterations: 5 },
      origin: 'scheduled',
    });

    expect(report.haltReason).toBe('converged');
    expect(report.iterations).toBe(1);
    expect(review.replies).toHaveLength(0);
  });

  it('posts ensure-review prompt when configured reviewer has not engaged', async () => {
    const host = createMemoryHost();
    const review = new StubReviewAdapter([[], []]);
    // Before iteration 2 (zero-based 1), simulate reviewer arriving.
    review.beforeIteration = (iterIdx, stub) => {
      if (iterIdx === 1) stub.engagedLogins.add('coderabbitai[bot]');
    };
    const actor = new PrLandingActor({
      pr: PR,
      ensureReviewers: [{
        logins: ['coderabbitai[bot]'],
        promptBody: '@coderabbitai review',
        label: 'CodeRabbit',
      }],
    });

    const report = await runActor(actor, {
      host,
      principal: samplePrincipal(),
      adapters: { review },
      budget: { maxIterations: 3 },
      origin: 'scheduled',
    });

    // Iteration 1: reviewer not engaged, self not prompted -> post prompt.
    // Iteration 2: reviewer engaged (simulated), 0 comments -> converged.
    expect(report.haltReason).toBe('converged');
    expect(review.prComments).toHaveLength(1);
    expect(review.prComments[0]!.body).toBe('@coderabbitai review');
  });

  it('does NOT post ensure-review prompt when reviewer has already engaged', async () => {
    const host = createMemoryHost();
    const review = new StubReviewAdapter([[]]);
    review.engagedLogins.add('coderabbitai[bot]');
    const actor = new PrLandingActor({
      pr: PR,
      ensureReviewers: [{
        logins: ['coderabbitai[bot]'],
        promptBody: '@coderabbitai review',
        label: 'CodeRabbit',
      }],
    });

    const report = await runActor(actor, {
      host,
      principal: samplePrincipal(),
      adapters: { review },
      budget: { maxIterations: 3 },
      origin: 'scheduled',
    });

    expect(report.haltReason).toBe('converged');
    expect(review.prComments).toHaveLength(0);
  });

  it('idempotency: does NOT re-post ensure-review when bot already prompted', async () => {
    // Bot already posted (engaged as github-actions[bot]) but reviewer
    // hasn't engaged. Expected: no additional prompt posted; actor
    // hits convergence-loop waiting for the slow reviewer, not spam.
    const host = createMemoryHost();
    const review = new StubReviewAdapter([[], []]);
    review.engagedLogins.add('github-actions[bot]');
    const actor = new PrLandingActor({
      pr: PR,
      ensureReviewers: [{
        logins: ['coderabbitai[bot]'],
        promptBody: '@coderabbitai review',
        label: 'CodeRabbit',
      }],
    });

    const report = await runActor(actor, {
      host,
      principal: samplePrincipal(),
      adapters: { review },
      budget: { maxIterations: 3 },
      origin: 'scheduled',
    });

    expect(review.prComments).toHaveLength(0);
    expect(report.haltReason).toBe('convergence-loop');
  });

  it('classify key changes when comment counts change across iterations', async () => {
    const host = createMemoryHost();
    const c1 = mkComment({ id: 'n1', severity: 'nit' });
    const c2 = mkComment({ id: 'n2', severity: 'nit' });
    const review = new StubReviewAdapter([[c1, c2], [c1], []]);
    const actor = new PrLandingActor({
      pr: PR,
      composeReply: async (c) => `reply for ${c.id}`,
    });

    const report = await runActor(actor, {
      host,
      principal: samplePrincipal(),
      adapters: { review },
      budget: { maxIterations: 5 },
      origin: 'scheduled',
    });

    // Iteration 1: 2 nits -> 2 replies + 2 resolves
    // Iteration 2: 1 nit  -> 1 reply  + 1 resolve
    // Iteration 3: 0 nits -> converged immediately
    expect(report.haltReason).toBe('converged');
    expect(review.replies.length).toBe(3);
    expect(review.resolvedIds.length).toBe(3);
  });
});
