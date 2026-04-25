# Resume-Author AgentLoopAdapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **CANON-AUDIT GATE (mandatory per `dev-implementation-canon-audit-loop`):** every substantive task includes a "canon-audit" step BETWEEN the spec/code-quality reviewers and "commit." The auditor sub-agent receives canon (CLAUDE.md plus relevant `.lag/atoms/`), the plan task, the diff, and threat-model context if applicable. Returns Approved or Issues Found; iterate until clean. The four-leg review pattern is: implementer → spec-compliance reviewer → code-quality reviewer → canon-compliance auditor → commit. The canon-audit is NOT optional for any task touching a substrate primitive, a guard, the threat model, or the new wrapper's policy contract.

**Goal:** Ship `ResumeAuthorAgentLoopAdapter` (a wrapper for `AgentLoopAdapter` consumers) so PrFixActor can resume the original PR-authoring agent's session instead of always spawning fresh, with a strategy interface that supports both today's same-machine deployment and future cross-machine deployments behind explicit operator guards.

**Architecture:** Wrapper composes with `ClaudeCodeAgentLoopAdapter` as fallback. Pluggable `SessionResumeStrategy` interface; two strategies ship (`SameMachineCliResumeStrategy`, `BlobShippedSessionResumeStrategy`). Substrate change is one additive method on `BlobStore` (`describeStorage()`) plus one additive option on `ClaudeCodeAgentLoopAdapter` (`sessionPersistExtras` capture hook) plus always-on persistence of `metadata.agent_session.extra.resumable_session_id`. Reference adapter at `examples/agent-loops/resume-author/`. PrFixActor unchanged. Threat model documented in spec §5; the blob-shipped strategy is shipped-but-unwired in the reference driver.

**Tech Stack:** TypeScript, vitest, execa, node:crypto, node:fs, node:path. Conforms to existing PR1 substrate (`AgentLoopAdapter`, `BlobStore`, `Redactor`, `Workspace`).

**Spec source:** `docs/superpowers/specs/2026-04-25-resume-author-agent-loop-adapter-design.md` (head `c05983e` on branch `feat/resume-author-adapter`, approved by spec-reviewer round 3).

**Branch:** `feat/resume-author-adapter` (worktree at `.worktrees/resume-author-adapter/`).

---

## File structure (locked decomposition)

| File | Purpose | Task |
|---|---|---|
| `src/substrate/blob-store.ts` | Add `describeStorage()` method + `BlobStorageDescriptor` types | Task 1 |
| `examples/blob-stores/file/blob-store.ts` | Reference impl of `describeStorage()` | Task 2 |
| `test/substrate/blob-store-contract.test.ts` | Contract test for `describeStorage()` shape | Task 2 |
| `examples/agent-loops/claude-code/loop.ts` | Persist `resumable_session_id` + add `sessionPersistExtras` hook | Task 3 |
| `examples/agent-loops/resume-author/types.ts` | `SessionResumeStrategy`, `CandidateSession`, `ResolvedSession`, `ResumeContext` interfaces | Task 4 |
| `examples/agent-loops/resume-author/walk-author-sessions.ts` | Example-level helper for PR-fix's candidate walk | Task 5 |
| `examples/agent-loops/resume-author/strategies/same-machine.ts` | `SameMachineCliResumeStrategy` | Task 6 |
| `examples/agent-loops/resume-author/strategies/blob-shipped.ts` | `BlobShippedSessionResumeStrategy` with all guards | Task 7 |
| `examples/agent-loops/resume-author/loop.ts` | `ResumeAuthorAgentLoopAdapter` wrapper | Task 8 |
| `examples/agent-loops/resume-author/index.ts` | Barrel | Task 9 |
| `scripts/run-pr-fix.mjs` | Wire wrapper with `[SameMachineCliResumeStrategy]` | Task 10 |
| `test/examples/agent-loops/resume-author/loop.test.ts` | Wrapper integration-shape test on MemoryHost | Task 11 |
| (validation) | Pre-push canon-audit + CR CLI gate + tests + push + open PR + drive to merge | Task 12 |

Tests live in `test/examples/agent-loops/resume-author/` and `test/examples/agent-loops/resume-author/strategies/`; same vitest config as PR1.

---

## Task 1: `BlobStore.describeStorage()` substrate capability

**Files:**
- Modify: `src/substrate/blob-store.ts`
- Test: `test/substrate/blob-store-contract.test.ts`

**Security + correctness considerations:**
- This is the ONLY src/ touch in PR6 (substrate purity).
- The `kind: 'remote'` variant has a free-form `target: string`; consumers (e.g. `BlobShippedSessionResumeStrategy`) treat remote BlobStores as a trust-transfer point. Any future field additions must preserve the discriminated-union shape so existing consumers' exhaustiveness checks keep working.
- Method is mandatory on the interface (not optional) so back-compat needs the next task to actually implement it on `FileBlobStore`. Plan order: substrate first, reference adapter immediately after, then the dependent strategies.

- [ ] **Step 1: Write the failing contract test**

Append to `test/substrate/blob-store-contract.test.ts` a new describe block:

```ts
import type { BlobStorageDescriptor } from '../../src/substrate/blob-store.js';

describe('BlobStore.describeStorage', () => {
  it('returns a BlobStorageDescriptor with the expected discriminated-union shape', async () => {
    const blobStore = makeFileBlobStore(tmpDir);
    const desc = blobStore.describeStorage();
    if (desc.kind === 'local-file') {
      expect(typeof desc.rootPath).toBe('string');
    } else if (desc.kind === 'remote') {
      expect(typeof desc.target).toBe('string');
    } else {
      // Exhaustive switch: if a new kind is added the type system will catch it here.
      const _: never = desc;
      throw new Error(`unexpected descriptor kind: ${(_ as { kind: string }).kind}`);
    }
  });
});
```

`makeFileBlobStore` is the fixture the existing contract test uses; reuse don't duplicate.

- [ ] **Step 2: Run + verify it fails**

`npx vitest run test/substrate/blob-store-contract.test.ts`
Expected: FAIL -- `describeStorage` not on the interface, type error or runtime "describeStorage is not a function".

- [ ] **Step 3: Add the type + interface method**

In `src/substrate/blob-store.ts`, add ABOVE the `BlobStore` interface:

```ts
/**
 * Describes where this BlobStore puts data. Used by callers that need to
 * gate data flow on storage destination (e.g. refusing to ship sensitive
 * content into a git-tracked tree). The descriptor is part of the public
 * contract a security-conscious caller can rely on for inspection.
 *
 * - `local-file`: the store writes to a single rootPath on the local
 *   filesystem. `rootPath` is absolute; callers may walk up looking for
 *   `.git/` to detect git-tracked destinations.
 * - `remote`: the store writes to a networked target. `target` is a
 *   free-form, operator-readable identifier (e.g. `s3://bucket/prefix`,
 *   `postgres://...`). Callers that gate on storage trust must apply
 *   their own destination-trust review for this case; the framework
 *   does NOT inspect remote targets.
 *
 * The discriminated-union shape ensures exhaustiveness checks at consumer
 * sites; future variants are additive only.
 */
export type BlobStorageDescriptor =
  | { readonly kind: 'local-file'; readonly rootPath: string }
  | { readonly kind: 'remote'; readonly target: string };
