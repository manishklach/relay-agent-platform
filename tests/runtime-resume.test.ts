import { describe, expect, it } from 'vitest';

import { ProviderRegistry, type ModelProvider } from '../lib/providers';
import { executeAgent, RuntimePersistenceError } from '../lib/runtime';
import {
  parseModelCheckpoint,
  type ModelRuntimeCheckpoint,
} from '../lib/runtime-checkpoint';
import type { RuntimePolicy } from '../lib/runtime-policy';
import { toolCatalog } from '../lib/builtin-tools';
import type { AgentConfig } from '../lib/types';

const agent: AgentConfig = {
  id: 'agent_1',
  workspaceId: 'ws_1',
  name: 'Test agent',
  description: 'Exercises checkpoint resume',
  systemPrompt: 'Use tools.',
  provider: 'test',
  model: 'test-model',
  temperature: 0,
  status: 'live',
  allowedTools: ['lookup_account'],
  guardrails: {},
};

const policy: RuntimePolicy = {
  environment: 'test',
  openAi: {
    baseUrl: 'https://example.test/v1',
    timeoutMs: 1_000,
    maxResponseBytes: 10_000,
    maxAttempts: 1,
  },
  budget: {
    maxTurns: 4,
    maxToolCalls: 4,
    maxInputTokens: 10_000,
    maxOutputTokens: 10_000,
    maxCostUsd: 1,
    maxDurationMs: 60_000,
    maxContextBytes: 100_000,
    maxToolResultBytes: 10_000,
  },
};

describe('model runtime resume', () => {
  it('resumes from a persisted tool cursor without repeating the completed model request', async () => {
    const requestIds: string[] = [];
    const provider: ModelProvider = {
      name: 'test',
      async createResponse(request) {
        requestIds.push(request.requestId);
        if (requestIds.length === 1) {
          return {
            output: [
              {
                type: 'function_call',
                call_id: 'call_1',
                name: 'lookup_account',
                arguments: JSON.stringify({ order_id: 'A-1042' }),
              },
            ],
            usage: { input_tokens: 10, output_tokens: 5 },
          };
        }
        return {
          output_text: 'The account was verified.',
          usage: { input_tokens: 20, output_tokens: 6 },
        };
      },
    };
    const providers = new ProviderRegistry([provider]);
    let durableCheckpoint: ModelRuntimeCheckpoint | undefined;

    await expect(
      executeAgent(agent, 'Check A-1042', {
        runId: 'run_resume_test',
        policy,
        providers,
        tools: toolCatalog.filter((tool) => tool.name === 'lookup_account'),
        onProgress: async ({ checkpoint, steps }) => {
          if (steps.some((step) => step.kind === 'model')) {
            durableCheckpoint = parseModelCheckpoint(
              JSON.stringify(checkpoint),
            );
            throw new Error('simulated Worker persistence boundary');
          }
        },
      }),
    ).rejects.toBeInstanceOf(RuntimePersistenceError);

    expect(durableCheckpoint).toMatchObject({
      phase: 'tools',
      turn: 0,
      toolIndex: 0,
    });
    const resumed = await executeAgent(agent, 'Check A-1042', {
      runId: 'run_resume_test',
      checkpoint: durableCheckpoint,
      policy,
      providers,
      tools: toolCatalog.filter((tool) => tool.name === 'lookup_account'),
      onProgress: async () => undefined,
    });

    expect(resumed.status).toBe('succeeded');
    expect(resumed.output).toBe('The account was verified.');
    expect(resumed.steps.map((step) => step.kind)).toEqual(['tool', 'model']);
    expect(requestIds).toEqual([
      'run:run_resume_test:turn:0',
      'run:run_resume_test:turn:1',
    ]);
    expect(resumed.inputTokens).toBe(30);
    expect(resumed.outputTokens).toBe(11);
  });
});
