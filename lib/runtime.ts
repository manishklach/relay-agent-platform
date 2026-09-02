import { env } from 'cloudflare:workers';

import { inspectInput, inspectModelOutput, inspectToolOutput, sanitizeOutput } from './guardrails';
import { getAllowedTool } from './tool-policy';
import { executeRuntimeTool, executeTool, loadRuntimeTools, toolCatalog, type ToolDefinition } from './tools';
import type { AgentConfig, RuntimeResult, RuntimeStep } from './types';

type ResponseOutputItem = Record<string, unknown> & {
  type?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  content?: Array<{ type?: string; text?: string }>;
};

export async function executeAgent(agent: AgentConfig, input: string): Promise<RuntimeResult> {
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

  if (agent.provider === 'mock' || !env.OPENAI_API_KEY) {
    return executeMockAgent(agent, input);
  }

  return executeOpenAICompatibleAgent(agent, input);
}

async function executeMockAgent(agent: AgentConfig, input: string): Promise<RuntimeResult> {
  const steps: RuntimeStep[] = [];
  const started = Date.now();
  const orderId = input.match(/#?([A-Z]+-[A-Z0-9-]+)/i)?.[1]?.toUpperCase() ?? 'A-1042';

  if (!getAllowedTool('lookup_account', agent.allowedTools, toolCatalog)) {
    return blockedToolResult(agent, input, 'lookup_account', steps, started);
  }

  const accountStarted = Date.now();
  const account = await executeTool('lookup_account', { order_id: orderId });
  steps.push(step(0, 'tool', 'Account lookup', 'succeeded', { order_id: orderId }, account, Date.now() - accountStarted));

  if (!account.found) {
    const output = `I could not verify order ${orderId}. Please check the order reference or ask an operator to locate the account.`;
    steps.push(step(1, 'model', 'Response synthesis', 'succeeded', { model: agent.model }, { characters: output.length }, 8));
    return totals(agent, input, output, steps, started);
  }

  if (!getAllowedTool('lookup_policy', agent.allowedTools, toolCatalog)) {
    return blockedToolResult(agent, input, 'lookup_policy', steps, started);
  }
  const policyStarted = Date.now();
  const policy = await executeTool('lookup_policy', { query: 'refund eligibility' });
  steps.push(step(1, 'tool', 'Policy search', 'succeeded', { query: 'refund eligibility' }, policy, Date.now() - policyStarted));

  const asksToExecute = /\b(issue|process|submit|send|do|go ahead)\b/i.test(input) && /refund/i.test(input);
  if (asksToExecute && agent.allowedTools.includes('issue_refund') && agent.guardrails.requireApprovalForWrites) {
    const args = { order_id: orderId, amount: account.amount, reason: 'Customer request' };
    steps.push(step(2, 'approval', 'Issue refund', 'pending', args, { reason: 'mutating_tool' }, 1));
    const output = `Order ${orderId} is eligible for a $${Number(account.amount ?? 0)} refund. I prepared the refund and sent it for operator approval.`;
    return {
      ...totals(agent, input, output, steps, started),
      status: 'waiting_approval',
      pendingApproval: { toolName: 'issue_refund', arguments: args },
    };
  }

  const output = `Order ${orderId} is eligible for a $${Number(account.amount ?? 0)} refund under the 30-day policy. If you want me to issue it, the action will be sent to an operator for approval.`;
  steps.push(step(2, 'model', 'Response synthesis', 'succeeded', { model: agent.model }, { characters: output.length }, 12));
  return totals(agent, input, output, steps, started);
}

async function executeOpenAICompatibleAgent(agent: AgentConfig, input: string): Promise<RuntimeResult> {
  const steps: RuntimeStep[] = [];
  const inputItems: Array<Record<string, unknown>> = [{ role: 'user', content: input }];
  let inputTokens = 0;
  let outputTokens = 0;
  const availableTools = await loadRuntimeTools(agent.workspaceId, agent.allowedTools);

  try {
    for (let turn = 0; turn < 4; turn += 1) {
      const modelStarted = Date.now();
      const response = await callResponses(agent, inputItems, availableTools);
      inputTokens += response.usage?.input_tokens ?? 0;
      outputTokens += response.usage?.output_tokens ?? 0;
      const outputItems = response.output ?? [];
      const toolCalls = outputItems.filter((item) => item.type === 'function_call' && item.name && item.call_id);
      const responseText = response.output_text || outputItems
        .filter((item) => item.type === 'message')
        .flatMap((item) => item.content ?? [])
        .filter((item) => item.type === 'output_text')
        .map((item) => item.text ?? '')
        .join('\n');

      steps.push(step(
        steps.length,
        'model',
        'Model response',
        'succeeded',
        { model: agent.model, turn },
        { toolCalls: toolCalls.length, characters: responseText.length },
        Date.now() - modelStarted,
      ));

      if (!toolCalls.length) {
        const inspectedOutput = inspectModelOutput(responseText, agent);
        if (inspectedOutput.step) {
          inspectedOutput.step.sequence = steps.length;
          steps.push(inspectedOutput.step);
        }
        const output = inspectedOutput.blocked
          ? inspectedOutput.message ?? 'Model response blocked by policy.'
          : sanitizeOutput(responseText, agent);
        return {
          status: 'succeeded',
          output,
          steps,
          inputTokens: inputTokens || estimateTokens(input),
          outputTokens: outputTokens || estimateTokens(output),
          estimatedCostUsd: estimateCost(inputTokens, outputTokens),
        };
      }

      inputItems.push(...outputItems);
      for (const call of toolCalls) {
        const toolName = call.name ?? '';
        const callId = call.call_id ?? '';
        const definition = getAllowedTool(toolName, agent.allowedTools, availableTools);
        if (!definition) {
          inputItems.push({ type: 'function_call_output', call_id: callId, output: JSON.stringify({ error: 'Tool is not allowed for this agent.' }) });
          steps.push(step(steps.length, 'guardrail', 'Tool allowlist', 'blocked', { tool: toolName }, { reason: 'tool_not_allowed' }, 1));
          continue;
        }

        const args = safeJsonObject(call.arguments ?? '{}');
        if (definition.mutating && agent.guardrails.requireApprovalForWrites) {
          steps.push(step(steps.length, 'approval', definition.name, 'pending', args, { reason: 'mutating_tool' }, 1));
          return {
            status: 'waiting_approval',
            output: `The agent requested ${definition.name}. Operator approval is required before execution.`,
            steps,
            inputTokens,
            outputTokens,
            estimatedCostUsd: estimateCost(inputTokens, outputTokens),
            pendingApproval: { toolName: definition.name, arguments: args },
          };
        }

        const toolStarted = Date.now();
        const result = await executeRuntimeTool(definition, args);
        const inspectedToolOutput = inspectToolOutput(result, agent);
        if (inspectedToolOutput.blocked) {
          steps.push(step(steps.length, 'tool', definition.name, 'blocked', args, { withheld: true }, Date.now() - toolStarted));
          if (inspectedToolOutput.step) {
            inspectedToolOutput.step.sequence = steps.length;
            steps.push(inspectedToolOutput.step);
          }
          inputItems.push({
            type: 'function_call_output',
            call_id: callId,
            output: JSON.stringify({ error: 'Tool output was withheld because it contained untrusted instructions.' }),
          });
          continue;
        }
        steps.push(step(steps.length, 'tool', definition.name, 'succeeded', args, result, Date.now() - toolStarted));
        inputItems.push({ type: 'function_call_output', call_id: callId, output: JSON.stringify(result) });
      }
    }
    throw new Error('Agent exceeded the four-turn execution limit.');
  } catch (error) {
    return {
      status: 'failed',
      output: '',
      steps,
      inputTokens,
      outputTokens,
      estimatedCostUsd: estimateCost(inputTokens, outputTokens),
      error: error instanceof Error ? error.message : 'Unknown runtime error',
    };
  }
}

async function callResponses(agent: AgentConfig, input: Array<Record<string, unknown>>, tools: ToolDefinition[]) {
  const baseUrl = (env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
  const response = await fetch(`${baseUrl}/responses`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: agent.model,
      instructions: agent.systemPrompt,
      temperature: agent.temperature,
      input,
      store: false,
      parallel_tool_calls: false,
      tools: tools.map((tool) => ({
        type: 'function',
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        strict: tool.kind !== 'http',
      })),
    }),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Model provider error ${response.status}: ${detail.slice(0, 240)}`);
  }
  return response.json() as Promise<{
    output?: ResponseOutputItem[];
    output_text?: string;
    usage?: { input_tokens?: number; output_tokens?: number };
  }>;
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
  return { id: crypto.randomUUID(), sequence, kind, name, status, input, output, durationMs };
}

function totals(agent: AgentConfig, input: string, rawOutput: string, steps: RuntimeStep[], _started: number): RuntimeResult {
  const inspectedOutput = inspectModelOutput(rawOutput, agent);
  if (inspectedOutput.step) {
    inspectedOutput.step.sequence = steps.length;
    steps.push(inspectedOutput.step);
  }
  const output = inspectedOutput.blocked
    ? inspectedOutput.message ?? 'Model response blocked by policy.'
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
  steps.push(step(steps.length, 'guardrail', 'Tool allowlist', 'blocked', { tool: toolName }, { reason: 'tool_not_allowed' }, Date.now() - started));
  return totals(agent, input, 'This agent is not permitted to use the tool required for that request.', steps, started);
}

function safeJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function estimateTokens(value: string) {
  return Math.max(1, Math.ceil(value.length / 4));
}

function estimateCost(inputTokens: number, outputTokens: number) {
  return Number(((inputTokens * 0.00000125) + (outputTokens * 0.00001)).toFixed(6));
}