```

Inside the `BlobStore` interface, add:

```ts
  /**
   * Describe where this blob store puts data. See `BlobStorageDescriptor`.
   * MUST return a deterministic descriptor; callers may cache the result.
   */
  describeStorage(): BlobStorageDescriptor;
```

- [ ] **Step 4: Run test (still fails -- no implementation)**

The test fails because `FileBlobStore` doesn't yet implement the method. That's expected; Task 2 implements the method. Move on.

- [ ] **Step 5: Pre-commit grep**

```bash
grep -n $'\u2014' src/substrate/blob-store.ts test/substrate/blob-store-contract.test.ts
```

Expected: empty.

- [ ] **Step 6: Canon-audit (per dev-implementation-canon-audit-loop)**

Dispatch a canon-audit subagent with:
- The canon (CLAUDE.md + `.lag/atoms/dev-coderabbit-cli-pre-push.json` + `.lag/atoms/dev-implementation-canon-audit-loop.json`)
- This task (Task 1) text
- The diff: `git diff` against the previous commit
- The threat model context from spec §5

Auditor checks: substrate purity (only the documented additive method touched src/?), discriminated-union shape (does it preserve exhaustiveness for consumers?), JSDoc (mechanism-only, no design refs / canon ids / actor names?). Expected: Approved.

- [ ] **Step 7: Commit**

```bash
node ../../scripts/git-as.mjs lag-ceo add src/substrate/blob-store.ts test/substrate/blob-store-contract.test.ts
node ../../scripts/git-as.mjs lag-ceo commit -m "feat(substrate): BlobStore.describeStorage() capability"
```

---

## Task 2: `FileBlobStore.describeStorage()` reference impl

**Files:**
- Modify: `examples/blob-stores/file/blob-store.ts`
- Modify: `test/substrate/blob-store-contract.test.ts` (test should now pass)

**Security + correctness considerations:**
- `rootPath` returned MUST be the absolute, resolved path (no relative segments). This is what consumer guards rely on for "is this inside a git tree?" walks.
- Method is synchronous to match the interface; do path resolution in the constructor.

- [ ] **Step 1: Verify Task 1's test still fails for `FileBlobStore` specifically**

```bash
npx vitest run test/substrate/blob-store-contract.test.ts -t "describeStorage"
```

Expected: FAIL -- `FileBlobStore.describeStorage is not a function`.

- [ ] **Step 2: Implement**

In `examples/blob-stores/file/blob-store.ts`:
1. In the constructor, resolve `this.rootDir` to an absolute path and store it as a private field `this.resolvedRootPath: string`. Use `path.resolve(rootDir)` from `node:path`.
2. Add the method:

```ts
  describeStorage(): BlobStorageDescriptor {
    return { kind: 'local-file', rootPath: this.resolvedRootPath };
  }
```

3. Import the type: `import type { BlobStorageDescriptor } from '../../../src/substrate/blob-store.js';`

- [ ] **Step 3: Run + verify pass**

```bash
npx vitest run test/substrate/blob-store-contract.test.ts
```

Expected: PASS, including the new `describeStorage` test.

- [ ] **Step 4: Run full suite + typecheck**

```bash
npx vitest run
npm run typecheck
npm run build
```

All green.

- [ ] **Step 5: Pre-commit grep**

Standard checklist (no emdashes, no AI attribution, no design/ refs, no PR-phase markers in src/).

- [ ] **Step 6: Canon-audit**

Dispatch with the same canon + diff. Auditor checks: indie-floor fit (default config still works with no extra setup?), substrate purity preserved.

- [ ] **Step 7: Commit**

```bash
node ../../scripts/git-as.mjs lag-ceo add examples/blob-stores/file/blob-store.ts test/substrate/blob-store-contract.test.ts
node ../../scripts/git-as.mjs lag-ceo commit -m "feat(blob-stores/file): describeStorage returns local-file kind with resolved rootPath"
```

---

## Task 3: `ClaudeCodeAgentLoopAdapter` persists `resumable_session_id` + adds `sessionPersistExtras` hook

**Files:**
- Modify: `examples/agent-loops/claude-code/loop.ts`
- Test: `test/examples/agent-loops/claude-code/loop.test.ts` (extend existing)

**Security + correctness considerations:**
- `resumable_session_id` is just a UUID identifier -- not sensitive. Persisting it in `metadata.agent_session.extra` is safe; `.lag/` is gitignored.
- The `sessionPersistExtras` hook is invoked after the session ends successfully but BEFORE atom finalization. On hook throw: log via host audit, do NOT fail the session. Hook is an extension surface, not a contract obligation.
- Hook receives `Host` so a strategy can read other atoms or log audit events; pass it explicitly.

- [ ] **Step 1: Write the failing test**

Append to the existing claude-code adapter test:

```ts
describe('ClaudeCodeAgentLoopAdapter -- resumable_session_id persistence', () => {
  it('writes extra.resumable_session_id on the session atom on successful completion', async () => {
    const host = createMemoryHost();
    const adapter = new ClaudeCodeAgentLoopAdapter({
      execImpl: makeStubExecaThatYieldsSessionInitWithUuid('test-uuid-001'),
    });
    await adapter.run(makeMinimalAgentLoopInput(host));
    const sessionAtoms = (await host.atoms.query({ type: ['agent-session'] }, 100)).atoms;
    expect(sessionAtoms.length).toBe(1);
    expect((sessionAtoms[0]!.metadata as any).agent_session.extra.resumable_session_id).toBe('test-uuid-001');
  });

  it('invokes sessionPersistExtras hook and merges its return into extra', async () => {
    const host = createMemoryHost();
    const hookCalls: Array<{ sessionId: string }> = [];
    const adapter = new ClaudeCodeAgentLoopAdapter({
      execImpl: makeStubExecaThatYieldsSessionInitWithUuid('test-uuid-002'),
      sessionPersistExtras: async (input) => {
        hookCalls.push({ sessionId: input.sessionId });
        return { custom_field: 'hello', another: 42 };
      },
    });
    await adapter.run(makeMinimalAgentLoopInput(host));
    expect(hookCalls).toEqual([{ sessionId: 'test-uuid-002' }]);
    const session = (await host.atoms.query({ type: ['agent-session'] }, 1)).atoms[0]!;
    expect((session.metadata as any).agent_session.extra).toMatchObject({
      resumable_session_id: 'test-uuid-002',
      custom_field: 'hello',
      another: 42,
    });
  });

  it('hook throw does not fail the session; failure record on session is unchanged', async () => {
    const host = createMemoryHost();
    const adapter = new ClaudeCodeAgentLoopAdapter({
      execImpl: makeStubExecaThatYieldsSessionInitWithUuid('test-uuid-003'),
      sessionPersistExtras: async () => { throw new Error('hook crashed'); },
    });
    const result = await adapter.run(makeMinimalAgentLoopInput(host));
    expect(result.kind).toBe('completed');  // session still completes
    const session = (await host.atoms.query({ type: ['agent-session'] }, 1)).atoms[0]!;
    expect((session.metadata as any).agent_session.failure).toBeUndefined();
    expect((session.metadata as any).agent_session.extra.resumable_session_id).toBe('test-uuid-003');
  });
});
```

The fixtures `makeStubExecaThatYieldsSessionInitWithUuid` and `makeMinimalAgentLoopInput` are pre-existing in the claude-code adapter's test file (look for the system-init stub pattern from PR3). Reuse don't duplicate.

- [ ] **Step 2: Run + verify failure**

`npx vitest run test/examples/agent-loops/claude-code/loop.test.ts`
Expected: FAIL on all three new tests.

- [ ] **Step 3: Implement**

In `examples/agent-loops/claude-code/loop.ts`:

1. Extend `ClaudeCodeAgentLoopOptions`:

```ts
export interface ClaudeCodeAgentLoopOptions {
  // ... existing fields ...
  /**
   * Optional capture hook called after a successful session ends, BEFORE the
   * session atom is finalized. The hook's return value is merged into
   * metadata.agent_session.extra (after `resumable_session_id` is added).
   * On hook throw: logged via host audit; the session still completes
   * normally.
   *
   * Mechanism-only naming so future agent-loop adapters (LangGraph, etc.)
   * that adopt the same shape don't need to fork the field name.
   */
  readonly sessionPersistExtras?: (input: {
    readonly sessionId: string;
    readonly workspace: Workspace;
    readonly host: Host;
  }) => Promise<Readonly<Record<string, unknown>>>;
}
```

2. Find where the adapter currently extracts the CLI session UUID (stream-json system-init parsing; check `examples/agent-loops/claude-code/stream-json-parser.ts:50` for the field name). Capture it into a local variable in the adapter run path.

3. At session-atom finalization time (currently in the `run()` method's success path before the final `host.atoms.update(sessionAtomId, ...)` call):

```ts
let extras: Record<string, unknown> = {};
if (capturedCliSessionId !== undefined) {
  extras.resumable_session_id = capturedCliSessionId;
}
if (this.opts.sessionPersistExtras !== undefined) {
  try {
    const hookResult = await this.opts.sessionPersistExtras({
      sessionId: capturedCliSessionId ?? '',
      workspace: input.workspace,
      host: input.host,
    });
    extras = { ...extras, ...hookResult };
  } catch (err) {
    // Hook is an extension surface; log via host audit and continue. The
    // session atom's failure record is unaffected; future readers can
    // detect a missing custom extra by its absence.
    await input.host.auditor.log({
      kind: 'agent-session-extras-hook-failed',
      principal_id: input.principal,
      timestamp: new Date().toISOString(),
      refs: { atom_ids: [sessionAtomId] },
      details: { reason: err instanceof Error ? err.message : String(err) },
    }).catch(() => undefined);
  }
}
```

Then merge `extras` into the session-atom's `metadata.agent_session.extra` via the existing finalization update call.

- [ ] **Step 4: Run + verify all 3 tests pass + full suite**

```bash
npx vitest run test/examples/agent-loops/claude-code/loop.test.ts
npx vitest run
npm run typecheck && npm run build
```

All green.

- [ ] **Step 5: Pre-commit grep**

Standard checklist.

- [ ] **Step 6: Canon-audit**

Auditor checks: mechanism-neutral naming (NOT `cli_session_id`/`cliSessionExtras`), substrate-extras slot used (not new fields on `AgentSessionMeta`), hook-throw behavior matches spec §3.2, threat-model section §5.1 still holds (extra slot in `.lag/atoms/`, gitignored).

- [ ] **Step 7: Commit**

```bash
node ../../scripts/git-as.mjs lag-ceo add examples/agent-loops/claude-code/loop.ts test/examples/agent-loops/claude-code/loop.test.ts
node ../../scripts/git-as.mjs lag-ceo commit -m "feat(claude-code-adapter): persist resumable_session_id + sessionPersistExtras hook"
```

---

## Task 4: `SessionResumeStrategy` interface + types

**Files:**
- Create: `examples/agent-loops/resume-author/types.ts`
- Test: `test/examples/agent-loops/resume-author/types.test.ts`

**Security + correctness considerations:**
- All fields `readonly` to enforce immutability across strategy boundary.
- `extra: Readonly<Record<string, unknown>>` is the open extension slot; strategies that need adapter-specific fields read from here (the wrapper does NOT interpret).
- `ResolvedSession.preparation` is a required-when-present callback the wrapper invokes BEFORE the resume spawn; its return is `Promise<void>` so failures throw.

- [ ] **Step 1: Write failing TS-shape test**

```ts
import type {
  SessionResumeStrategy,
  CandidateSession,
  ResolvedSession,
  ResumeContext,
} from '../../../../examples/agent-loops/resume-author/types.js';
import type { AtomId } from '../../../../src/substrate/types.js';

