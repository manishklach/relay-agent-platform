import type { AgentConfig, RuntimeStep } from './types';

const injectionPatterns = [
  /ignore (all |the )?(previous|prior) instructions/i,
  /reveal (the )?(system|developer) prompt/i,
  /bypass (the )?(policy|guardrail|safety)/i,
];

const unsafeModelOutputPatterns = [
  /(?:ignored|bypassed|overrode) (?:the )?(?:tool )?(?:allowlist|tool restrictions?|safety policy)/i,
  /(?:called|executed|used) (?:an? )?unauthori[sz]ed tool/i,
  /(?:OPENAI_API_KEY|API_KEY|SECRET|PASSWORD)\s*[:=]\s*\S+/i,
  /\bsk-[A-Za-z0-9_-]{16,}\b/,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
];

const emailPattern = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const phonePattern = /\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g;

export function inspectInput(input: string, agent: AgentConfig): { blocked: boolean; message?: string; step?: RuntimeStep } {
  if (!agent.guardrails.blockPromptInjection) return { blocked: false };
  // Threat model: this is a lexical tripwire for conspicuous instruction-override
  // attempts, not a semantic sandbox. Normalization catches some Unicode spacing
  // tricks, but encoded, translated, novel, or context-dependent attacks can pass.
  // Security must come from tool allowlists, least privilege, approval gates, and
  // treating all model/tool text as untrusted; pattern matching is only a first line.
  const matched = containsInjectionPattern(input);
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

export function inspectToolOutput(output: unknown, agent: AgentConfig): { blocked: boolean; step?: RuntimeStep } {
  if (!agent.guardrails.blockPromptInjection) return { blocked: false };
  const serialized = typeof output === 'string' ? output : JSON.stringify(output);
  if (!containsInjectionPattern(serialized)) return { blocked: false };
  return {
    blocked: true,
    step: guardrailStep('Indirect prompt-injection check', 'untrusted_tool_instruction', serialized.length),
  };
}

export function inspectModelOutput(output: string, agent: AgentConfig): { blocked: boolean; message?: string; step?: RuntimeStep } {
  if (!agent.guardrails.blockPromptInjection) return { blocked: false };
  const normalized = normalizeForInspection(output);
  if (!unsafeModelOutputPatterns.some((pattern) => pattern.test(normalized))) return { blocked: false };
  return {
    blocked: true,
    message: 'The model response was withheld because it may violate the agent security policy.',
    step: guardrailStep('Model-output security check', 'unsafe_model_output', output.length),
  };
}

export function sanitizeOutput(output: string, agent: AgentConfig): string {
  if (!agent.guardrails.redactPii) return output;
  return output.replace(emailPattern, '[email redacted]').replace(phonePattern, '[phone redacted]');
}

function containsInjectionPattern(value: string) {
  const normalized = normalizeForInspection(value);
  return injectionPatterns.some((pattern) => pattern.test(normalized));
}

function normalizeForInspection(value: string) {
  return value
    .normalize('NFKC')
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')
    .replace(/[\t\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function guardrailStep(name: string, reason: string, characters: number): RuntimeStep {
  return {
    id: crypto.randomUUID(),
    sequence: 0,
    kind: 'guardrail',
    name,
    status: 'blocked',
    input: { characters },
    output: { reason },
    durationMs: 1,
  };
}
