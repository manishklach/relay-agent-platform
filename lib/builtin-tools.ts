import type { ToolDefinition, ToolExecutionContext } from './tool-contract';

export const toolCatalog: ToolDefinition[] = [
  {
    name: 'lookup_account',
    description: 'Look up a customer account or order by an order reference.',
    parameters: {
      type: 'object',
      properties: {
        order_id: {
          type: 'string',
          description: 'Order reference such as A-1042.',
        },
      },
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
    description:
      'Issue a refund for an eligible order. This is a mutating action and requires approval.',
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

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  context: ToolExecutionContext = {},
): Promise<Record<string, unknown>> {
  if (name === 'lookup_account') {
    const orderId = typeof args.order_id === 'string' ? args.order_id : '';
    if (orderId.toUpperCase() === 'A-1042') {
      return {
        found: true,
        orderId: 'A-1042',
        customerTier: 'Plus',
        amount: 79,
        currency: 'USD',
        deliveredDaysAgo: 8,
      };
    }
    return { found: false, orderId };
  }
  if (name === 'lookup_policy') {
    return {
      policyId: 'refund-standard-v3',
      summary:
        'Delivered orders are eligible for a refund within 30 days. Refund execution requires operator approval.',
      maxDays: 30,
      approvalRequired: true,
    };
  }
  if (name === 'issue_refund') {
    const stableSuffix = context.idempotencyKey
      ?.replace(/[^a-zA-Z0-9]/g, '')
      .slice(-12);
    return {
      submitted: true,
      reference: `refund_${stableSuffix || crypto.randomUUID().slice(0, 8)}`,
      ...args,
    };
  }
  throw new Error(`Unknown tool: ${name}`);
}
