import { env } from 'cloudflare:workers';
import { z } from 'zod';

import { defaultGraderRegistry } from './graders';
import {
  applyContextPolicy,
  calculateHarnessMetrics,
  type HarnessArtifact,
  type HarnessCaseResult,
} from './harness-dev';
import { createGraphCheckpoint, executeGraph } from './graph';
import { executeAgent } from './runtime';
import { loadRuntimePolicy } from './runtime-policy';
import { getAgent } from './server-data';

export const executorConfigSchema = z
  .object({
    label: z.string().trim().min(1).max(100),
    provider: z.enum(['mock', 'openai']),
    model: z.string().trim().min(1).max(100),
    temperature: z.number().min(0).max(2).default(0.2),
  })
  .strict();

export type ExecutorConfig = z.infer<typeof executorConfigSchema>;

export type RunnableHarnessCase = {
  id: string;
  benchmark: string;
  input: string;
  expected: Record<string, unknown>;
  graderType: string;
};

export async function executeHarnessEvaluation(input: {
  artifact: HarnessArtifact;
  cases: readonly RunnableHarnessCase[];
  executor: ExecutorConfig;
}) {
  const results: HarnessCaseResult[] = [];
  for (const testCase of input.cases) {
    results.push(
      await executeHarnessCase(input.artifact, testCase, input.executor),
    );
  }
  return { results, metrics: calculateHarnessMetrics(results) };
}

async function executeHarnessCase(
  artifact: HarnessArtifact,
  testCase: RunnableHarnessCase,
  executor: ExecutorConfig,
): Promise<HarnessCaseResult> {
  if (artifact.execution.mode === 'seed') {
    return {
      caseId: testCase.id,
      benchmark: testCase.benchmark,
      nativeScore: 0,
      passed: false,
      executorInputTokens: 0,
      executorOutputTokens: 0,
      status: 'failed',
    };
  }

  let inputTokens = 0;
  let outputTokens = 0;
  let toolCalls = 0;
  const startedAt = Date.now();
  const checkpoint = createGraphCheckpoint(
    artifact.execution.graph,
    applyContextPolicy(testCase.input, artifact),
  );
  const graphResult = await executeGraph({
    definition: artifact.execution.graph,
    checkpoint,
    executeAgentNode: async (node, prompt) => {
      if (Date.now() - startedAt >= artifact.lifecycle.deadlineMs) {
        return {
          status: 'failed',
          output: 'Harness lifecycle deadline exceeded.',
        };
      }
      const configured = await getAgent(node.agentId, node.agentVersionId);
      if (!configured)
        return {
          status: 'failed',
          output: 'Pinned agent version is unavailable.',
        };
      const agent = {
        ...configured,
        provider: executor.provider,
        model: executor.model,
        temperature: executor.temperature,
        allowedTools: configured.allowedTools.filter((tool) =>
          artifact.tools.allowed.includes(tool),
        ),
      };
      const invoke = async () => {
        const basePolicy = loadRuntimePolicy(
          env as unknown as Record<string, unknown>,
        );
        const result = await executeAgent(agent, prompt, {
          policy: {
            ...basePolicy,
            budget: {
              ...basePolicy.budget,
              maxTurns: Math.min(
                basePolicy.budget.maxTurns,
                artifact.context.maxMessages,
              ),
              maxToolCalls: Math.max(0, artifact.tools.maxCalls - toolCalls),
              maxDurationMs: Math.min(
                basePolicy.budget.maxDurationMs,
                artifact.lifecycle.deadlineMs,
              ),
            },
          },
        });
        inputTokens += result.inputTokens;
        outputTokens += result.outputTokens;
        toolCalls += result.steps.filter((step) => step.kind === 'tool').length;
        return result;
      };
      let result = await invoke();
      let retries = 0;
      while (
        result.status === 'failed' &&
        artifact.lifecycle.onFailure !== 'fail' &&
        retries < artifact.lifecycle.maxRetries
      ) {
        retries += 1;
        result = await invoke();
      }
      if (toolCalls > artifact.tools.maxCalls) {
        return {
          status: 'failed',
          output: 'Harness tool-call budget exceeded.',
        };
      }
      return {
        status: result.status,
        output: result.output,
      };
    },
  });
  const output = graphResult.lastResult?.output ?? '';
  const grade =
    graphResult.status === 'completed'
      ? await defaultGraderRegistry.grade(testCase.graderType, {
          output,
          expected: testCase.expected,
        })
      : { passed: false, score: 0 };
  return {
    caseId: testCase.id,
    benchmark: testCase.benchmark,
    nativeScore: Math.round(grade.score * 100_000) / 1_000,
    passed: grade.passed,
    executorInputTokens: inputTokens,
    executorOutputTokens: outputTokens,
    status: graphResult.status === 'completed' ? 'completed' : 'failed',
  };
}
