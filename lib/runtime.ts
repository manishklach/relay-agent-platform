import { env } from 'cloudflare:workers';

import {
  inspectInput,
  inspectModelOutput,
  inspectToolOutput,
  sanitizeOutput,
} from './guardrails';
import {
  OpenAICompatibleProvider,
  ProviderRegistry,
  type ModelProvider,
} from './providers';
import {
  ExecutionBudgetTracker,
  loadRuntimePolicy,
  type RuntimePolicy,
} from './runtime-policy';
import {
  advanceToModel,
  assertContextWithinLimit,
  boundToolResult,
  createModelCheckpoint,
  parseModelCheckpoint,
  type ModelRuntimeCheckpoint,
} from './runtime-checkpoint';
import { getAllowedTool } from './tool-policy';
import {
  executeRuntimeTool,
  executeTool,
  loadRuntimeTools,
  toolCatalog,
  type ToolDefinition,
} from './tools';
import type { AgentConfig, RuntimeResult, RuntimeStep } from './types';

export type RuntimeDependencies = {
  policy?: RuntimePolicy;
  providers?: ProviderRegistry;
  runId?: string;
  checkpoint?: ModelRuntimeCheckpoint;
  tools?: ToolDefinition[];
  onProgress?: (progress: {
    checkpoint: ModelRuntimeCheckpoint;
    steps: readonly RuntimeStep[];
  }) => Promise<void>;
};

export class RuntimePersistenceError extends Error {
  constructor(cause: unknown) {
    super('Failed to persist resumable runtime progress.', { cause });
    this.name = 'RuntimePersistenceError';
  }
}

export async function executeAgent(
  agent: AgentConfig,
  input: string,
  dependencies: RuntimeDependencies = {},
): Promise<RuntimeResult> {
  const inspected = inspectInput(input, agent);
  if (inspected.blocked) {
    return {
      status: 'succeeded',
      output: inspected.message ?? 'Request blocked by policy.',
      steps: inspected.step ? [inspected.step] : [],
      inputTokens: estimateTokens(input),
      outputTokens: estimateTokens(inspected.message ?? ''),
      estimatedCostUsd: 0,
    };
  }

  try {
    const policy =
      dependencies.policy ??
      loadRuntimePolicy(env as unknown as Record<string, unknown>);
    if (agent.provider === 'mock') {
      return await executeMockAgent(agent, input, policy);
    }
    const providers =
      dependencies.providers ??
      new ProviderRegistry([new OpenAICompatibleProvider(policy.openAi)]);
    return executeModelAgent(
      agent,
      input,
      providers.resolve(agent.provider),
      policy,
      dependencies,
    );
  } catch (error) {
    return failedResult(input, error);
  }
}

