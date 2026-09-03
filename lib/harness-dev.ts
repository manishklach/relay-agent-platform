import { z } from 'zod';

import { graphDefinitionSchema } from './graph';

const idSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,127}$/);

const executionModuleSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('seed') }).strict(),
  z
    .object({
      mode: z.literal('graph'),
      graph: graphDefinitionSchema,
    })
    .strict(),
]);

export const harnessArtifactSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.enum(['seed', 'developed']),
    execution: executionModuleSchema,
    tools: z
      .object({
        allowed: z.array(z.string().min(1)).max(50),
        maxCalls: z.number().int().min(0).max(200),
        denyUnknown: z.literal(true),
      })
      .strict(),
    context: z
      .object({
        strategy: z.enum(['full', 'sliding_window', 'summary']),
        maxBytes: z.number().int().min(1_024).max(2_000_000),
        maxMessages: z.number().int().min(1).max(1_000),
      })
      .strict(),
    state: z
      .object({
        checkpoint: z.literal('each_step'),
        retainTrajectory: z.literal(true),
      })
      .strict(),
    lifecycle: z
      .object({
        maxSteps: z.number().int().min(1).max(500),
        maxRetries: z.number().int().min(0).max(10),
        deadlineMs: z.number().int().min(1_000).max(36_000_000),
        onFailure: z.enum(['fail', 'retry', 'recover']),
      })
      .strict(),
    verification: z
      .object({
        suiteIds: z.array(idSchema).min(1).max(20),
        artifactType: z.enum(['text', 'json', 'repository', 'environment']),
        recordTrajectory: z.literal(true),
      })
      .strict(),
    constraints: z
      .object({
        providerNeutral: z.literal(true),
        prohibitInstanceSpecificLogic: z.literal(true),
      })
      .strict(),
  })
  .strict()
  .superRefine((artifact, context) => {
    if (artifact.kind === 'seed' && artifact.execution.mode !== 'seed') {
      context.addIssue({
        code: 'custom',
        message: 'A seed artifact must use seed execution.',
      });
    }
    if (artifact.kind === 'developed' && artifact.execution.mode !== 'graph') {
      context.addIssue({
        code: 'custom',
        message: 'A developed artifact requires graph execution.',
      });
    }
    if (
      artifact.execution.mode === 'graph' &&
      artifact.execution.graph.maxSteps > artifact.lifecycle.maxSteps
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Graph maxSteps cannot exceed the harness lifecycle budget.',
      });
    }
  });

export type HarnessArtifact = z.infer<typeof harnessArtifactSchema>;

export const harnessProjectInputSchema = z
  .object({
    name: z.string().trim().min(2).max(100),
    description: z.string().trim().min(10).max(1_000),
    domain: z.enum(['code', 'data', 'writing', 'research', 'custom']),
    creatorAgentVersionId: z.string().min(1),
    officialCandidateBudget: z.number().int().min(1).max(10).default(10),
    probeBudgetPerRound: z.number().int().min(0).max(2).default(2),
  })
  .strict();

export const harnessCaseInputSchema = z
  .object({
    externalId: idSchema.optional(),
    name: z.string().trim().min(2).max(160),
    split: z.enum(['development', 'feedback', 'heldout']),
    benchmark: z.string().trim().min(1).max(100),
    input: z.string().min(1).max(100_000),
    expected: z.record(z.string(), z.unknown()),
    graderType: z.string().regex(/^[a-z][a-z0-9_]*$/),
  })
  .strict();

export type HarnessCaseInput = z.infer<typeof harnessCaseInputSchema>;

export type ConstraintAudit = {
  compliant: boolean;
  violations: string[];
};

export function auditHarnessArtifact(
  artifact: unknown,
  forbiddenIdentifiers: readonly string[],
): ConstraintAudit {
  const parsed = harnessArtifactSchema.safeParse(artifact);
  if (!parsed.success) {
    return { compliant: false, violations: ['artifact_schema_invalid'] };
  }
  const serialized = JSON.stringify(parsed.data).toLowerCase();
  const leaked = forbiddenIdentifiers
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value.length >= 3 && serialized.includes(value));
  return {
    compliant: leaked.length === 0,
    violations: leaked.map((value) => `instance_identifier:${value}`),
  };
}

export type HarnessCaseResult = {
  caseId: string;
  benchmark: string;
  nativeScore: number;
  passed: boolean;
  executorInputTokens: number;
  executorOutputTokens: number;
  status: 'completed' | 'failed';
};

