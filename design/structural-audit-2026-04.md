# Structural audit: 2026-04-19

**Context**: Before shipping Phase 53 (outward-facing Actors),
deliberately check LAG against its stated principles and stated target
(simple-to-describe, sophisticated-to-extend, pluggable across any
memory source, composable, substrate not prescription).

**Method**: one principle per section. Each gets a status (green /
yellow / red), supporting evidence from the current tree, and either
"no action" or a concrete follow-up.

**Legend**:
- **green**: principle holds, no action needed
- **yellow**: principle holds but with friction or a gap worth closing
- **red**: principle violated; must address before shipping more on top

---

## P1. Host interface pluggability (D1 core)

**Principle**: every concrete dependency fits behind one of the 8
`Host` sub-interfaces (AtomStore, CanonStore, LLM, Notifier,
Scheduler, Auditor, PrincipalStore, Clock). Adapters compose at the
consumer's boundary.

**Evidence**:
- `src/adapters/memory/` implements all 8 sub-interfaces (index.ts +
  atom-store, canon-store, llm, notifier, scheduler, auditor,
  principal-store, clock).
- `src/adapters/file/` implements 7 (all except LLM, which is
  provider-specific; LLM lives in `src/adapters/claude-cli/`).
- `src/adapters/bridge/` implements AtomStore + DrawerBridge for
  external stores.
- `src/adapters/notifier/telegram.ts` is a channel implementation
  behind the same Notifier interface.

**Status**: **green**.

**Action**: none. Document more explicitly in the structural-audit
output which adapters cover which sub-interfaces; that is a trivial
table in `docs/framework.md` and will be added next.

---

## P2. Memory-source pluggability ("start from Claude history OR mempalace OR chromadb OR ...")

**Principle**: someone should be able to start from any memory source
and LAG ingests it. We ship a few canonical sources; users bring
their own.

**Evidence**:
- `src/sources/` ships 4 `SessionSource`s: Claude Code transcript,
  Obsidian vault, git log, fresh (empty-seed).
- `IngestOptions` and `SessionSource` interface are clean seams
  consumers can implement against.
- README mentions "ChromaDB / Slack / mempalace on roadmap" (line 187).

**Gaps**:
- No reference ChromaDB source yet. Cost to add: low (thin adapter).
- No mempalace source yet. Cost to add: low once mempalace's export
  shape is pinned (it exports drawers = groups of memories; each
  drawer maps to an L1 observation).
- Because neither ships, a consumer trying to evaluate "can I use my
  existing store?" has to read `SessionSource` and invent an adapter.
  The shape is clean but the empty-slot is friction.

**Status**: **yellow**.

**Actions**:
1. Add `src/sources/chromadb.ts` stub with documented
   `ChromaDBSourceOptions` and a "bring your own client" pattern.
2. Add `src/sources/mempalace.ts` (or under `examples/sources/` if we
   want to keep the `src/` surface narrow -- see P8).
3. Update README Quick-start with a "Bring your own source" paragraph
   pointing at the `SessionSource` interface.

These close the gap from "roadmap" to "code path exists."

---

## P3. Embedder pluggability (retrieval-is-a-stack preference)

**Principle** (per preferences canon): retrieval is a stack, not a
single embedder. Trigram, ONNX MiniLM, caching decorator all compose.

**Evidence**:
- `TrigramEmbedder`, `OnnxMiniLmEmbedder`, `CachingEmbedder` all in
  `src/adapters/_common/`.
- All implement the `Embedder` interface from `src/interface.ts`.
- `CachingEmbedder` decorates any other embedder.

**Status**: **green**.

**Action**: none.

---

## P4. Substrate not prescription (no org shape in `src/`)

**Principle**: the framework ships mechanisms. Our instance (role
names, policies, Telegram-specifically, CTO / pr-landing agent)
lives in canon, skills, `examples/`, not in `src/`.

**Evidence that holds**:
- No `CtoEngine`, no `RoleManager`, no hard-coded decision classes
  in `src/`.
