import type { AgentConfig, RuntimeStep } from './types';

const injectionPatterns = [
  /ignore (all |the )?(previous|prior) instructions/i,
  /reveal (the )?(system|developer) prompt/i,
  /bypass (the )?(policy|guardrail|safety)/i,
];

const emailPattern = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const phonePattern = /\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g;

export function inspectInput(input: string, agent: AgentConfig): { blocked: boolean; message?: string; step?: RuntimeStep } {
  if (!agent.guardrails.blockPromptInjection) return { blocked: false };
  const matched = injectionPatterns.some((pattern) => pattern.test(input));
  if (!matched) return { blocked: false };

  return {
    blocked: true,
    message: 'I cannot follow instructions that attempt to override this agent’s operating policy.',
    step: {
      id: crypto.randomUUID(),
      sequence: 0,
      kind: 'guardrail',
      name: 'Prompt-injection check',
      status: 'blocked',
      input: { characters: input.length },
      output: { reason: 'instruction_override_attempt' },
      durationMs: 1,
    },
  };
}

export function sanitizeOutput(output: string, agent: AgentConfig): string {
  if (!agent.guardrails.redactPii) return output;
  return output.replace(emailPattern, '[email redacted]').replace(phonePattern, '[phone redacted]');
}