async function executeMockAgent(
  agent: AgentConfig,
  input: string,
  policy: RuntimePolicy,
): Promise<RuntimeResult> {
  const steps: RuntimeStep[] = [];
  const started = Date.now();
  const budget = new ExecutionBudgetTracker(policy.budget);
  budget.beforeTurn(0);
  const orderId =
    input.match(/#?([A-Z]+-[A-Z0-9-]+)/i)?.[1]?.toUpperCase() ?? 'A-1042';

  if (!getAllowedTool('lookup_account', agent.allowedTools, toolCatalog)) {
    return blockedToolResult(agent, input, 'lookup_account', steps, started);
  }

  budget.recordToolCall();
  const accountStarted = Date.now();
  const account = await executeTool('lookup_account', { order_id: orderId });
  steps.push(
    step(
      0,
      'tool',
      'Account lookup',
      'succeeded',
      { order_id: orderId },
      account,
      Date.now() - accountStarted,
    ),
  );

  if (!account.found) {
    const output = `I could not verify order ${orderId}. Please check the order reference or ask an operator to locate the account.`;
    steps.push(
      step(
        1,
        'model',
        'Response synthesis',
        'succeeded',
        { model: agent.model },
        { characters: output.length },
        8,
      ),
    );
    return totals(agent, input, output, steps, started);
  }

  if (!getAllowedTool('lookup_policy', agent.allowedTools, toolCatalog)) {
    return blockedToolResult(agent, input, 'lookup_policy', steps, started);
  }
  budget.recordToolCall();
  const policyStarted = Date.now();
  const refundPolicy = await executeTool('lookup_policy', {
    query: 'refund eligibility',
  });
  steps.push(
    step(
      1,
      'tool',
      'Policy search',
      'succeeded',
      { query: 'refund eligibility' },
      refundPolicy,
      Date.now() - policyStarted,
    ),
  );

  const asksToExecute =
    /\b(issue|process|submit|send|do|go ahead)\b/i.test(input) &&
    /refund/i.test(input);
  if (
    asksToExecute &&
    agent.allowedTools.includes('issue_refund') &&
    agent.guardrails.requireApprovalForWrites
  ) {
    const args = {
      order_id: orderId,
      amount: account.amount,
      reason: 'Customer request',
    };
    steps.push(
      step(
        2,
        'approval',
        'Issue refund',
        'pending',
        args,
        { reason: 'mutating_tool' },
        1,
      ),
    );
    const output = `Order ${orderId} is eligible for a $${Number(account.amount ?? 0)} refund. I prepared the refund and sent it for operator approval.`;
    return {
      ...totals(agent, input, output, steps, started),
      status: 'waiting_approval',
      pendingApproval: { toolName: 'issue_refund', arguments: args },
    };
  }

  const output = `Order ${orderId} is eligible for a $${Number(account.amount ?? 0)} refund under the 30-day policy. If you want me to issue it, the action will be sent to an operator for approval.`;
  steps.push(
    step(
      2,
      'model',
      'Response synthesis',
      'succeeded',
      { model: agent.model },
      { characters: output.length },
      12,
    ),
  );
  return totals(agent, input, output, steps, started);
}

async function executeModelAgent(
  agent: AgentConfig,
  input: string,
  provider: ModelProvider,
  policy: RuntimePolicy,
  dependencies: RuntimeDependencies,
): Promise<RuntimeResult> {
  const steps: RuntimeStep[] = [];
  const runId = dependencies.runId ?? `ephemeral_${crypto.randomUUID()}`;
  const checkpoint = dependencies.checkpoint
    ? parseModelCheckpoint(dependencies.checkpoint)
    : createModelCheckpoint(runId, input);
  const budget = new ExecutionBudgetTracker(policy.budget, Date.now, {
    startedAt: checkpoint.startedAt,
    toolCalls: checkpoint.toolCalls,
    inputTokens: checkpoint.inputTokens,
    outputTokens: checkpoint.outputTokens,
    estimatedCostUsd: checkpoint.estimatedCostUsd,
  });
  const persist = async (value?: RuntimeStep | readonly RuntimeStep[]) => {
    try {
      const steps = value ? (Array.isArray(value) ? value : [value]) : [];
      await dependencies.onProgress?.({ checkpoint, steps });
    } catch (error) {
      throw new RuntimePersistenceError(error);
    }
  };

  try {
    const availableTools =
      dependencies.tools ??
      (await loadRuntimeTools(agent.workspaceId, agent.allowedTools));
    for (;;) {
      if (checkpoint.phase === 'model') {
        budget.beforeTurn(checkpoint.turn);
        assertContextWithinLimit(
          checkpoint.inputItems,
          policy.budget.maxContextBytes,
        );
        await persist();
        const modelStarted = Date.now();
        const response = await provider.createResponse({
          agent,
          input: checkpoint.inputItems,
          tools: availableTools,
          requestId: checkpoint.requestId,
        });
        const turnInputTokens =
          response.usage?.input_tokens ??
          estimateTokens(JSON.stringify(checkpoint.inputItems));
        const turnOutputTokens =
          response.usage?.output_tokens ??
          estimateTokens(
            JSON.stringify(response.output ?? response.output_text ?? ''),
          );
        const turnCost = estimateCost(turnInputTokens, turnOutputTokens);
        budget.recordModelUsage(turnInputTokens, turnOutputTokens, turnCost);
        checkpoint.inputTokens += turnInputTokens;
        checkpoint.outputTokens += turnOutputTokens;
        checkpoint.estimatedCostUsd = Number(
          (checkpoint.estimatedCostUsd + turnCost).toFixed(6),
        );
        const outputItems = response.output ?? [];
        const toolCalls = outputItems.filter(
          (item) => item.type === 'function_call' && item.name && item.call_id,
        );
        const responseText =
          response.output_text ||
          outputItems
            .filter((item) => item.type === 'message')
            .flatMap((item) => item.content ?? [])
            .filter((item) => item.type === 'output_text')
            .map((item) => item.text ?? '')
            .join('\n');
        const modelStep = step(
          checkpoint.nextSequence++,
          'model',
          'Model response',
          'succeeded',
          {
            model: agent.model,
            turn: checkpoint.turn,
            requestId: checkpoint.requestId,
          },
          { toolCalls: toolCalls.length, characters: responseText.length },
          Date.now() - modelStarted,
        );
        steps.push(modelStep);

        if (!toolCalls.length) {
          const inspectedOutput = inspectModelOutput(responseText, agent);
          if (inspectedOutput.step) {
            inspectedOutput.step.sequence = checkpoint.nextSequence++;
            steps.push(inspectedOutput.step);
          }
          const output = inspectedOutput.blocked
            ? (inspectedOutput.message ?? 'Model response blocked by policy.')
            : sanitizeOutput(responseText, agent);
          return {
            status: 'succeeded',
            output,
            steps,
            inputTokens: checkpoint.inputTokens || estimateTokens(input),
            outputTokens: checkpoint.outputTokens || estimateTokens(output),
            estimatedCostUsd: checkpoint.estimatedCostUsd,
          };
        }

        const nextInputItems = [...checkpoint.inputItems, ...outputItems];
        assertContextWithinLimit(nextInputItems, policy.budget.maxContextBytes);
        checkpoint.inputItems = nextInputItems;
        checkpoint.pendingCalls = toolCalls.map((call) => ({
          ...call,
          type: 'function_call' as const,
          call_id: call.call_id as string,
          name: call.name as string,
          arguments: call.arguments ?? '{}',
        }));
        checkpoint.toolIndex = 0;
        checkpoint.phase = 'tools';
        await persist(modelStep);
      }

      while (
        checkpoint.phase === 'tools' &&
        checkpoint.toolIndex < checkpoint.pendingCalls.length
      ) {
        const call = checkpoint.pendingCalls[checkpoint.toolIndex];
        budget.recordToolCall();
        checkpoint.toolCalls += 1;
        const toolName = call.name;
        const callId = call.call_id;
        const definition = getAllowedTool(
          toolName,
          agent.allowedTools,
          availableTools,
        );
        if (!definition) {
          checkpoint.inputItems.push({
            type: 'function_call_output',
            call_id: callId,
            output: JSON.stringify({
              error: 'Tool is not allowed for this agent.',
            }),
          });
          steps.push(
            step(
              checkpoint.nextSequence++,
              'guardrail',
              'Tool allowlist',
              'blocked',
              { tool: toolName },
              { reason: 'tool_not_allowed' },
              1,
            ),
          );
          checkpoint.toolIndex += 1;
          await persist(steps.at(-1));
          continue;
        }

        const args = parseToolArguments(call.arguments ?? '{}');
        if (definition.mutating && agent.guardrails.requireApprovalForWrites) {
          steps.push(
            step(
              checkpoint.nextSequence++,
              'approval',
              definition.name,
              'pending',
              args,
              { reason: 'mutating_tool' },
              1,
            ),
          );
          return {
            status: 'waiting_approval',
            output: `The agent requested ${definition.name}. Operator approval is required before execution.`,
            steps,
            inputTokens: checkpoint.inputTokens,
            outputTokens: checkpoint.outputTokens,
            estimatedCostUsd: checkpoint.estimatedCostUsd,
            pendingApproval: { toolName: definition.name, arguments: args },
          };
        }

        const toolStarted = Date.now();
        const result = await executeRuntimeTool(definition, args, {
          idempotencyKey: `${checkpoint.requestId}:tool:${checkpoint.toolIndex}`,
        });
        const inspectedToolOutput = inspectToolOutput(result, agent);
        if (inspectedToolOutput.blocked) {
          const blockedStep = step(
            checkpoint.nextSequence++,
            'tool',
            definition.name,
            'blocked',
            args,
            { withheld: true },
            Date.now() - toolStarted,
          );
          steps.push(blockedStep);
          if (inspectedToolOutput.step) {
            inspectedToolOutput.step.sequence = checkpoint.nextSequence++;
            steps.push(inspectedToolOutput.step);
          }
          checkpoint.inputItems.push({
            type: 'function_call_output',
            call_id: callId,
            output: JSON.stringify({
              error:
                'Tool output was withheld because it contained untrusted instructions.',
            }),
          });
          checkpoint.toolIndex += 1;
          await persist(
            inspectedToolOutput.step
              ? [blockedStep, inspectedToolOutput.step]
              : [blockedStep],
          );
          continue;
        }
        const boundedResult = boundToolResult(
          result,
          policy.budget.maxToolResultBytes,
        );
        steps.push(
          step(
            checkpoint.nextSequence++,
            'tool',
            definition.name,
            'succeeded',
            args,
            boundedResult.value,
            Date.now() - toolStarted,
          ),
        );
        const nextInputItems = [
          ...checkpoint.inputItems,
          {
            type: 'function_call_output',
            call_id: callId,
            output: boundedResult.serialized,
          },
        ];
        assertContextWithinLimit(nextInputItems, policy.budget.maxContextBytes);
        checkpoint.inputItems = nextInputItems;
        checkpoint.toolIndex += 1;
        await persist(steps.at(-1));
      }
      advanceToModel(checkpoint, runId);
      await persist();
    }
  } catch (error) {
    if (error instanceof RuntimePersistenceError) throw error;
    const failureStep = step(
      checkpoint.nextSequence++,
      'model',
      'Runtime failure',
      'failed',
      { provider: provider.name },
      { code: errorCode(error) },
      0,
    );
    steps.push(failureStep);
    return {
      status: 'failed',
      output: '',
      steps,
      inputTokens: checkpoint.inputTokens,
      outputTokens: checkpoint.outputTokens,
      estimatedCostUsd: checkpoint.estimatedCostUsd,
      error: error instanceof Error ? error.message : 'Unknown runtime error',
    };
  }
}

function step(
  sequence: number,
  kind: RuntimeStep['kind'],
  name: string,
  status: RuntimeStep['status'],
  input: Record<string, unknown>,
  output: Record<string, unknown>,
  durationMs: number,
): RuntimeStep {
  return {
    id: crypto.randomUUID(),
    sequence,
    kind,
    name,
    status,
    input,
    output,
    durationMs,
  };
}

function totals(
  agent: AgentConfig,
  input: string,
  rawOutput: string,
  steps: RuntimeStep[],
  _started: number,
): RuntimeResult {
  const inspectedOutput = inspectModelOutput(rawOutput, agent);
  if (inspectedOutput.step) {
    inspectedOutput.step.sequence = steps.length;
    steps.push(inspectedOutput.step);
  }
  const output = inspectedOutput.blocked
    ? (inspectedOutput.message ?? 'Model response blocked by policy.')
    : sanitizeOutput(rawOutput, agent);
  return {
    status: 'succeeded',
    output,
    steps,
    inputTokens: estimateTokens(input),
    outputTokens: estimateTokens(output),
    estimatedCostUsd: 0,
  };
}

function blockedToolResult(
  agent: AgentConfig,
  input: string,
  toolName: string,
  steps: RuntimeStep[],
  started: number,
): RuntimeResult {
  steps.push(
    step(
      steps.length,
      'guardrail',
      'Tool allowlist',
      'blocked',
      { tool: toolName },
      { reason: 'tool_not_allowed' },
      Date.now() - started,
    ),
  );
  return totals(
    agent,
    input,
    'This agent is not permitted to use the tool required for that request.',
    steps,
    started,
  );
}

function parseToolArguments(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Tool arguments must be a JSON object.');
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new Error('Model returned malformed tool arguments.');
  }
}

function estimateTokens(value: string) {
  return Math.max(1, Math.ceil(value.length / 4));
}

function estimateCost(inputTokens: number, outputTokens: number) {
  return Number((inputTokens * 0.00000125 + outputTokens * 0.00001).toFixed(6));
}

function failedResult(input: string, error: unknown): RuntimeResult {
  return {
    status: 'failed',
    output: '',
    steps: [],
    inputTokens: estimateTokens(input),
    outputTokens: 0,
    estimatedCostUsd: 0,
    error: error instanceof Error ? error.message : 'Unknown runtime error',
  };
}

function errorCode(error: unknown): string {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code)
    : 'runtime_error';
}