describe('SessionResumeStrategy types', () => {
  it('CandidateSession shape', () => {
    const c: CandidateSession = {
      sessionAtomId: 'a' as AtomId,
      resumableSessionId: 'uuid-001',
      startedAt: '2026-04-25T00:00:00.000Z',
      extra: {},
      adapterId: 'claude-code-agent-loop',
    };
    expect(c.adapterId).toBe('claude-code-agent-loop');
  });
  it('ResolvedSession shape with preparation', () => {
    const r: ResolvedSession = {
      resumableSessionId: 'uuid-001',
      resumedFromSessionAtomId: 'a' as AtomId,
      strategyName: 'same-machine-cli',
      preparation: async () => {},
    };
    expect(typeof r.preparation).toBe('function');
  });
  it('SessionResumeStrategy contract (compile-time only)', () => {
    const s: SessionResumeStrategy = {
      name: 'stub',
      async findResumableSession() { return null; },
    };
    expect(s.name).toBe('stub');
  });
});
```

- [ ] **Step 2: Verify failure**

Module not found. `npx vitest run test/examples/agent-loops/resume-author/types.test.ts`.

- [ ] **Step 3: Implement**

Create `examples/agent-loops/resume-author/types.ts`:

```ts
import type { AtomId, Time } from '../../../src/substrate/types.js';
import type { Workspace } from '../../../src/substrate/workspace-provider.js';
import type { Host } from '../../../src/substrate/interface.js';

export interface CandidateSession {
  readonly sessionAtomId: AtomId;
  /**
   * Adapter-neutral resumable token. Read from
   * metadata.agent_session.extra.resumable_session_id. For Claude Code this
   * is the CLI session UUID; for other adapters it is whatever opaque
   * token the adapter's sessionPersistExtras produced.
   */
  readonly resumableSessionId: string;
  readonly startedAt: Time;
  /**
   * Full extra slot from the session atom. Strategies that need
   * adapter-specific fields (e.g. session_file_blob_ref, cli_version)
   * read them from here.
   */
  readonly extra: Readonly<Record<string, unknown>>;
  /**
   * The agent-loop adapter id that produced this session
   * (e.g. 'claude-code-agent-loop'). Strategies use this to skip
   * sessions produced by an incompatible adapter.
   */
  readonly adapterId: string;
}

export interface ResumeContext {
  readonly candidateSessions: ReadonlyArray<CandidateSession>;
  readonly workspace: Workspace;
  readonly host: Host;
}

export interface ResolvedSession {
  readonly resumableSessionId: string;
  readonly resumedFromSessionAtomId: AtomId;
  readonly strategyName: string;
  /**
   * Optional preparation step (e.g., write a session file to local CLI
   * cache before `claude --resume`). Wrapper calls this after the
   * strategy resolves and before the underlying adapter spawn.
   */
  readonly preparation?: () => Promise<void>;
}

