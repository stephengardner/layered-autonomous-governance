/**
 * LLM factory for the virtual-org example.
 *
 * Wraps the Claude CLI LLM adapter so the example's boot path can
 * construct an `LLM`-shaped object without hard-coding the adapter in
 * boot.mjs. The operator's existing Claude Code OAuth authenticates
 * the subprocess; no API key is required.
 *
 * Model selection is per-call (`LlmOptions.model`), not construction;
 * this factory takes only transport-shaping options (`claudePath`,
 * `execImpl`, `verbose`) and defers model picking to the caller's
 * `.judge()` invocation.
 */

import type { execa } from 'execa';

import { ClaudeCliLLM } from '../../adapters/claude-cli/llm.js';
import type { LLM } from '../../substrate/interface.js';

export interface CreateVirtualOrgLLMOptions {
  /** Path to the `claude` binary. Defaults to resolving via PATH. */
  readonly claudePath?: string;
  /**
   * Subprocess shim forwarded to the adapter. Tests stub this to avoid
   * spawning a real process; production leaves it unset so the real
   * execa is used.
   */
  readonly execImpl?: typeof execa;
  /** Emit the spawn command to stderr for debugging. */
  readonly verbose?: boolean;
}

export function createVirtualOrgLLM(
  opts: CreateVirtualOrgLLMOptions = {},
): LLM {
  return new ClaudeCliLLM({
    ...(opts.claudePath !== undefined ? { claudePath: opts.claudePath } : {}),
    ...(opts.execImpl !== undefined ? { execImpl: opts.execImpl } : {}),
    ...(opts.verbose !== undefined ? { verbose: opts.verbose } : {}),
  });
}
