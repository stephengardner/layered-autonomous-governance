/**
 * Claude CLI adapter entry point.
 *
 * Currently exposes only the LLM adapter. Later phases may add a full Host
 * composition factory that pairs this LLM with real external atom storage,
 * git-backed canon, etc. For now: `createMemoryHost()` for everything else
 * plus this LLM for the `llm` slot.
 */

export { ClaudeCliLLM, type ClaudeCliOptions } from './llm.js';

// Also re-export the Claude CLI invocation utility. It was previously
// inside src/daemon/ but is vendor-specific to Claude CLI, so it belongs
// with the rest of the Claude CLI adapter.
export { invokeClaude } from './invoke.js';
export type { InvokeClaudeOptions, InvokeClaudeResult } from './invoke.js';