export interface SessionResumeStrategy {
  readonly name: string;
  /** Resolve a resumable session, or return null to defer to the next strategy. */
  findResumableSession(ctx: ResumeContext): Promise<ResolvedSession | null>;
  /**
   * Optional capture hook plugged into the underlying adapter's
   * `sessionPersistExtras` callback. The wrapper handles registration so
   * the strategy doesn't need to know which adapter implements the hook.
   */
  onSessionPersist?(input: {
    readonly sessionId: string;
    readonly workspace: Workspace;
    readonly host: Host;
  }): Promise<Readonly<Record<string, unknown>>>;
}
```

- [ ] **Step 4: Run + verify pass**

`npx vitest run test/examples/agent-loops/resume-author/types.test.ts`
`npm run typecheck && npm run build`
Both green.

- [ ] **Step 5: Pre-commit grep**

- [ ] **Step 6: Canon-audit**

Auditor checks: substrate purity (interface lives in examples/, not src/), JSDoc mechanism-only, no actor names, future-proofing on `extra` slot.

- [ ] **Step 7: Commit**

```bash
node ../../scripts/git-as.mjs lag-ceo add examples/agent-loops/resume-author/types.ts test/examples/agent-loops/resume-author/types.test.ts
node ../../scripts/git-as.mjs lag-ceo commit -m "feat(resume-author): SessionResumeStrategy interface + types"
```

---

## Task 5: `walkAuthorSessions` example-level helper

**Files:**
- Create: `examples/agent-loops/resume-author/walk-author-sessions.ts`
- Test: `test/examples/agent-loops/resume-author/walk-author-sessions.test.ts`

**Security + correctness considerations:**
- The walk MUST stop at PR boundaries (don't follow `dispatched_session_atom_id` chains across different PRs even if atoms accidentally cross-link). PR-fix's metadata.pr_fix_observation has `pr_owner`/`pr_repo`/`pr_number`; the walker filters by these.
- Returns sessions sorted newest-first (by `agent_session.started_at`). Caller can apply additional staleness filters.
- Missing `extra.resumable_session_id` on a session atom = skip; do not throw. Legacy sessions (pre-PR6) lack the field.

- [ ] **Step 1: Write failing test on MemoryHost**

```ts
import { walkAuthorSessions } from '../../../examples/agent-loops/resume-author/walk-author-sessions.js';

describe('walkAuthorSessions', () => {
  it('returns candidate sessions newest-first scoped to one PR', async () => {
    const host = await createMemoryHostWithFixture({
      // 3 pr-fix-observation atoms on PR (o, r, 1) at t=1, t=2, t=3
      // each with dispatched_session_atom_id pointing to a distinct
      // agent-session atom carrying resumable_session_id + adapter_id
      // 1 unrelated pr-fix-observation atom on PR (o, r, 2) at t=2
      //   pointing to its own session
    });
    const candidates = await walkAuthorSessions(host, 'pr-fix-obs-3' as AtomId);
    expect(candidates.length).toBe(3);
    expect(candidates[0]!.startedAt > candidates[1]!.startedAt).toBe(true);
    expect(candidates.every(c => /* on PR (o,r,1) */ true)).toBe(true);
  });

  it('skips sessions missing extra.resumable_session_id', async () => { /* legacy session */ });
  it('skips sessions with mismatched adapterId filter', async () => { /* TODO */ });
  it('returns empty when starting observation has no dispatched_session_atom_id chain', async () => {});
  it('does not cross PR boundaries', async () => { /* PR (o,r,2) chain not followed */ });
});
```

- [ ] **Step 2: Verify failure**

- [ ] **Step 3: Implement**

```ts
import type { Atom, AtomId } from '../../src/substrate/types.js';
import type { Host } from '../../src/substrate/interface.js';
import type { CandidateSession } from './types.js';

export async function walkAuthorSessions(
  host: Host,
  startingObservationAtomId: AtomId,
): Promise<ReadonlyArray<CandidateSession>> {
  const startObs = await host.atoms.get(startingObservationAtomId);
  if (startObs === undefined) return [];
  const meta = startObs.metadata as Record<string, unknown>;
  const prFixObs = meta['pr_fix_observation'] as Record<string, unknown> | undefined;
  if (prFixObs === undefined) return [];
  const owner = prFixObs['pr_owner'];
  const repo = prFixObs['pr_repo'];
  const number = prFixObs['pr_number'];

  // Walk dispatched_session_atom_id chain; collect sessions on this PR.
  const candidates: CandidateSession[] = [];
  let current: Atom | undefined = startObs;
  const visited = new Set<string>();
  while (current !== undefined) {
    if (visited.has(current.id)) break;  // cycle guard
    visited.add(current.id);
    const m = current.metadata as Record<string, unknown>;
    const obsMeta = m['pr_fix_observation'] as Record<string, unknown> | undefined;
    if (obsMeta === undefined) break;
    if (obsMeta['pr_owner'] !== owner || obsMeta['pr_repo'] !== repo || obsMeta['pr_number'] !== number) break;
    const sessionId = obsMeta['dispatched_session_atom_id'] as AtomId | undefined;
    if (sessionId !== undefined) {
      const sessionAtom = await host.atoms.get(sessionId);
      if (sessionAtom !== undefined) {
        const sm = sessionAtom.metadata as Record<string, unknown>;
        const agentSession = sm['agent_session'] as Record<string, unknown> | undefined;
        const extra = (agentSession?.['extra'] as Record<string, unknown> | undefined) ?? {};
        const resumableSessionId = extra['resumable_session_id'];
        const adapterId = (agentSession?.['adapter_id'] as string | undefined) ?? '';
        const startedAt = (agentSession?.['started_at'] as string | undefined) ?? '';
        if (typeof resumableSessionId === 'string' && resumableSessionId.length > 0) {
          candidates.push({
            sessionAtomId: sessionAtom.id,
            resumableSessionId,
            startedAt,
            extra: extra as Readonly<Record<string, unknown>>,
            adapterId,
          });
        }
      }
    }
    // Walk to the prior observation: provenance.derived_from typically
    // contains the prior observation atom id as its first element. PR-fix's
    // observation chain is provenance-driven (not metadata-driven).
    const priorIds = current.provenance.derived_from;
    if (priorIds.length === 0) break;
    current = await host.atoms.get(priorIds[0]!);
  }
  // Sort newest-first by startedAt.
  return candidates.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}
