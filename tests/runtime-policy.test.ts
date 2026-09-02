import { describe, expect, it } from 'vitest';

import {
  ExecutionBudgetTracker,
  RuntimeLimitError,
  loadRuntimePolicy,
  type ExecutionBudget,
} from '../lib/runtime-policy';

const budget: ExecutionBudget = {
  maxTurns: 2,
  maxToolCalls: 2,
  maxInputTokens: 100,
  maxOutputTokens: 50,
  maxCostUsd: 0.25,
  maxDurationMs: 1_000,
};

describe('runtime configuration', () => {
  it('loads bounded defaults and coerces deployment strings', () => {
    const policy = loadRuntimePolicy({
      RELAY_RUN_MAX_TURNS: '7',
      RELAY_RUN_MAX_COST_USD: '0.5',
    });
    expect(policy.budget.maxTurns).toBe(7);
    expect(policy.budget.maxCostUsd).toBe(0.5);
    expect(policy.openAi.timeoutMs).toBe(30_000);
  });

  it('rejects insecure production provider URLs', () => {
    expect(() =>
      loadRuntimePolicy({
        RELAY_ENV: 'production',
        OPENAI_BASE_URL: 'http://provider.internal/v1',
      }),
    ).toThrow(/must use HTTPS/);
  });

  it.each([
    ['RELAY_MODEL_MAX_ATTEMPTS', '0'],
    ['RELAY_RUN_MAX_TURNS', '1000'],
    ['RELAY_RUN_MAX_COST_USD', '-1'],
  ])('rejects invalid bound %s=%s', (name, value) => {
    expect(() => loadRuntimePolicy({ [name]: value })).toThrow(
      /Invalid runtime configuration/,
    );
  });
});

describe('execution budgets', () => {
  it('enforces model-turn and tool-call ceilings', () => {
    const tracker = new ExecutionBudgetTracker(budget);
    tracker.beforeTurn(0);
    tracker.beforeTurn(1);
    expect(() => tracker.beforeTurn(2)).toThrow(
      expect.objectContaining({ code: 'max_turns' }),
    );

    tracker.recordToolCall();
    tracker.recordToolCall();
    expect(() => tracker.recordToolCall()).toThrow(
      expect.objectContaining({ code: 'max_tool_calls' }),
    );
  });

  it.each([
    [101, 0, 0, 'max_input_tokens'],
    [0, 51, 0, 'max_output_tokens'],
    [0, 0, 0.26, 'max_cost'],
  ] as const)('enforces usage limit %s/%s/%s', (input, output, cost, code) => {
    const tracker = new ExecutionBudgetTracker(budget);
    expect(() => tracker.recordModelUsage(input, output, cost)).toThrow(
      expect.objectContaining({ code }),
    );
  });

  it('enforces a total wall-clock deadline', () => {
    let now = 10_000;
    const tracker = new ExecutionBudgetTracker(budget, () => now);
    now += 1_001;
    expect(() => tracker.assertDuration()).toThrow(RuntimeLimitError);
    expect(() => tracker.assertDuration()).toThrow(/total execution deadline/);
  });
});
