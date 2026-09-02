export type ToolDefinition = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  mutating: boolean;
  kind?: 'builtin' | 'http' | 'mcp';
  config?: {
    url?: string;
    method?: 'GET' | 'POST';
    supportsIdempotency?: boolean;
  };
};

export type ToolExecutionContext = { idempotencyKey?: string };

export function supportsIdempotentExecution(tool: ToolDefinition): boolean {
  if (!tool.mutating) return true;
  if (!tool.kind || tool.kind === 'builtin')
    return tool.name === 'issue_refund';
  return tool.kind === 'http' && tool.config?.supportsIdempotency === true;
}