```

(Refine the algorithm against actual atom shapes; the implementer may need to read PR-fix's atom builder to confirm where `dispatched_session_atom_id` lives.)

- [ ] **Step 4: Run + verify pass**

- [ ] **Step 5: Pre-commit grep**

- [ ] **Step 6: Canon-audit**

Auditor checks: PR-boundary scoping is enforced (multi-tenancy at scale), cycle guard prevents infinite walks, missing-field handling fails-soft (legacy session compatibility).

- [ ] **Step 7: Commit**

```bash
node ../../scripts/git-as.mjs lag-ceo add examples/agent-loops/resume-author/walk-author-sessions.ts test/examples/agent-loops/resume-author/walk-author-sessions.test.ts
node ../../scripts/git-as.mjs lag-ceo commit -m "feat(resume-author): walkAuthorSessions helper for PR-fix candidate assembly"
```

---

## Task 6: `SameMachineCliResumeStrategy`

**Files:**
- Create: `examples/agent-loops/resume-author/strategies/same-machine.ts`
- Test: `test/examples/agent-loops/resume-author/strategies/same-machine.test.ts`

**Security + correctness considerations:**
- Filters candidates to `adapterId === 'claude-code-agent-loop'` so it skips sessions from incompatible adapters.
- No data flow to network or to other machines; the resume runs locally via `claude --resume`. No new exfiltration surface.
- Default `maxStaleHours = 8`; configurable.

- [ ] **Step 1: Write failing tests**

```ts
describe('SameMachineCliResumeStrategy', () => {
  it('returns null when no candidates', async () => {
    const ctx: ResumeContext = { candidateSessions: [], workspace: stubWs, host: stubHost };
    const s = new SameMachineCliResumeStrategy();
    expect(await s.findResumableSession(ctx)).toBeNull();
  });
  it('returns the freshest claude-code candidate within maxStaleHours', async () => {
    const ctx = makeCtx([
      { /* claude-code, 9h ago */ adapterId: 'claude-code-agent-loop', startedAt: nineHoursAgo() },
      { /* claude-code, 1h ago */ adapterId: 'claude-code-agent-loop', startedAt: oneHourAgo(), resumableSessionId: 'fresh-uuid', sessionAtomId: 'a' as AtomId },
    ]);
    const s = new SameMachineCliResumeStrategy({ maxStaleHours: 8 });
    const r = await s.findResumableSession(ctx);
    expect(r?.resumableSessionId).toBe('fresh-uuid');
  });
  it('skips non-claude-code adapters', async () => {
    const ctx = makeCtx([{ adapterId: 'langgraph', startedAt: oneHourAgo() }]);
    const s = new SameMachineCliResumeStrategy();
    expect(await s.findResumableSession(ctx)).toBeNull();
  });
  it('skips all-stale candidates', async () => {
    const ctx = makeCtx([{ adapterId: 'claude-code-agent-loop', startedAt: nineHoursAgo() }]);
    const s = new SameMachineCliResumeStrategy({ maxStaleHours: 8 });
    expect(await s.findResumableSession(ctx)).toBeNull();
  });
});
```

- [ ] **Step 2: Verify failure**

- [ ] **Step 3: Implement**

```ts
import type {
  SessionResumeStrategy,
  ResolvedSession,
  ResumeContext,
} from '../types.js';

const DEFAULT_MAX_STALE_HOURS = 8;
const HOUR_MS = 60 * 60 * 1000;

export interface SameMachineCliResumeStrategyOptions {
  readonly maxStaleHours?: number;
}

export class SameMachineCliResumeStrategy implements SessionResumeStrategy {
  readonly name = 'same-machine-cli';
  private readonly maxStaleMs: number;

  constructor(opts?: SameMachineCliResumeStrategyOptions) {
    this.maxStaleMs = (opts?.maxStaleHours ?? DEFAULT_MAX_STALE_HOURS) * HOUR_MS;
  }

  async findResumableSession(ctx: ResumeContext): Promise<ResolvedSession | null> {
    const compatible = ctx.candidateSessions.filter(s => s.adapterId === 'claude-code-agent-loop');
    const fresh = compatible.find(s => Date.now() - new Date(s.startedAt).getTime() < this.maxStaleMs);
    if (fresh === undefined) return null;
    return {
      resumableSessionId: fresh.resumableSessionId,
      resumedFromSessionAtomId: fresh.sessionAtomId,
      strategyName: this.name,
    };
  }
}
```

- [ ] **Step 4: Run + verify pass**

- [ ] **Step 5: Pre-commit grep**

- [ ] **Step 6: Canon-audit**

Auditor checks: indie-floor fit (zero config; same-machine is the default), substrate purity (lives in examples/), no leakage of operator-machine state.

- [ ] **Step 7: Commit**

```bash
node ../../scripts/git-as.mjs lag-ceo add examples/agent-loops/resume-author/strategies/same-machine.ts test/examples/agent-loops/resume-author/strategies/same-machine.test.ts
node ../../scripts/git-as.mjs lag-ceo commit -m "feat(resume-author): SameMachineCliResumeStrategy"
```

---

## Task 7: `BlobShippedSessionResumeStrategy` with all guards

**Files:**
- Create: `examples/agent-loops/resume-author/strategies/blob-shipped.ts`
- Test: `test/examples/agent-loops/resume-author/strategies/blob-shipped.test.ts`

**Security + correctness considerations (this is the highest-risk task in the PR):**
- ALL FOUR guards from spec §3.6 + §5.2 are construction-time enforced:
  1. `acknowledgeSessionDataFlow: true` literal required (TypeScript narrows on `true`; runtime constructor double-checks)
  2. `redactor` REQUIRED, no default; identity redactor (a sentinel runtime check) rejected
  3. `blobStore.describeStorage()` inspected: `local-file` rootPath walking up to `.git/` rejects; `remote` logged at INFO and proceeds
  4. `cliVersion` pinned at construction; `findResumableSession` rejects mismatch
- Capture path applies redactor BEFORE `blobStore.put()`.
- Rehydration path writes to local CLI cache with mode 0600 for the file, 0700 for parent dirs.
- Slug derivation algorithm (per spec §3.6): take absolute cwd, drop leading separator, replace remaining `/` (POSIX) or `\\` (Windows) with `-`. CLI-version pin gates this convention.
- The class refuses construction without all guards. This is the spec's load-bearing safety net; auditor must explicitly verify each guard.

- [ ] **Step 1: Write failing tests** (constructor guards FIRST)

```ts
describe('BlobShippedSessionResumeStrategy -- construction guards', () => {
  it('throws when acknowledgeSessionDataFlow is missing', () => {
    expect(() => new BlobShippedSessionResumeStrategy({ /* no ack */ } as any)).toThrow(/acknowledgeSessionDataFlow/);
  });
  it('throws when redactor missing', () => {
    expect(() => new BlobShippedSessionResumeStrategy({ acknowledgeSessionDataFlow: true, blobStore: stubBs, cliVersion: '2.0.0' } as any)).toThrow(/redactor/);
  });
  it('throws when redactor is identity', () => {
    expect(() => new BlobShippedSessionResumeStrategy({
      acknowledgeSessionDataFlow: true,
      redactor: { redact: (x: string) => x } as any,  // identity sentinel
      blobStore: stubBs, cliVersion: '2.0.0',
    })).toThrow(/redactor.*identity/i);
  });
  it('throws when BlobStore.describeStorage() rootPath is inside a git tree', () => {
    const bs = makeFileBlobStore(insideGitTreeDir);
    expect(() => new BlobShippedSessionResumeStrategy({
      acknowledgeSessionDataFlow: true, redactor: tunedRedactor, blobStore: bs, cliVersion: '2.0.0',
    })).toThrow(/git-tracked/);
  });
  it('logs INFO and proceeds when describeStorage returns kind: remote', () => {
    const bs = { describeStorage: () => ({ kind: 'remote', target: 's3://example' }), ...stubBlobStoreOps } as BlobStore;
    expect(() => new BlobShippedSessionResumeStrategy({
      acknowledgeSessionDataFlow: true, redactor: tunedRedactor, blobStore: bs, cliVersion: '2.0.0',
    })).not.toThrow();
    expect(infoLogs).toContainEqual(expect.stringMatching(/remote.*s3:\/\/example/));
  });
});

describe('BlobShippedSessionResumeStrategy -- onSessionPersist (capture)', () => {
  it('reads .jsonl, redacts, puts via BlobStore, returns extras with blob_ref + cli_version + captured_at', async () => { /* ... */ });
  it('returns {} when .jsonl is absent or unreadable (capture fails open)', async () => { /* ... */ });
});

