import { env } from 'cloudflare:workers';

import { parseJson } from './server-data';

export type ToolDefinition = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  mutating: boolean;
  kind?: 'builtin' | 'http' | 'mcp';
  config?: { url?: string; method?: 'GET' | 'POST' };
};

export const toolCatalog: ToolDefinition[] = [
  {
    name: 'lookup_account',
    description: 'Look up a customer account or order by an order reference.',
    parameters: {
      type: 'object',
      properties: { order_id: { type: 'string', description: 'Order reference such as A-1042.' } },
      required: ['order_id'],
      additionalProperties: false,
    },
    mutating: false,
  },
  {
    name: 'lookup_policy',
    description: 'Search the approved customer-care policy knowledge base.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
      additionalProperties: false,
    },
    mutating: false,
  },
  {
    name: 'issue_refund',
    description: 'Issue a refund for an eligible order. This is a mutating action and requires approval.',
    parameters: {
      type: 'object',
      properties: {
        order_id: { type: 'string' },
        amount: { type: 'number' },
        reason: { type: 'string' },
      },
      required: ['order_id', 'amount', 'reason'],
      additionalProperties: false,
    },
    mutating: true,
  },
];

export function getToolDefinition(name: string) {
  return toolCatalog.find((tool) => tool.name === name);
}

export async function loadRuntimeTools(workspaceId: string, names: string[]): Promise<ToolDefinition[]> {
  if (!names.length) return [];
  const placeholders = names.map(() => '?').join(',');
  const result = await env.DB.prepare(
    `SELECT name, description, kind, config_json, approval_required
     FROM tools WHERE workspace_id = ? AND enabled = 1 AND name IN (${placeholders})`,
  ).bind(workspaceId, ...names).all<Record<string, unknown>>();
  return result.results.map((row) => {
    const builtin = getToolDefinition(String(row.name));
    return {
      name: String(row.name),
      description: String(row.description),
      parameters: builtin?.parameters ?? {
        type: 'object',
        properties: { input: { type: 'string', description: 'Input for the integration.' } },
        required: ['input'],
        additionalProperties: true,
      },
      mutating: Boolean(row.approval_required) || builtin?.mutating === true,
      kind: String(row.kind) as ToolDefinition['kind'],
      config: parseJson(row.config_json, {}),
    };
  });
}

export async function executeTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (name === 'lookup_account') {
    const orderId = typeof args.order_id === 'string' ? args.order_id : '';
    if (orderId.toUpperCase() === 'A-1042') {
      return { found: true, orderId: 'A-1042', customerTier: 'Plus', amount: 79, currency: 'USD', deliveredDaysAgo: 8 };
    }
    return { found: false, orderId };
  }

  if (name === 'lookup_policy') {
    return {
      policyId: 'refund-standard-v3',
      summary: 'Delivered orders are eligible for a refund within 30 days. Refund execution requires operator approval.',
      maxDays: 30,
      approvalRequired: true,
    };
  }

  if (name === 'issue_refund') {
    return { submitted: true, reference: `refund_${crypto.randomUUID().slice(0, 8)}`, ...args };
  }

  throw new Error(`Unknown tool: ${name}`);
}

export async function executeRuntimeTool(tool: ToolDefinition, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (!tool.kind || tool.kind === 'builtin') return executeTool(tool.name, args);
  if (tool.kind === 'mcp') throw new Error('Remote MCP transport is not enabled for this deployment.');

  const rawUrl = tool.config?.url;
  if (!rawUrl) throw new Error('HTTP tool has no configured URL.');
  const url = new URL(rawUrl);
  if (url.protocol !== 'https:' || isPrivateHostname(url.hostname)) {
    throw new Error('HTTP tools must use a public HTTPS endpoint.');
  }
  const method = tool.config?.method ?? 'POST';
  if (method === 'GET') {
    for (const [key, value] of Object.entries(args)) url.searchParams.set(key, typeof value === 'string' ? value : JSON.stringify(value));
  }
  const response = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'Relay-Agent-Tool/1.0' },
    body: method === 'GET' ? undefined : JSON.stringify(args),
  });
  const contentType = response.headers.get('content-type') ?? '';
  const body: unknown = contentType.includes('application/json') ? await response.json() : await response.text();
  if (!response.ok) throw new Error(`HTTP tool returned ${response.status}.`);
  return typeof body === 'object' && body !== null ? body as Record<string, unknown> : { result: body };
}

function isPrivateHostname(hostname: string) {
  const value = hostname.toLowerCase();
  return value === 'localhost' || value === '::1' || value.endsWith('.local') || value.startsWith('127.') || value.startsWith('10.') || value.startsWith('192.168.') || value.startsWith('169.254.') || /^172\.(1[6-9]|2\d|3[01])\./.test(value);
}