- `Principal` is a shape with `signed_by`; no role enum.
- `metadata.policy` is a convention enforced by `parsePolicy`, not a
  schema baked into the atom type.

**Evidence of smell**:
- `src/daemon/` has `telegram.ts` and explicit Telegram-specific
  behaviors (reply_to binding, `splitForTelegram`, HTML formatting).
  Telegram is one channel among many; having it inside `src/` as a
  runtime surface is defensible (Daemon is a runtime, not prescription)
  but it is also the most consumer-facing code path and it names one
  vendor. If a user is not on Telegram, the blast radius of that
  naming is real.
- `src/adapters/notifier/telegram.ts` is correctly scoped (a notifier
  channel is a channel). That is fine.
- `src/daemon/voice.ts`: `WhisperLocalTranscriber` is a concrete
  voice impl inside `src/`. Same shape concern as Telegram: a
  specific vendor choice in the framework layer.

**Status**: **yellow**.

**Actions**:
1. Rename / retarget `src/daemon/telegram.ts`-adjacent logic so the
   Daemon primitive is vendor-agnostic and the Telegram plumbing is
   behind the Notifier interface (mostly true already; audit the
   seam is clean).
2. Move `WhisperLocalTranscriber` from `src/daemon/voice.ts` to
   `src/adapters/transcriber/whisper.ts` (or equivalent) so the core
   primitive is `VoiceTranscriber` and the vendor impl is an adapter.
3. Neither is urgent. File-tracked as follow-up, not a 53-pre blocker.

---

## P5. D1 (Host is sole boundary) -- pending amendment

**Principle**: `Host` is the sole boundary between framework logic
and implementation.

**Status**: **yellow** -- will become **green** after D17 (in this
same PR) formally narrows D1's scope to governance primitives and
introduces `ActorAdapter` as a deliberate second seam for outward
effects.

See `design/actors-and-adapters.md` for the full resolution.

**Action**: land D17 alongside this audit. No new code reaches around
`Host` until that decision is merged.

---

## P6. Framework builds on top of itself

**Principle**: advanced usage should be composition of simpler LAG
primitives. The repo should be its own first LAG-governed org (D12).

**Evidence**:
- `scripts/bootstrap.mjs` seeds L3 invariants as atoms from a root
  principal and renders them via `CanonMdManager` into this repo's
  own `CLAUDE.md`. The repo governs its own build process.
- Principals compose via `signed_by` chains (D3 hierarchy-aware
  source-rank).
- Canon targets compose via `LoopRunner.canonTargets` (multi-target
  canon, D2).
- Plans execute via atoms; questions bind via atoms; policies are
  atoms. The atom store is the single source of truth; everything
  projects over it.

**Gaps**:
- Actors-of-actors is untested (zero existing multi-actor deployment).
  Composition should work but we have no empirical evidence.

**Status**: **green** for current scope, **pending evidence** on
composition of outward actors. Phase 53 will exercise this.

**Action**: when the second outward Actor ships (post-53), ensure it
can be driven as a sub-actor of the first. Test in integration.

---

## P7. Simple surface, sophisticated underneath

**Principle** (new, saved to memory 2026-04-19): a user should be able
to describe LAG in a sentence and ship hello-world in an afternoon; a
50-actor org should not hit architectural ceilings.

**Evidence that holds**:
- Quick-start in README is 4 commands (`npm install`, `npm run
  build`, `node examples/quickstart.mjs`).
- `examples/quickstart.mjs` is ~90 lines and demonstrates the core
  atoms-and-promotion loop.
- Adapter sub-paths (`/adapters/memory`, `/adapters/file`,
  `/adapters/bridge`, `/adapters/notifier`) keep top-level imports
  cheap.

**Evidence of friction**:
- Top-level `src/index.ts` has **~100 exports** at 318 lines. That's
  a substantial landing page for a newcomer.