describe('BlobShippedSessionResumeStrategy -- findResumableSession (rehydrate)', () => {
  it('returns null when no candidate has session_file_blob_ref', async () => {});
  it('returns null when cli_version mismatches', async () => {});
  it('returns ResolvedSession with preparation closure on match', async () => {});
  it('preparation closure writes .jsonl to ~/.claude/projects/<derived-slug>/<uuid>.jsonl with 0600', async () => {});
});
```

- [ ] **Step 2: Verify all failures**

- [ ] **Step 3: Implement**

(Full code per spec §3.6; the implementer copies the structure documented there. Important: the slug-derivation comment from spec is preserved in code.)

- [ ] **Step 4: Run all tests + full suite**

```bash
npx vitest run test/examples/agent-loops/resume-author/strategies/blob-shipped.test.ts
npx vitest run
npm run typecheck && npm run build
```

All green.

- [ ] **Step 5: Pre-commit grep**

- [ ] **Step 6: Canon-audit (CRITICAL -- pass §5 threat model context to auditor)**

Dispatch with EXPLICIT threat model context. The auditor must confirm:
- All 4 construction guards enforce at construction-time, not just at runtime
- `acknowledgeSessionDataFlow: true` is the literal `true` (not just truthy)
- Redactor identity sentinel is robust (not just function-reference equality; consider checking semantic identity via a known-payload roundtrip)
- Destination guard walks up looking for `.git/` AND uses absolute `path.resolve` first
- CLI-version mismatch causes `findResumableSession` to return null (not throw)
- File mode 0600 + parent dir mode 0700 are correctly applied on rehydration
- Slug derivation comment matches §3.6 verbatim

If auditor flags ANY guard as not robust enough, fix and re-audit. This task does not commit until canon-audit Approves.

- [ ] **Step 7: Commit**

```bash
node ../../scripts/git-as.mjs lag-ceo add examples/agent-loops/resume-author/strategies/blob-shipped.ts test/examples/agent-loops/resume-author/strategies/blob-shipped.test.ts
node ../../scripts/git-as.mjs lag-ceo commit -m "feat(resume-author): BlobShippedSessionResumeStrategy with default-deny construction + 4 guards"
```

---

## Task 8: `ResumeAuthorAgentLoopAdapter` wrapper

**Files:**
- Create: `examples/agent-loops/resume-author/loop.ts`
- Test: `test/examples/agent-loops/resume-author/loop.test.ts`

**Security + correctness considerations:**
- Wrapper is policy-free: no failure classification, no retry, no escalation. Any non-`completed` result OR throw from the resume path delegates to fallback.
- Fallback runtime check: defensive `if (!opts.fallback) throw` at construction.
- Fallback's synchronous throw is NOT caught (per spec §6.4); propagates as wrapper's throw.
- Capabilities mirror the fallback's (delegated). Wrapper does NOT advertise different `tracks_cost` / `supports_signal` / `classify_failure`.
- Both attempts (resume + fallback) get separate agent-session atoms; the underlying adapter writes one per call. On success, the wrapper patches `extra.resumed_from_atom_id` + `extra.resume_strategy_used` for audit correlation.

- [ ] **Step 1: Write failing tests on MemoryHost**

(See spec §8.2 Integration shape for the test plan)

```ts
describe('ResumeAuthorAgentLoopAdapter', () => {
  it('first non-null strategy wins; resume invocation runs; new session atom written', async () => {});
  it('all strategies return null → delegates to fallback; only fallback session atom written', async () => {});
  it('strategy resolves but resume returns non-completed → delegates to fallback; both atoms cross-referenced', async () => {});
  it('strategy resolves but resume throws → delegates to fallback; both atoms recorded', async () => {});
  it('preparation closure runs before resume spawn', async () => {});
  it('extra.resumed_from_atom_id and extra.resume_strategy_used populated on success', async () => {});
  it('extra.resumed_from_atom_id + resume_strategy_used set on success path', async () => {});
  it('throws at construction when fallback is undefined', () => {});
});
```

- [ ] **Step 2: Verify failure**

- [ ] **Step 3: Implement**

```ts
import type { AgentLoopAdapter, AgentLoopInput, AgentLoopResult, AdapterCapabilities } from '../../../src/substrate/agent-loop.js';
import type { Host } from '../../../src/substrate/interface.js';
import type { SessionResumeStrategy, CandidateSession, ResumeContext, ResolvedSession } from './types.js';

export interface ResumeAuthorAdapterOptions {
  readonly fallback: AgentLoopAdapter;
  readonly host: Host;
  readonly strategies: ReadonlyArray<SessionResumeStrategy>;
  readonly assembleCandidates: (input: AgentLoopInput) => Promise<ReadonlyArray<CandidateSession>>;
  readonly maxStaleHours?: number;
}

export class ResumeAuthorAgentLoopAdapter implements AgentLoopAdapter {
  readonly capabilities: AdapterCapabilities;
  constructor(private readonly opts: ResumeAuthorAdapterOptions) {
    if (opts.fallback === undefined || opts.fallback === null) {
      throw new Error('ResumeAuthorAgentLoopAdapter: fallback is required');
    }
    this.capabilities = opts.fallback.capabilities;
  }

