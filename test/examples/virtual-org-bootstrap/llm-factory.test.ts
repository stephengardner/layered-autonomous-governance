/**
 * LLM factory composition tests.
 *
 * `createVirtualOrgLLM` wraps `ClaudeCliLLM` so the example's boot path
 * picks up the subprocess-backed adapter without an ANTHROPIC_API_KEY.
 * These tests pin the returned surface (the `LLM` contract's sole
 * method is `.judge`) and confirm a caller-supplied `claudePath` lands
 * on the adapter so operators can point at a non-default binary.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  createVirtualOrgLLM,
} from '../../../src/examples/virtual-org-bootstrap/llm-factory.js';

describe('createVirtualOrgLLM', () => {
  it('returns an object satisfying the LLM.judge surface', () => {
    const llm = createVirtualOrgLLM();
    expect(llm).toBeDefined();
    expect(typeof llm.judge).toBe('function');
  });

  it('routes LlmOptions.model + max_budget_usd through to the spawn args', async () => {
    // Stub execImpl so no real subprocess runs; it records the args
    // and synthesizes the envelope shape ClaudeCliLLM expects.
    const execImpl = vi.fn(async (_binary: string, args: readonly string[]) => {
      const envelope = {
        type: 'result',
        subtype: 'success',
        structured_output: { ok: true },
        total_cost_usd: 0,
        usage: { input_tokens: 1, output_tokens: 1 },
        is_error: false,
      };
      return {
        stdout: JSON.stringify(envelope),
        stderr: '',
        exitCode: 0,
        // Echo back the args the adapter handed us so the assertion
        // below can check --model / --max-budget-usd landed.
        _args: args,
      };
    });

    const llm = createVirtualOrgLLM({ execImpl: execImpl as never });

    const result = await llm.judge(
      { type: 'object' },
      'system prompt',
      { hello: 'world' },
      { model: 'claude-opus-4-7', max_budget_usd: 0.25 },
    );

    expect(result.output).toEqual({ ok: true });
    expect(execImpl).toHaveBeenCalledTimes(1);
    const args = execImpl.mock.calls[0]![1] as readonly string[];
    const modelIdx = args.indexOf('--model');
    expect(modelIdx).toBeGreaterThanOrEqual(0);
    expect(args[modelIdx + 1]).toBe('claude-opus-4-7');
    const budgetIdx = args.indexOf('--max-budget-usd');
    expect(budgetIdx).toBeGreaterThanOrEqual(0);
    expect(args[budgetIdx + 1]).toBe('0.25');
  });

  it('respects caller-supplied claudePath (non-default binary location)', async () => {
    const execImpl = vi.fn(async () => ({
      stdout: JSON.stringify({ type: 'result', structured_output: {} }),
      stderr: '',
      exitCode: 0,
    }));

    const llm = createVirtualOrgLLM({
      claudePath: '/opt/custom/claude',
      execImpl: execImpl as never,
    });

    await llm.judge(
      { type: 'object' },
      'sys',
      {},
      { model: 'claude-opus-4-7', max_budget_usd: 0.1 },
    );

    expect(execImpl.mock.calls[0]![0]).toBe('/opt/custom/claude');
  });
});
