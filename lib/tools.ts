import { env } from 'cloudflare:workers';

import { executeTool, getToolDefinition } from './builtin-tools';
import { safeHttpRequest } from './safe-http';
import {
  parseToolConfig,
  type ToolDefinition,
  type ToolExecutionContext,
} from './tool-contract';

export { executeTool, getToolDefinition, toolCatalog } from './builtin-tools';
export { supportsIdempotentExecution } from './tool-contract';
export type { ToolDefinition, ToolExecutionContext } from './tool-contract';

export async function loadRuntimeTools(
  workspaceId: string,
  names: string[],
): Promise<ToolDefinition[]> {
  if (!names.length) return [];
  const placeholders = names.map(() => '?').join(',');
  const result = await env.DB.prepare(
    `SELECT name, description, kind, config_json, approval_required
     FROM tools WHERE workspace_id = ? AND enabled = 1 AND name IN (${placeholders})`,
  )
    .bind(workspaceId, ...names)
    .all<Record<string, unknown>>();
  return result.results.map((row) => {
    const builtin = getToolDefinition(String(row.name));
    return {
      name: String(row.name),
      description: String(row.description),
      parameters: builtin?.parameters ?? {
        type: 'object',
        properties: {
          input: { type: 'string', description: 'Input for the integration.' },
        },
        required: ['input'],
        additionalProperties: true,
      },
      mutating: Boolean(row.approval_required) || builtin?.mutating === true,
      kind: String(row.kind) as ToolDefinition['kind'],
      config: parseToolConfig(row.config_json),
    };
  });
}

export async function executeRuntimeTool(
  tool: ToolDefinition,
  args: Record<string, unknown>,
  context: ToolExecutionContext = {},
): Promise<Record<string, unknown>> {
  if (!tool.kind || tool.kind === 'builtin')
    return executeTool(tool.name, args, context);
  if (tool.kind === 'mcp')
    throw new Error('Remote MCP transport is not enabled for this deployment.');
  const rawUrl = tool.config?.url;
  if (!rawUrl) throw new Error('HTTP tool has no configured URL.');
  const url = new URL(rawUrl);
  const method = tool.config?.method ?? 'POST';
  if (method === 'GET') {
    for (const [key, value] of Object.entries(args)) {
      url.searchParams.set(
        key,
        typeof value === 'string' ? value : JSON.stringify(value),
      );
    }
  }
  const response = await safeHttpRequest(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'Relay-Agent-Tool/1.0',
      ...(context.idempotencyKey
        ? { 'Idempotency-Key': context.idempotencyKey }
        : {}),
    },
    body: method === 'GET' ? undefined : JSON.stringify(args),
  });
  let body: unknown;
  try {
    body = response.contentType.includes('application/json')
      ? JSON.parse(response.bodyText)
      : response.bodyText;
  } catch {
    throw new Error('HTTP tool returned malformed JSON.');
  }
  if (!response.ok) throw new Error(`HTTP tool returned ${response.status}.`);
  return typeof body === 'object' && body !== null
    ? (body as Record<string, unknown>)
    : { result: body };
}