  async run(input: AgentLoopInput): Promise<AgentLoopResult> {
    let resolved: ResolvedSession | null = null;
    try {
      const candidates = await this.opts.assembleCandidates(input);
      const ctx: ResumeContext = { candidateSessions: candidates, workspace: input.workspace, host: this.opts.host };
      for (const strategy of this.opts.strategies) {
        resolved = await strategy.findResumableSession(ctx);
        if (resolved !== null) break;
      }
    } catch (err) {
      // Candidate-assembly errors fall through to fallback; not the wrapper's job to recover.
      resolved = null;
    }

    if (resolved === null) {
      return this.opts.fallback.run(input);
    }

    // Strategy resolved. Run preparation if present, then attempt resume via the
    // fallback adapter (the underlying agent-loop adapter knows how to spawn a
    // resume-aware invocation when given a resumableSessionId hint via input).
    // Today: the fallback IS the underlying spawner; we pass the resumableSessionId
    // through input (extension via metadata or a wrapper-only input field).
    // SIMPLEST IMPLEMENTATION: the wrapper invokes a separate "resume-mode" call on
    // the underlying adapter. For PR6 the underlying adapter is ClaudeCodeAgentLoopAdapter;
    // it does not yet have a resume-mode entry point. THIS TASK's implementer must
    // coordinate with Task 3's ClaudeCodeAgentLoopAdapter changes to add a
    // resumeSessionId option on AgentLoopInput (substrate-additive optional field
    // OR adapter-side option) so the resume call works. SEE BELOW for the substrate
    // shape decision.

    if (resolved.preparation !== undefined) {
      try { await resolved.preparation(); }
      catch (err) {
        // Preparation failed (e.g., disk full); fall back.
        return this.opts.fallback.run(input);
      }
    }

    // Spawn resume via the fallback (passing resumableSessionId hint).
    let resumeResult: AgentLoopResult;
    try {
      // The wrapper must pass the resumableSessionId through to the spawn.
      // PROPOSED: extend AgentLoopInput with optional `resumeSessionId?: string`.
      // ClaudeCodeAgentLoopAdapter checks for this in run() and spawns
      // `claude --resume <id>` when set.
      resumeResult = await this.opts.fallback.run({
        ...input,
        // @ts-expect-error -- resumeSessionId is the substrate-additive field
        resumeSessionId: resolved.resumableSessionId,
      });
    } catch (err) {
      // Resume threw; fallback to fresh-spawn.
      return this.opts.fallback.run(input);
    }

    if (resumeResult.kind !== 'completed') {
      // Resume reached a non-completed terminal state; fallback to fresh-spawn.
      // The original session-atom from resumeResult is preserved in atom store;
      // the wrapper does not retroactively edit it. It does write a separate
      // marker via the audit log if useful.
      return this.opts.fallback.run(input);
    }

    // Resume succeeded. Patch the session-atom with resumed_from_atom_id and
    // resume_strategy_used via host.atoms.update.
    await this.opts.host.atoms.update(resumeResult.sessionAtomId, {
      metadata: {
        agent_session: {
          extra: {
            resumed_from_atom_id: resolved.resumedFromSessionAtomId,
            resume_strategy_used: resolved.strategyName,
          },
        },
      },
    } as any);
    return resumeResult;
  }
}
```

**SUBSTRATE-SHAPE DECISION (block to resolve before implementation):** the wrapper needs to pass `resumableSessionId` through to the underlying adapter. Two options:

- **Option A**: extend `AgentLoopInput` with `readonly resumeSessionId?: string`. Substrate-additive; one optional field. ClaudeCodeAgentLoopAdapter checks for it and spawns `claude --resume`.
- **Option B**: wrapper directly invokes a NEW `resume()` method on a sibling interface (`ResumableAgentLoopAdapter extends AgentLoopAdapter`). Strict separation; non-resumable adapters opt out cleanly.

**Recommendation: Option A.** Substrate-additive optional field is a smaller surface; the field is mechanism-neutral; non-resume-aware adapters ignore it. Document the field in `src/substrate/agent-loop.ts` JSDoc as "opaque token a resume-aware adapter MAY honor."

**THIS IS A SUBSTRATE TOUCH the spec did not anticipate.** Surface it explicitly to the operator + auditor in this task's canon-audit. If operator approves Option A, modify the plan + spec to reflect it.

- [ ] **Step 4: Run + verify pass**

- [ ] **Step 5: Pre-commit grep**

- [ ] **Step 6: Canon-audit (CRITICAL -- note substrate-shape decision)**

Auditor: confirm wrapper is policy-free (no retry, no classifier, no escalation), confirm both attempts produce separate agent-session atoms (not modifying existing atoms in-place), confirm resumeSessionId substrate addition is mechanism-neutral.

- [ ] **Step 7: Commit**

```bash
node ../../scripts/git-as.mjs lag-ceo add examples/agent-loops/resume-author/loop.ts test/examples/agent-loops/resume-author/loop.test.ts <substrate-changes-if-Option-A>
node ../../scripts/git-as.mjs lag-ceo commit -m "feat(resume-author): ResumeAuthorAgentLoopAdapter wrapper (policy-free orchestration)"
```

---

## Task 9: `examples/agent-loops/resume-author/index.ts` barrel

**Files:**
- Create: `examples/agent-loops/resume-author/index.ts`
- Test: `test/examples/agent-loops/resume-author/index.test.ts` (just imports compile check)

**Security + correctness considerations:** None substantive; this is an export-list file.

- [ ] **Step 1-7:** Standard barrel pattern. Re-export `ResumeAuthorAgentLoopAdapter`, `SessionResumeStrategy`, `CandidateSession`, `ResolvedSession`, `ResumeContext`, `SameMachineCliResumeStrategy`, `BlobShippedSessionResumeStrategy`, `walkAuthorSessions`, and the relevant constructor option types. Test asserts the import compiles. Commit.

```bash
node ../../scripts/git-as.mjs lag-ceo commit -m "feat(resume-author): public-surface barrel"
```

---

## Task 10: Driver wiring in `scripts/run-pr-fix.mjs`

**Files:**
- Modify: `scripts/run-pr-fix.mjs`

**Security + correctness considerations:**
- Default wiring is `[SameMachineCliResumeStrategy]` only. `BlobShippedSessionResumeStrategy` is shipped but NOT wired in the reference driver. This is the safety floor -- operators who want blob-shipped MUST copy the driver and explicitly opt in.
- The `assembleCandidates` callback closes over the per-iteration PR observation atom id supplied by PrFixActor's runner.

- [ ] **Step 1-7:**
1. Import `ResumeAuthorAgentLoopAdapter`, `SameMachineCliResumeStrategy`, `walkAuthorSessions` from the dist barrel.
2. Replace the existing `agentLoop` adapter wiring with the wrapper construction.
3. The `assembleCandidates` callback signature is `(input: AgentLoopInput) => Promise<ReadonlyArray<CandidateSession>>`. The callback needs the PR observation atom id; it's threaded via PrFixActor's per-iteration construction. **OPEN COORDINATION POINT WITH TASK 8:** if PrFixActor doesn't surface the observation atom id to the agent-loop, the runner needs to assemble candidates differently (e.g., walking from the LAST observation in the atom store rather than a specific one). The implementer must coordinate this with PrFixActor's existing API.
4. Test the wiring via `node scripts/run-pr-fix.mjs --help` (composition smoke test; must not crash on import).
5. Pre-commit grep + canon-audit.
6. Commit:

```bash
node ../../scripts/git-as.mjs lag-ceo commit -m "feat(scripts/run-pr-fix): wire ResumeAuthorAgentLoopAdapter with [SameMachineCliResumeStrategy]"
```

---

## Task 11: Integration-shape test on MemoryHost

**Files:**
- Modify: `test/examples/agent-loops/resume-author/loop.test.ts` (extend; or add e2e-shape file)

**Security + correctness considerations:** None new; integration tests use MemoryHost so no real CLI / no real network.

- [ ] **Step 1-7:** Build a test that seeds:
- A prior `pr-fix-observation` atom with `dispatched_session_atom_id` -> a stub `agent-session` atom whose `extra.resumable_session_id = 'test-uuid-001'` and `adapter_id = 'claude-code-agent-loop'`.
- Construct `ResumeAuthorAgentLoopAdapter` with `[stubResumeStrategy]` that returns ResolvedSession; `fallback` returning canned `AgentLoopResult`.
- Call `adapter.run(input)`. Assert: stubResumeStrategy was called; fallback was NOT called; result carries the seeded session id; atom store gained one new agent-session atom.
- Mirror the failure path: stubResumeStrategy returns null; fallback IS called.

Pre-commit grep + canon-audit. Commit:

```bash
node ../../scripts/git-as.mjs lag-ceo commit -m "test(resume-author): integration shape on MemoryHost"
```

---

## Task 12: Pre-push validation + push + open PR + drive to merge

**Files:** none modified (validation only).

**Security + correctness considerations:**
- Per `dev-implementation-canon-audit-loop` §9.3: dispatch a final canon-compliance auditor on the FULL diff before push. Auditor reads canon + diff + spec §5 threat model + spec §0 future-proofing + all guards. Approves only if no cross-task drift.
- Per `dev-coderabbit-cli-pre-push`: run CR CLI on the full diff. Conditional on task #123 being shipped first. If task #123 has NOT shipped: defer push to after #123 lands. If #123 HAS shipped: run CR CLI, address every critical/major finding before pushing.
- Standard pre-push grep checklist (emdashes, AI attribution, design refs in src/, PR-phase markers in src/).

- [ ] **Step 1: Final canon-audit on full diff**

```bash
git diff main..feat/resume-author-adapter > /tmp/pr6-full-diff.patch
```

Dispatch canon-compliance auditor with: canon (full CLAUDE.md + relevant atoms), spec, full diff, threat model.

Iterate until Approved.

- [ ] **Step 2: CR CLI gate (conditional on task #123)**

If `scripts/cr-precheck.mjs` (or equivalent from task #123) exists:
```bash
node ../../scripts/cr-precheck.mjs --base main
```
Address every critical/major finding before pushing.

If task #123 has NOT shipped: stop here. Surface to operator: "PR6 implementation complete; awaiting task #123 (CR CLI capability) before push per dev-coderabbit-cli-pre-push canon."

- [ ] **Step 3: Pre-push grep**

```bash
grep -rn $'\u2014' src/ test/ examples/agent-loops/resume-author/ examples/agent-loops/claude-code/loop.ts examples/blob-stores/file/blob-store.ts scripts/run-pr-fix.mjs docs/superpowers/ 2>/dev/null | head -3
grep -rEn 'Co-Authored-By: Claude|🤖.*Generated' src/ test/ examples/ scripts/run-pr-fix.mjs 2>/dev/null
grep -rEn 'design/|DECISIONS\.md|\bPR1\b|\bPR2\b|\bPR3\b|\bPR4\b|\bPR5\b|\bPR6\b' src/ 2>/dev/null
```

All empty.

- [ ] **Step 4: Full build + test**

```bash
npm run typecheck && npm run build && npx vitest run
```

All green.

- [ ] **Step 5: Push**

```bash
node ../../scripts/git-as.mjs lag-ceo push origin feat/resume-author-adapter
```

NEVER `-u`. NEVER force-push.

- [ ] **Step 6: Open PR**

```bash
node ../../scripts/gh-as.mjs lag-ceo pr create \
  --base main \
  --head feat/resume-author-adapter \
  --title "feat(resume-author): ResumeAuthorAgentLoopAdapter consuming the agent-loop substrate" \
  --body "$(cat <<'EOF'
