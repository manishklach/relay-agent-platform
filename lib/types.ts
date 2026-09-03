export type AgentConfig = {
  id: string;
  versionId?: string;
  workspaceId: string;
  name: string;
  description: string;
  systemPrompt: string;
  provider: string;
  model: string;
  temperature: number;
  status: 'draft' | 'live' | 'paused';
  allowedTools: string[];
  guardrails: {
    redactPii?: boolean;
    blockPromptInjection?: boolean;
    requireApprovalForWrites?: boolean;
  };
};

export type RuntimeStep = {
  id: string;
  sequence: number;
  kind: 'model' | 'tool' | 'guardrail' | 'approval';
  name: string;
  status: 'succeeded' | 'failed' | 'blocked' | 'pending';
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  durationMs: number;
};

export type RuntimeResult = {
  status: 'succeeded' | 'failed' | 'waiting_approval';
  output: string;
  steps: RuntimeStep[];
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
  pendingApproval?: { toolName: string; arguments: Record<string, unknown> };
  error?: string;
};
