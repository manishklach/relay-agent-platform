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

export function parseToolConfig(value: unknown): ToolDefinition['config'] {
  let decoded: unknown = value;
  if (typeof value === 'string') {
    try {
      decoded = JSON.parse(value);
    } catch {
      throw new Error('Persisted tool configuration contains malformed JSON.');
    }
  }
  const parsed = toolConfigSchema.safeParse(decoded);
  if (!parsed.success)
    throw new Error(
      `Invalid persisted tool configuration: ${z.prettifyError(parsed.error)}`,
    );
  return parsed.data;
}

export function supportsIdempotentExecution(tool: ToolDefinition): boolean {
  if (!tool.mutating) return true;
  if (!tool.kind || tool.kind === 'builtin')
    return tool.name === 'issue_refund';
  return tool.kind === 'http' && tool.config?.supportsIdempotency === true;
}
import { z } from 'zod';

const toolConfigSchema = z.object({
  url: z
    .url()
    .refine((value) => value.startsWith('https://'), 'HTTPS is required')
    .optional(),
  method: z.enum(['GET', 'POST']).optional(),
  supportsIdempotency: z.boolean().optional(),
});