## Summary

PR6 of the agentic-actor-loop sequence. Reference adapter that resumes the original PR-authoring agent's session instead of always spawning fresh, restoring the author's accumulated context (file reads, design memory) into fix-iterations. Falls back to fresh-spawn when the session is unrecoverable.

Spec: `docs/superpowers/specs/2026-04-25-resume-author-agent-loop-adapter-design.md` (round 3 approved by spec-reviewer).
Plan: `docs/superpowers/plans/2026-04-25-resume-author-agent-loop-adapter.md`.

## What ships

- Substrate (additive): `BlobStore.describeStorage()` capability; `resumeSessionId?` optional field on `AgentLoopInput` (mechanism-neutral resume hint).
- `ClaudeCodeAgentLoopAdapter`: persists `metadata.agent_session.extra.resumable_session_id`; new `sessionPersistExtras` capture hook.
- New reference adapter at `examples/agent-loops/resume-author/`: `ResumeAuthorAgentLoopAdapter` wrapper + `SessionResumeStrategy` interface + `SameMachineCliResumeStrategy` + `BlobShippedSessionResumeStrategy` (with all 4 guards: default-deny construction, required redactor, destination guard, CLI-version pin).
- Driver: `scripts/run-pr-fix.mjs` wires `[SameMachineCliResumeStrategy]` only. BlobShipped is shipped + constructible but NOT wired in the reference driver.

## Threat model

§5 of the spec is load-bearing. Same-machine path: no new exfiltration surface. Blob-shipped path: 4 enforced construction-time guards prevent accidental conversation-history shipping into git-tracked or untrusted destinations. Operator opt-in is by writing a custom driver with explicit `acknowledgeSessionDataFlow: true` + tuned redactor + operator-controlled BlobStore.

## Future-forward

Today's deployment is same-machine. The blob-shipped strategy is shipped + constructible so when LAG goes multi-machine, the operator wires it without framework changes. Strategy interface is adapter-neutral (`resumable_session_id`, not `cli_session_id`); future agent-loop adapters reuse the shape without forking.

## Out of scope

- Encryption-at-rest for blob-shipped session payloads (spec §5.3 follow-up).
- Operator-notification atom on every blob-shipped capture (spec §5.3 follow-up).
- Integration with PrLandingActor (spec §10 follow-up).
EOF
)"
```

- [ ] **Step 7: Drive to merge**

1. Verify CI green via `node ../../scripts/gh-as.mjs lag-ceo pr view <PR#> --json mergeStateStatus,statusCheckRollup`.
2. Verify CR review: address findings via subagent dispatch (one per finding) per `feedback_detailed_coderabbit_replies`.
3. Per memory `feedback_thread_check_before_merge`: direct-query unresolved threads via GraphQL before admin-merge.
4. Once CodeRabbit status is success + 0 unresolved threads + mergeStateStatus CLEAN: merge via `node ../../scripts/gh-as.mjs lag-ceo pr merge <PR#> --squash --delete-branch`.
5. Pull main locally per `feedback_pull_main_after_pr_merge`.
6. Update memory: write `project_pr6_resume_author_adapter_landed.md`.
7. Mark task #121 + #127 complete.

---

## Implementation order (suggested DAG)

```text
Task 1 (BlobStore.describeStorage) ──┐
                                     ├─ Task 4 (SessionResumeStrategy types)
Task 2 (FileBlobStore impl)  ────────┤
                                     │
Task 3 (claude-code adapter persist) ┤
                                     ├─ Task 5 (walkAuthorSessions)
                                     │      │
                                     │      ├─ Task 6 (SameMachine)
                                     │      ├─ Task 7 (BlobShipped)
                                     │      │
                                     │      └─ Task 8 (Wrapper)
                                     │             │
                                     │             ├─ Task 9 (Barrel)
                                     │             │      │
                                     │             │      └─ Task 10 (Driver)
                                     │             │             │
                                     │             │             └─ Task 11 (Integration test)
                                     │             │                    │
                                     └─────────────┴────────────────────┴─ Task 12 (Pre-push + merge)
```

Tasks 1+2 unblock everything else. Tasks 3, 4, 5 are independent of each other. Tasks 6, 7, 8 depend on 4 + 5. The DAG allows for moderate parallelism; subagent-driven-development should still serialize for context-isolation reasons.

---

## Notes for implementers

1. **Per-task canon-audit is NOT optional.** Every substantive task (1-11) dispatches a canon-compliance auditor before commit. Per `dev-implementation-canon-audit-loop`. Final canon-audit on full diff in Task 12.

2. **Pre-push CR CLI gate.** Conditional on task #123 (CR CLI capability) being shipped. If #123 has NOT shipped before this PR's implementation completes, stop at Task 12 step 2 and surface to operator. Do NOT skip the gate.

3. **Substrate additions surfaced during implementation.** Task 8 may need to add `AgentLoopInput.resumeSessionId?: string` to the substrate. This is one additive optional field -- auditor must confirm it's mechanism-neutral. If operator rejects the substrate addition, fall back to a non-substrate-touching invocation pattern (wrapper adapter spawns claude directly via execa rather than delegating to the underlying ClaudeCodeAgentLoopAdapter for resume).

4. **Worktree path:** all commands assume cwd is `.worktrees/resume-author-adapter`; `git-as.mjs` and `gh-as.mjs` are at `../../scripts/`.

5. **Bot creds:** copied automatically by `wt new`; verify via the first `git-as` call (it logs the role + token expiry).