export type HarnessMetrics = {
  taskCount: number;
  completedCount: number;
  passedCount: number;
  capabilityScore: number;
  executorTokensTotal: number;
  executorTokensMean: number;
  benchmarks: Record<
    string,
    { taskCount: number; capabilityScore: number; executorTokens: number }
  >;
};

export function calculateHarnessMetrics(
  results: readonly HarnessCaseResult[],
): HarnessMetrics {
  const completed = results.filter((result) => result.status === 'completed');
  const totalTokens = results.reduce(
    (sum, result) =>
      sum + result.executorInputTokens + result.executorOutputTokens,
    0,
  );
  const groups = new Map<string, HarnessCaseResult[]>();
  for (const result of results) {
    groups.set(result.benchmark, [
      ...(groups.get(result.benchmark) ?? []),
      result,
    ]);
  }
  const benchmarks = Object.fromEntries(
    [...groups.entries()].map(([benchmark, items]) => [
      benchmark,
      {
        taskCount: items.length,
        capabilityScore: mean(items.map((item) => item.nativeScore)),
        executorTokens: items.reduce(
          (sum, item) =>
            sum + item.executorInputTokens + item.executorOutputTokens,
          0,
        ),
      },
    ]),
  );
  return {
    taskCount: results.length,
    completedCount: completed.length,
    passedCount: results.filter((result) => result.passed).length,
    capabilityScore: mean(results.map((result) => result.nativeScore)),
    executorTokensTotal: totalTokens,
    executorTokensMean: results.length ? totalTokens / results.length : 0,
    benchmarks,
  };
}

export type EvolutionCandidateEvaluation = {
  harnessVersionId: string;
  completeBenchmarks: string[];
  requiredBenchmarks: string[];
  constraintCompliant: boolean;
  capabilityScore: number;
  executorTokensMean: number;
};

export function assertOfficialCandidate(
  input: EvolutionCandidateEvaluation,
): void {
  if (!input.constraintCompliant)
    throw new Error('Candidate failed the constraint audit.');
  const completed = new Set(input.completeBenchmarks);
  const missing = input.requiredBenchmarks.filter(
    (benchmark) => !completed.has(benchmark),
  );
  if (missing.length > 0) {
    throw new Error(
      `Candidate is missing complete feedback evaluations: ${missing.join(', ')}`,
    );
  }
}

export function createWeakSeed(suiteIds: readonly string[]): HarnessArtifact {
  return harnessArtifactSchema.parse({
    schemaVersion: 1,
    kind: 'seed',
    execution: { mode: 'seed' },
    tools: { allowed: [], maxCalls: 0, denyUnknown: true },
    context: { strategy: 'full', maxBytes: 1_024, maxMessages: 1 },
    state: { checkpoint: 'each_step', retainTrajectory: true },
    lifecycle: {
      maxSteps: 1,
      maxRetries: 0,
      deadlineMs: 1_000,
      onFailure: 'fail',
    },
    verification: {
      suiteIds: [...suiteIds],
      artifactType: 'text',
      recordTrajectory: true,
    },
    constraints: { providerNeutral: true, prohibitInstanceSpecificLogic: true },
  });
}

export function applyContextPolicy(
  input: string,
  artifact: HarnessArtifact,
): string {
  const bytes = new TextEncoder().encode(input);
  if (bytes.length <= artifact.context.maxBytes) return input;
  if (artifact.context.strategy === 'full') {
    throw new Error('Harness input exceeds the full-context byte budget.');
  }
  if (artifact.context.strategy === 'sliding_window') {
    return decodeWithinBudget(bytes, artifact.context.maxBytes, true);
  }
  const marker = '\n...[compressed]...\n';
  const remaining =
    artifact.context.maxBytes - new TextEncoder().encode(marker).length;
  const head = Math.floor(remaining / 2);
  const tail = remaining - head;
  return `${decodeWithinBudget(bytes, head, false)}${marker}${decodeWithinBudget(bytes, tail, true)}`;
}

function decodeWithinBudget(
  bytes: Uint8Array,
  budget: number,
  fromEnd: boolean,
): string {
  const decoder = new TextDecoder('utf-8', { fatal: false });
  const encoder = new TextEncoder();
  let value = decoder.decode(
    fromEnd ? bytes.slice(-budget) : bytes.slice(0, budget),
  );
  while (encoder.encode(value).length > budget) {
    const points = Array.from(value);
    value = (fromEnd ? points.slice(1) : points.slice(0, -1)).join('');
  }
  return value;
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return (
    Math.round(
      (values.reduce((sum, value) => sum + value, 0) / values.length) * 1_000,
    ) / 1_000
  );
}