- No subpath for `actors`, `policy`, `plans`, `questions` -- all
  top-level. If 53a ships more exports at top level, the surface
  grows again.
- The README currently lists ~15 concepts in "Library shape" (line
  154). That is expressive but is a lot to absorb.
- There is **no explicit layered tutorial** (level 1 = atoms only,
  level 2 = + canon, level 3 = + arbitration, level 4 = + actors).
  Documentation is reference-shaped, not tutorial-shaped.

**Status**: **yellow**.

**Actions**:
1. Move `policy`, `plans`, `questions`, `actors` to subpath imports
   (`lag/policy`, `lag/plans`, `lag/questions`, `lag/actors`) before
   any of them grow further. This is a one-time refactor with low
   blast radius because the top-level surface is a superset.
2. Add a layered tutorial under `docs/tutorial/` with four 5-minute
   chapters: atoms -> canon -> arbitration -> actors. Write it
   once, freeze it as a compatibility contract.
3. Trim the top-level export list in README "Library shape" to the
   10 concepts someone actually needs on day 1; link out for the
   rest.

These three together materially improve day-1 experience without
losing any existing capability. Trackable as Phase 54: onboarding
hardening.

---

## P8. Tests as contract

**Principle**: tests are the framework's enforceable contract. A
change that breaks a test is a change to the contract.

**Evidence**:
- Per-module suites under `test/` (promotion, loop, canon-md,
  daemon, extraction, policy, plans, questions, taint, arbitration,
  ...).
- 13 tests on `policy` (just shipped for 52a).
- CI runs typecheck + build + full suite on Node 22 across Ubuntu
  and Windows.
- Quickstart smoke test runs as part of CI.

**Status**: **green**.

**Action**: extend to actors when 53a lands. Contract will include
convergence guards and budget enforcement.

---

## P9. Canon discipline

**Principle** (D2): canon renders into a bracketed section of a
target `CLAUDE.md`; content outside markers is preserved byte-for-byte.
Multi-target canon composes via `LoopRunner.canonTargets`.

**Evidence**:
- `CanonMdManager` with `CANON_START` / `CANON_END` markers.
- `readSection` / `writeSection` preserve boundaries.
- This repo's own CLAUDE.md is auto-managed and has been stable
  across phases.

**Status**: **green**.

**Action**: none.

---

## Summary

| # | Principle | Status | Action |
| - | --------- | ------ | ------ |
| P1 | Host pluggability | green | document adapter coverage table |
| P2 | Memory-source pluggability | yellow | add ChromaDB + mempalace sources |
| P3 | Embedder pluggability | green | none |
| P4 | Substrate not prescription | yellow | move Whisper to `adapters/`; audit daemon/Telegram seam |
| P5 | D1 Host boundary | yellow -> green | land D17 alongside this audit |
| P6 | Framework builds on itself | green (pending 53 evidence) | test multi-actor composition |
| P7 | Simple surface, sophisticated underneath | yellow | subpath the growth axes + layered tutorial |
| P8 | Tests as contract | green | extend to actors |
| P9 | Canon discipline | green | none |

No reds. Four yellows, each with a concrete mitigation. The framework
is structurally sound to ship Phase 53 on top of, provided D17 lands
in the same batch.

## Recommended ordering

1. **This PR** (docs only): lands design/actors-and-adapters.md,
   prior-art scan, this audit, and DECISIONS entries D16 + D17.
2. **Phase 53a**: `src/actors/` primitive + `PrLandingActor` and
   `CodeRabbit*Adapter`. Enforces the D17 boundary in the first
   exercise.
3. **Phase 53b**: `.claude/skills/pr-landing` + canon atoms for
   `cto-agent` + policies. Our instance.
4. **Phase 54** (onboarding hardening): subpath moves for
   `policy / plans / questions / actors`, layered tutorial, ChromaDB
   + mempalace sources, Whisper move. None block 53; all close the
   yellows above.
5. **Phase 52b**: hook enforcement of `checkToolPolicy`. Independent
   of 53; can run in parallel.
