import { z } from 'zod';

import type { AgentConfig } from './types';

export const agentVersionConfigSchema = z
  .object({
    systemPrompt: z.string().trim().min(20).max(12_000),
    provider: z.enum(['mock', 'openai']),
    model: z.string().trim().min(2).max(100),
    temperature: z.number().min(0).max(2),
    allowedTools: z.array(z.string().min(1)).max(30),
    guardrails: z
      .object({
        redactPii: z.boolean(),
        blockPromptInjection: z.boolean(),
        requireApprovalForWrites: z.boolean(),
      })
      .strict(),
  })
  .strict();

export type AgentVersionConfig = z.infer<typeof agentVersionConfigSchema>;

export function agentVersionFromConfig(agent: AgentConfig): AgentVersionConfig {
  return agentVersionConfigSchema.parse({
    systemPrompt: agent.systemPrompt,
    provider: agent.provider,
    model: agent.model,
    temperature: agent.temperature,
    allowedTools: agent.allowedTools,
    guardrails: {
      redactPii: agent.guardrails.redactPii ?? true,
      blockPromptInjection: agent.guardrails.blockPromptInjection ?? true,
      requireApprovalForWrites:
        agent.guardrails.requireApprovalForWrites ?? true,
    },
  });
}

export function applyAgentVersion(
  agent: AgentConfig,
  value: unknown,
): AgentConfig {
  const version = agentVersionConfigSchema.parse(value);
  return { ...agent, ...version };
}

export function assertProposalCanActivate(input: {
  status: string;
  score: number | null;
  minimumScore: number;
  baseVersionId: string;
  activeVersionId: string;
}): void {
  if (input.status !== 'approved')
    throw new Error('Only an approved proposal can be activated.');
  if (input.score === null || input.score < input.minimumScore) {
    throw new Error('The candidate did not meet its evaluation threshold.');
  }
  if (input.baseVersionId !== input.activeVersionId) {
    throw new Error(
      'The proposal is stale because the active agent version changed.',
    );
  }
}
