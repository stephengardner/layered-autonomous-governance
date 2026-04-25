# Real ClaudeCodeAgentLoopAdapter Design (PR3 of agentic-actor-loop)

**Author:** lag-ceo
**Date:** 2026-04-25
**Status:** Proposed
**Tracks:** Section 8.3 / Section 9 follow-up to `docs/superpowers/specs/2026-04-25-agentic-actor-loop-design.md`.
**Replaces (on land):** the substrate-validation skeleton at `examples/agent-loops/claude-code/loop.ts` shipped via PR #166.
**Consumed by:** `AgenticCodeAuthorExecutor` shipped via PR #167.

---

## 1. Goal

Ship a production `AgentLoopAdapter` that spawns the Claude Code CLI in agentic-headless mode, captures every assistant turn + tool-call as `agent-turn` atoms, and returns commit/branch artifacts to `AgenticCodeAuthorExecutor`. After this lands, the agentic-actor-loop substrate runs an actual LLM in an isolated workspace end-to-end; today the path is plumbing-only.

Non-goals:
- `strict` replay tier (canon snapshot pinning)  --  deferred follow-up.
- `AgentSessionMeta.confidence` field  --  substrate does not model it yet.
- Other-actor migrations (planning / auditor / pr-landing)  --  each has its own follow-up plan.
- API-key-based SDK invocation  --  the project standardised on Claude Code CLI OAuth (no API key required); this PR follows that.

---

## 2. Architecture

```
AgenticCodeAuthorExecutor
  └─ ClaudeCodeAgentLoopAdapter.run({task, workspace, budget, redactor, blobStore, ...})
       ├─ spawn `claude -p <prompt>` --cwd workspace.path
       │    --output-format stream-json
       │    --max-budget-usd <budget.max_usd>
       │    --disallowedTools <toolPolicy.disallowedTools>
       │    [--mcp-config '{}']  // disable MCP servers per existing pattern
       ├─ readline stdout: parse one JSON message per line (NDJSON)
       │    ├─ on assistant.text       → start a new turn; redact + write agent-turn atom
       │    ├─ on assistant.tool_use   → append to current turn's tool_calls (outcome:'pending')
       │    ├─ on user.tool_result     → match by tool_use_id; set outcome + result_redacted
       │    └─ on result envelope      → capture total_cost_usd, usage; update session atom
       ├─ adapter-side guards:
       │    ├─ wall_clock_ms timer     → SIGTERM (then SIGKILL after 5s)
       │    ├─ assistant turn counter  → kill at max_turns
       │    └─ AbortSignal             → SIGTERM
       └─ post-CLI artifact capture:
            ├─ git rev-parse HEAD
            ├─ git branch --show-current
            └─ git diff --name-only <baseRef>..HEAD
```

**One CLI invocation per `run()` call.** Claude Code's `claude -p` already iterates internally: the agent reasons, calls tools, gets results, reasons again, until a stop condition (success, tool budget, model budget). The adapter does NOT loop. Adapter responsibility is plumbing: spawn, stream-parse, atom-write, artifact-capture, signal-forward.

**Why subprocess + stream-json, not the SDK:** The codebase already authenticates against Claude via the operator's existing Claude Code OAuth install (`src/adapters/claude-cli/llm.ts`, `src/integrations/agent-sdk/cli-client.ts`). Switching to the Anthropic SDK would require `ANTHROPIC_API_KEY` and bifurcate the auth path. Stream-json mode is the documented format for per-turn message capture.

---

## 3. Components

