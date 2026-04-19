# Prior art: how other agent frameworks shape the actor primitive

**Status**: research note, 2026-04-19
**Purpose**: cheap insurance against reinventing a worse wheel before
shipping `src/actors/` in Phase 53a.

**Caveat**: This is a shape-level survey from training-era knowledge
(cutoff January 2026). Specific APIs in any framework below may have
evolved. The point is to capture the conceptual shapes they have
converged on, not to document current API surfaces.

---

## The frameworks surveyed

| Framework | Language | Core primitive | Memory model | Authority model | External effect model |
| --- | --- | --- | --- | --- | --- |
| LangGraph | Python | `StateGraph` (nodes = agents/tools, edges = transitions) | Typed `State` channel passed between nodes | Implicit (caller wires graph) | Tools as nodes; side effects inside tool fns |
| CrewAI | Python | `Agent` with role/goal + `Crew` orchestrator | Shared "memory" attached to Crew | `role` string field per Agent; no formal auth | Tools attached to Agent; Crew manages handoffs |
| Mastra | TypeScript | `Agent` + `Workflow` (workflow = explicit loop shape) | First-class `Memory` with multiple backends | Implicit | Tools declared on Agent; Workflow steps invoke |
| Autogen | Python | `ConversableAgent` (agents message each other) | Per-agent conversation history | None formal; agents trust messages | Tools registered; invoked via message routing |
| AI SDK (Vercel) | TypeScript | Not a framework; a streaming tool-calling pattern | Caller-owned | None | Tool handlers passed to `generateText`/`streamText` |
| Pydantic AI | Python | Typed `Agent` with output schema | Caller-owned via deps | None | Tools declared on Agent; Pydantic-validated I/O |

---

## Shape-level observations

### 1. All of them separate `Agent` from `Tool`, but **none** separate authority from mechanism

LangGraph, CrewAI, Mastra, Autogen, AI SDK, and Pydantic AI all have an
`Agent` (or equivalent) that bundles identity + mechanism + LLM
configuration into one object. Authority -- *who* is acting and under
what mandate -- is either implicit in the caller's trust model or handled
at a layer above the framework.

**LAG's differentiator**: `Principal` as a first-class primitive with
`signed_by` chain, separated from the `Actor` mechanism. This is the
right split for a governance substrate; no existing framework carries
it as a load-bearing concept.

### 2. Loop shape varies; none are identical to what LAG needs

- LangGraph: state-machine graph; nodes can be arbitrary callables.
  Very expressive but harder to reason about for a simple observation
  loop.
- CrewAI: role-based sequential or hierarchical task execution;
  loop shape is inferred from the Crew structure.
- Mastra: explicit `Workflow` DSL with `step.then(step)` composition.
  Close to LAG's needs but tightly coupled to Mastra's runtime.
- Autogen: message-passing between agents; loop is implicit in the
  conversation.

The **5-phase shape** (`observe -> classify -> propose -> apply ->
reflect`) LAG is proposing is close to a MAPE-K control loop (Monitor,
Analyze, Plan, Execute, Knowledge) from autonomic computing, and
matches Kubernetes controller reconciliation loops. That lineage is
older and better-understood than any of the LLM-era frameworks.

**Decision**: LAG's Actor shape is a MAPE-K descendant. Not novel,
well-established in control theory. Name it plainly; don't overclaim.

### 3. Memory pluggability is table stakes

Every framework above supports at least 2 memory backends (in-memory +
one persistent store). Mastra goes furthest, with first-class
pluggability for vector stores, message stores, and working memory
separately.

**LAG's status**: `Host.AtomStore` is the canonical pluggability
seam. We ship an in-memory adapter, a file adapter, and a bridge
adapter today. Bringing ChromaDB or mempalace-backed stores in is a
new adapter, not a change to the framework. **Table-stakes met.** See
the structural audit for specifics.

### 4. Tool / adapter shape is universal, authority-gating is not

All frameworks let consumers declare tool functions that agents can
call. None of them gate tool calls through a policy layer the way
Phase 52a + runActor will. CrewAI has "guardrails" but they are
output-validation, not authority-matching. LangGraph has "interrupts"
but they are for human-in-the-loop review, not policy enforcement.

**LAG's differentiator**: `checkToolPolicy` inside `runActor` turns
every adapter call into a governance-gated effect. This is load-bearing
for the CTO-layer / autonomy-dial story and has no direct counterpart
elsewhere.

### 5. Composition pattern: all of them build on top of themselves

Each framework's advanced usage is composition of its own simpler
primitives. LangGraph's multi-agent systems are graphs of graphs.
CrewAI's hierarchical crews are crews-of-crews. This validates a core
LAG belief: **the framework must build on top of itself**. An Actor
driving a sub-Actor, a Principal signing another Principal, a canon
that governs the authorship of canon -- these compositions should all
work.

**LAG status**: partially there. Principals compose via `signed_by`
chains. Canon governs itself (the repo is its own first LAG org, D12).
Actors-of-actors is untested but shapes that allow it:
`PrLandingActor` could invoke a `TestTriageActor` as a sub-actor, each
running under its own principal and budget.

---

## What LAG takes from the survey

1. **Loop shape as MAPE-K**. Name it in the doc; cite the lineage;
   don't pretend we invented it.
2. **Memory pluggability as table-stakes, not a selling point**.
3. **Tool/adapter declaration inline on the Actor type**, the way
   Mastra and Pydantic AI do. TypeScript generics carry it cleanly.
4. **Explicit loop shape over implicit conversation flow**. Autogen's
   message-passing style is powerful but hard to audit. LAG's
   5-phase shape is legible.

## What LAG does differently (and intentionally)

1. **Principal as a load-bearing primitive**. The split between
   authority and mechanism is the substrate.
2. **Policy-gated action**. `checkToolPolicy` around every `apply`
   call is unique to LAG.
3. **Canon as a first-class artifact**. Other frameworks have memory;
   none have a distilled, curated layer (L3) that reshapes what future
   runs see.
4. **Substrate discipline**. Other frameworks ship opinions about
   agent roles (CrewAI's role strings, LangGraph's node types); LAG
   ships mechanisms and leaves role naming to canon.

---

## Risks surfaced by the survey

- **Primitive-count risk (confirmed)**: CrewAI onboarding is famously
  simple because they committed to one primitive (`Agent`) and made
  composition additive. LAG's 12+ primitives are a real adoption risk.
  Mitigation tracked in the structural audit.
- **Naming collisions**: our "Actor" collides phonetically with Akka's
  actor-model concurrency primitive. Mitigate in the interface doc:
  LAG Actors are governed autonomous loops, not actor-model mailboxes.
- **Composition-of-composition is easy to underbuild**: LangGraph
  users complain that graphs-of-graphs have opaque debugging. Ensure
  LAG actors-of-actors carry audit trails through composition.

---

## Verdict

LAG's proposed Actor shape is **well-aligned with prior art** on loop
structure (MAPE-K), memory pluggability (table-stakes), and tool
declaration (inline). It is **deliberately different** on authority
(Principal primitive), policy gating (52a around apply), and canon
(L3 curated layer). The differences are the whole point; the
alignments should be quietly adopted, not re-derived.

Ship `src/actors/` with confidence. Ship it with humility about the
primitive-count risk that every surveyed framework also had to manage.
