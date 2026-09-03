import { z } from 'zod';

const positiveInteger = (fallback: number, maximum: number) =>
  z.coerce.number().int().positive().max(maximum).default(fallback);

const runtimeEnvironmentSchema = z.object({
  RELAY_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  OPENAI_API_KEY: z.string().trim().min(1).optional(),
  OPENAI_BASE_URL: z.url().default('https://api.openai.com/v1'),
  RELAY_MODEL_TIMEOUT_MS: positiveInteger(30_000, 120_000),
  RELAY_MODEL_MAX_RESPONSE_BYTES: positiveInteger(1_048_576, 10_485_760),
  RELAY_MODEL_MAX_ATTEMPTS: positiveInteger(3, 5),
  RELAY_RUN_MAX_TURNS: positiveInteger(4, 32),
  RELAY_RUN_MAX_TOOL_CALLS: positiveInteger(12, 128),
  RELAY_RUN_MAX_INPUT_TOKENS: positiveInteger(100_000, 2_000_000),
  RELAY_RUN_MAX_OUTPUT_TOKENS: positiveInteger(16_000, 200_000),
  RELAY_RUN_MAX_COST_USD: z.coerce.number().positive().max(100).default(1),
  RELAY_RUN_MAX_DURATION_MS: positiveInteger(120_000, 900_000),
  RELAY_RUN_MAX_CONTEXT_BYTES: positiveInteger(524_288, 8_388_608),
  RELAY_RUN_MAX_TOOL_RESULT_BYTES: positiveInteger(65_536, 1_048_576),
});

export type RuntimePolicy = {
  environment: 'development' | 'test' | 'production';
  openAi: {
    apiKey?: string;
    baseUrl: string;
    timeoutMs: number;
    maxResponseBytes: number;
    maxAttempts: number;
  };
  budget: ExecutionBudget;
};

export type ExecutionBudget = {
  maxTurns: number;
  maxToolCalls: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  maxCostUsd: number;
  maxDurationMs: number;
  maxContextBytes: number;
  maxToolResultBytes: number;
};

export function loadRuntimePolicy(
  source: Record<string, unknown>,
): RuntimePolicy {
  const parsed = runtimeEnvironmentSchema.safeParse(source);
  if (!parsed.success) {
    throw new Error(
      `Invalid runtime configuration: ${z.prettifyError(parsed.error)}`,
    );
  }
  const value = parsed.data;
  const baseUrl = new URL(value.OPENAI_BASE_URL);
  if (value.RELAY_ENV === 'production' && baseUrl.protocol !== 'https:') {
    throw new Error(
      'Invalid runtime configuration: OPENAI_BASE_URL must use HTTPS in production.',
    );
  }
  return {
    environment: value.RELAY_ENV,
    openAi: {
      apiKey: value.OPENAI_API_KEY,
      baseUrl: value.OPENAI_BASE_URL.replace(/\/$/, ''),
      timeoutMs: value.RELAY_MODEL_TIMEOUT_MS,
      maxResponseBytes: value.RELAY_MODEL_MAX_RESPONSE_BYTES,
      maxAttempts: value.RELAY_MODEL_MAX_ATTEMPTS,
    },
    budget: {
      maxTurns: value.RELAY_RUN_MAX_TURNS,
      maxToolCalls: value.RELAY_RUN_MAX_TOOL_CALLS,
      maxInputTokens: value.RELAY_RUN_MAX_INPUT_TOKENS,
      maxOutputTokens: value.RELAY_RUN_MAX_OUTPUT_TOKENS,
      maxCostUsd: value.RELAY_RUN_MAX_COST_USD,
      maxDurationMs: value.RELAY_RUN_MAX_DURATION_MS,
      maxContextBytes: value.RELAY_RUN_MAX_CONTEXT_BYTES,
      maxToolResultBytes: value.RELAY_RUN_MAX_TOOL_RESULT_BYTES,
    },
  };
}

export class RuntimeLimitError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'RuntimeLimitError';
  }
}

export class ExecutionBudgetTracker {
  private readonly startedAt: number;
  private toolCalls: number;
  private inputTokens: number;
  private outputTokens: number;
  private estimatedCostUsd: number;

  constructor(
    private readonly budget: ExecutionBudget,
    private readonly now: () => number = Date.now,
    initial: {
      startedAt?: number;
      toolCalls?: number;
      inputTokens?: number;
      outputTokens?: number;
      estimatedCostUsd?: number;
    } = {},
  ) {
    this.startedAt = initial.startedAt ?? now();
    this.toolCalls = initial.toolCalls ?? 0;
    this.inputTokens = initial.inputTokens ?? 0;
    this.outputTokens = initial.outputTokens ?? 0;
    this.estimatedCostUsd = initial.estimatedCostUsd ?? 0;
  }

  beforeTurn(turn: number): void {
    this.assertDuration();
    if (turn >= this.budget.maxTurns) {
      throw new RuntimeLimitError(
        'max_turns',
        `Agent exceeded the ${this.budget.maxTurns}-turn execution limit.`,
      );
    }
  }

  recordModelUsage(
    inputTokens: number,
    outputTokens: number,
    estimatedCostUsd: number,
  ): void {
    this.inputTokens += Math.max(0, inputTokens);
    this.outputTokens += Math.max(0, outputTokens);
    this.estimatedCostUsd += Math.max(0, estimatedCostUsd);
    if (this.inputTokens > this.budget.maxInputTokens) {
      throw new RuntimeLimitError(
        'max_input_tokens',
        'Agent exceeded the input-token budget.',
      );
    }
    if (this.outputTokens > this.budget.maxOutputTokens) {
      throw new RuntimeLimitError(
        'max_output_tokens',
        'Agent exceeded the output-token budget.',
      );
    }
    if (this.estimatedCostUsd > this.budget.maxCostUsd) {
      throw new RuntimeLimitError(
        'max_cost',
        'Agent exceeded the estimated-cost budget.',
      );
    }
    this.assertDuration();
  }

  recordToolCall(): void {
    this.toolCalls += 1;
    if (this.toolCalls > this.budget.maxToolCalls) {
      throw new RuntimeLimitError(
        'max_tool_calls',
        'Agent exceeded the tool-call budget.',
      );
    }
    this.assertDuration();
  }

  assertDuration(): void {
    if (this.now() - this.startedAt > this.budget.maxDurationMs) {
      throw new RuntimeLimitError(
        'max_duration',
        'Agent exceeded the total execution deadline.',
      );
    }
  }
}