Single file: `examples/agent-loops/claude-code/loop.ts` (replaces the skeleton). The skeleton class `ClaudeCodeAgentLoopSkeleton` is removed entirely; tests already use ad-hoc stubs (`test/e2e/agentic-actor-loop-chain.test.ts`'s `stubAdapter`) so no test surface depends on the skeleton.

### 3.1 `ClaudeCodeAgentLoopAdapter` (the class)

```ts
export interface ClaudeCodeAgentLoopOptions {
  readonly claudePath?: string;            // default: 'claude' on PATH
  readonly extraArgs?: ReadonlyArray<string>;
  readonly verbose?: boolean;
  readonly execImpl?: typeof execa;        // injectable for tests
  readonly killGracePeriodMs?: number;     // default 5000 (SIGTERM → SIGKILL)
}

export class ClaudeCodeAgentLoopAdapter implements AgentLoopAdapter {
  readonly capabilities: AdapterCapabilities = {
    tracks_cost: true,
    supports_signal: true,
    classify_failure: classifyClaudeCliFailure,
  };
  constructor(opts?: ClaudeCodeAgentLoopOptions);
  async run(input: AgentLoopInput): Promise<AgentLoopResult>;
}
```

### 3.2 `StreamJsonParser` (pure, unit-testable)

Reads NDJSON from a stdout stream into typed events:
- `SessionStart` (from CLI's `system` message)
- `AssistantText` (from `assistant.content[].type === 'text'`)
- `AssistantToolUse` (from `assistant.content[].type === 'tool_use'`)
- `ToolResult` (from `user.content[].type === 'tool_result'`)
- `ResultEnvelope` (final summary with cost + usage)
- `ParseError` (malformed line  --  surfaces with offending line preview, does NOT halt the loop; the substrate spec wants the adapter to keep going through partial corruption)

### 3.3 `buildPromptText(task: AgentTask): string` (pure)

Assembles the user prompt:
1. `task.questionPrompt` (the operator's literal request).
2. If `task.fileContents` is non-empty: a fenced `<file_contents path="...">...</file_contents>` block per entry. Mirrors the diff-based path's pattern of injecting context.
3. If `task.successCriteria`: a `<success_criteria>...</success_criteria>` block.
4. If `task.targetPaths`: a `<target_paths>foo.ts, bar.ts</target_paths>` advisory block.

### 3.4 `captureArtifacts(workspace, baseRef, execImpl)` (pure-ish, runs git)

Runs three git commands inside `workspace.path`:
- `git rev-parse HEAD` → `currentSha`
- `git rev-parse <baseRef>` → `baseSha`
- If `currentSha === baseSha`: returns `undefined` (no commit was made; executor maps to `agentic/no-artifacts`).
- Otherwise: `git branch --show-current` → `branchName`; `git diff --name-only <baseRef>..HEAD` → `touchedPaths`.

Returns `{commitSha, branchName, touchedPaths}` or `undefined`.

### 3.5 `classifyClaudeCliFailure(err, exitCode, stderr)` (adapter-specific classifier)

Beats `defaultClassifyFailure` by inspecting CLI-specific stderr shapes:

| Signal | Mapping |
|---|---|
| stderr contains `rate limit` / `429` | `transient` |
| stderr contains `budget` + non-zero exit | (returned at higher level as `kind: 'budget-exhausted'`) |
| stderr contains `auth` / `401` / `403` | `catastrophic` |
| stderr contains `ENOENT` / `claude: command not found` | `catastrophic` |
| AbortError / SIGTERM | `catastrophic` |
| Any other non-zero exit | `structural` |

Falls back to `defaultClassifyFailure` for non-CLI errors.

### 3.6 `spawnClaudeCli({...})` (execa wrapper, injectable)

Constructs argv:
```
['claude', '-p', '<prompt>',
 '--cwd', workspace.path,
 '--output-format', 'stream-json',
 '--mcp-config', '{}',
 ...(toolPolicy.disallowedTools.length ? ['--disallowedTools', toolPolicy.disallowedTools.join(' ')] : []),
 ...(budget.max_usd ? ['--max-budget-usd', String(budget.max_usd)] : []),
 ...(opts.extraArgs ?? [])]
```

Passes `cwd: workspace.path`, `env: process.env`, `stripFinalNewline: false`, and a `signal` derived from `input.signal` plus the wall-clock timer.

---

## 4. Data flow per turn

For each NDJSON message from the CLI:

| `message.type` + content | Adapter action |
|---|---|
| `system` | Record `model_id`, `session_id` if present (purely informational) |
| `assistant` (text-only block(s)) | Begin a new turn N: redact text via `input.redactor`, write `agent-turn` atom with `metadata.agent_turn = {session_atom_id, turn_index: N, llm_input: {inline: prompt-or-redacted-prior-context}, llm_output: {inline: redacted-text-or-blob-ref}, tool_calls: [], latency_ms}`. The atom is written BEFORE the next assistant message (per substrate contract: "write `agent-turn` atom for each LLM call BEFORE issuing the call"). |
| `assistant` (tool_use block) | Append `{call_id: tool_use.id, tool_name: tool_use.name, args_redacted: redactor.redact(JSON.stringify(tool_use.input)), outcome: 'pending'}` to the **current turn's** `tool_calls`. If args size exceeds `blobThreshold`, route via `blobStore.put` and store as `{blob: BlobRef}`. |
| `user` (tool_result block) | Look up `tool_use_id` in any open turn's `tool_calls`; set `outcome` to `'success'` (default) or `'error'` if `is_error: true`; attach `result_redacted` (or blob ref). |
| `result` (final envelope) | Extract `total_cost_usd`, `usage`, `is_error`. Update the session atom: `terminal_state` per `is_error`, `budget_consumed.usd = total_cost_usd`, `budget_consumed.turns = <turn count>`, `budget_consumed.wall_clock_ms = <Date.now() - startedAt>`, `completed_at = <now>`. |

### 4.1 Turn write timing  --  race with crashes

The substrate contract: "Adapters MUST write an `agent-turn` atom for each LLM call BEFORE issuing the call." The Claude Code CLI is one process; we cannot strictly write atoms before each LLM call inside the subprocess. Practical interpretation:

- We write the `agent-turn` atom upon receiving the assistant's text content (which marks the *end* of the LLM call, not its start). This is a deliberate adapter-level deviation from the strictest reading of the contract: we sacrifice atomicity around the in-flight LLM call to keep the adapter as a pure stream consumer. The trade is documented in JSDoc.
- The atom carries `llm_input.inline = '<embedded by CLI>'` (a placeholder string) because the adapter does not see the per-turn input the CLI assembled  --  only the assistant output. A future enhancement could parse the `system` + `user` messages from stream-json to reconstruct the per-turn input, but that adds parsing complexity for marginal value (full session can be replayed from the workspace state + atoms anyway).

### 4.2 Blob threshold routing

`input.blobThreshold` (already clamped via `clampBlobThreshold`) is the inline-vs-blob cutoff in bytes. Each redacted payload (turn output, tool args, tool result) over threshold goes through `blobStore.put()`; the atom carries the resulting `BlobRef` instead of inline content.

### 4.3 Replay tier semantics

`input.replayTier` is captured on the session atom's `replay_tier`. The adapter implements:
- `best-effort`: same as content-addressed today; no canon snapshot.
- `content-addressed` (default): every payload over threshold lives in blobStore, addressable by `BlobRef`.
- `strict`: same as content-addressed for now; canon-snapshot pinning is deferred.

Future-strict will compute a canon-snapshot hash at session start and pin it via `canon_snapshot_blob_ref`. Out of scope for this PR.

---

## 5. Capabilities

```ts
{
  tracks_cost: true,                   // CLI emits total_cost_usd
  supports_signal: true,               // we forward SIGTERM
  classify_failure: classifyClaudeCliFailure,
}
```

---

## 6. Error handling

| Condition | `kind` | `failure` |
|---|---|---|
| Subprocess exits 0, valid `result` envelope | `'completed'` | undefined |
| Subprocess exits 0, no commit detected | `'completed'` (artifacts undefined → executor maps to `agentic/no-artifacts`) | undefined |
| Wall-clock timer fires | `'aborted'` | `{kind: 'catastrophic', reason: 'wall-clock budget exhausted'}` |
| Turn counter > `max_turns` | `'budget-exhausted'` | `{kind: 'structural', reason: 'turn budget hit', stage: 'max-turns-cap'}` |
| `AbortSignal.aborted === true` | `'aborted'` | `{kind: 'catastrophic', reason: 'caller cancelled'}` |
| stderr matches `/rate limit|429/i`, non-zero exit | `'error'` | `{kind: 'transient', reason: stderr.slice(0, 1000)}` |
| stderr matches `/budget/i`, non-zero exit | `'budget-exhausted'` | `{kind: 'structural', reason: 'CLI reported budget'}` |
| stderr matches `/auth|401|403/i`, non-zero exit | `'error'` | `{kind: 'catastrophic', reason: stderr.slice(0, 1000)}` |
| stderr matches `/ENOENT|command not found/i` | `'error'` | `{kind: 'catastrophic', reason: 'claude binary not found'}` |
| Other non-zero exit | `'error'` | `{kind: 'structural', reason: stderr.slice(0, 1000)}` |
| Unparseable stream-json line | logged + skipped (does NOT abort the loop) | n/a |

---

## 7. Security + correctness

### 7.1 Threat model

- **Subprocess inherits workspace creds.** `git-as` / `gh-as` look in `<workspace>/.lag/apps/`. The `WorkspaceProvider` is responsible for provisioning creds with minimum scope; the adapter does not touch creds itself.
- **Tool policy is plumbing.** The substrate's `toolPolicy.disallowedTools` is forwarded to the CLI via `--disallowedTools`. The CLI does the actual blocking; tool denials surface as `tool_use_result` with `is_error: true` in the stream and become `tool_calls[].outcome: 'policy-refused'` in the atom (via the adapter's classifier).
- **Redaction is mandatory at write time.** Every payload (turn output, tool args, tool result) goes through `input.redactor.redact()` BEFORE atom write or BlobStore put. A redactor crash is a substrate violation: rethrow as `kind: 'error'` with `failure: catastrophic`. Never write unredacted content.
- **Commit SHA is unverified.** The executor (PR2) already documents that the adapter-supplied `commitSha` is unverified by the executor; that downstream check is its responsibility, not the adapter's.
- **Stream-JSON parser is defensive.** Malformed lines are logged + skipped, never thrown. The CLI may emit non-JSON output during initialization (warnings, stderr-redirected messages); the parser tolerates it.
- **No prompt-injection countermeasures.** A malicious `task.questionPrompt` could attempt to instruct the agent to exfil. Substrate-level threat: not the adapter's job. The redactor catches secret-shaped exfil at write time; the workspace boundary catches FS exfil; tool-policy catches tool exfil. Defense is layered.
- **Argv injection.** All argv values are passed via execa as separate array elements, never shell-interpolated. Tool names and `disallowedTools` are joined with `' '` (the CLI's documented separator) but never shell-escaped because execa doesn't run a shell.

### 7.2 Pre-push checklist parity

Per `feedback_pre_push_grep_checklist`: the implementer runs `grep -rP $'\u2014' src/ test/ docs/ examples/ README.md` + private-term + design-link checks before every push.

### 7.3 Per-task security walkthrough

Per `feedback_security_correctness_at_write_time`: every plan task carries a "Security + correctness considerations" subsection that the implementer subagent walks through BEFORE writing code, not after CR flags it.

---

## 8. Testing

### 8.1 Unit tests (`test/examples/claude-code-agent-loop.test.ts`)

- `StreamJsonParser` round-trips synthetic NDJSON: system + assistant-text + assistant-tool_use + user-tool_result + result envelope. Asserts event ordering + payload shapes.
- `StreamJsonParser` tolerates malformed lines: feed `{"valid": 1}\nGARBAGE\n{"valid": 2}\n`; assert two events emitted, parse-error logged once.
- `buildPromptText` produces expected format for: prompt-only, prompt+files, prompt+files+criteria+target-paths.
- `captureArtifacts` returns `{commitSha, branchName, touchedPaths}` after a real `git init` / `commit` cycle in a tmp dir; returns `undefined` when `HEAD === baseRef`.
- `classifyClaudeCliFailure` covers the table cells in §6.

### 8.2 Adapter-with-stub tests (`test/examples/claude-code-agent-loop-adapter.test.ts`)

Use `execImpl` stub to feed canned NDJSON. Assert:
- `agent-session` atom written on entry; `terminal_state` updated on exit.
- One `agent-turn` atom per assistant text event.
- `tool_calls` populated correctly across tool_use → tool_result pairs.
- Large payloads (over `blobThreshold`) routed through `blobStore.put()`.
- Budget cap (`max_turns`) terminates the run with `kind: 'budget-exhausted'`.
- `AbortSignal` causes `kind: 'aborted'` with `failure: catastrophic`.
- All payloads went through `redactor.redact()` (assert by counting redactor calls).

### 8.3 Real-process integration test (opt-in)

Behind `process.env.CLAUDE_CODE_INTEGRATION_TEST` (skipped by default), runs `claude -p "echo hello"` actually; asserts the stream-json parser round-trips real output without surprises. Operator opts in locally; CI does not run this (no Claude OAuth in CI).

### 8.4 End-to-end on `MemoryHost`

Extend `test/e2e/agentic-actor-loop-chain.test.ts` with one test that uses the real adapter (with `execImpl` stub) instead of the inline `stubAdapter()`. Validates the full chain: plan → AgenticCodeAuthorExecutor → real adapter (stubbed CLI) → atoms in MemoryHost → session-tree projection → dispatched PR result.

---

## 9. Phasing

Single PR. The work decomposes into ~10 plan tasks (parser, prompt builder, classifier, artifact capture, spawn wrapper, adapter shell, blob threshold integration, budget guards, signal handling, end-to-end test) but they're cohesive enough to land together. The skeleton removal is part of the same PR.

---

## 10. Provenance

**Canon directives this design respects:**
- `dev-substrate-not-prescription`: the adapter lives in `examples/`; framework code in `src/` stays mechanism-only.
- `simple-surface-deep-architecture`: the adapter is one file; the substrate's pluggability is unchanged.
- `dev-flag-structural-concerns-proactively`: §4.1 documents the deliberate deviation from the strictest reading of "write atom before LLM call" and the reasoning.
- `inv-provenance-every-write`: every atom carries `derived_from` linking session → turn → atoms.
- `inv-governance-before-autonomy`: budget caps + signal forwarding + tool-policy plumbing all enforce caller-controlled bounds.
- `dev-extreme-rigor-and-research`: this design covers 6 stream-json event types, 9 failure-mapping rows, and 4 test categories.
- `dev-no-hacks-without-approval`: §4.1's deviation from strict atom-before-LLM-call is surfaced explicitly with rationale.
- `dev-forward-thinking-no-regrets`: strict replay tier is reserved (computed-at-session-start hash) without breaking content-addressed today.

**Atoms / memory / prior PRs:**
- PRs #166 (substrate foundations) + #167 (AgenticCodeAuthorExecutor) shipped the seam this adapter consumes.
- `project_pr2_agentic_code_author_executor_landed.md`  --  out-of-scope list explicitly named "real Claude Code CLI subprocess integration" as the next thing.
- `feedback_security_correctness_at_write_time.md`  --  every plan task gets a security walkthrough up front.
- `feedback_cr_recurring_pattern_presubmit_checklist.md`  --  pre-push grep + JSDoc parity checks before every push.

**Existing CLI integrations this builds on (NOT replaces):**
- `src/adapters/claude-cli/llm.ts`  --  single-shot judge surface; STAYS for drafter / planner.
- `src/integrations/agent-sdk/cli-client.ts`  --  single-shot deliberation client; STAYS for virtual-org bootstrap.
- This PR adds a third CLI integration purpose-built for streaming agentic mode. The three coexist; each has a distinct invocation pattern (json envelope vs json envelope vs stream-json).

---

## 11. What breaks if we revisit

- **Stream-json schema change in the CLI** would require parser updates. Risk: low; the format is documented and stable.
- **CLI removes `--max-budget-usd` or renames `--disallowedTools`** would break the budget / tool-policy plumbing. The adapter-side guards still terminate the run; the loss is the CLI-side enforcement of those caps. Acceptable degradation.
- **CLI adds `--max-turns`** would let us simplify (drop adapter-side turn counting). Strictly an improvement.
- **A future strict-replay-tier implementation** would add canon-snapshot hashing at session start. Additive; non-breaking.
