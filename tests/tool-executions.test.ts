import { describe, expect, it } from 'vitest';

import { executeTool } from '../lib/builtin-tools';
import { failureDisposition } from '../lib/tool-execution-policy';
import {
  supportsIdempotentExecution,
  type ToolDefinition,
} from '../lib/tool-contract';

describe('durable tool execution policy', () => {
  it('schedules bounded exponential retries only for idempotent tools', () => {
    expect(
      failureDisposition(
        { retrySafe: true, attempts: 1, maxAttempts: 3 },
        10_000,
      ),
    ).toEqual({
      status: 'retry_scheduled',
      nextAttemptAt: 11_000,
      terminal: false,
    });
    expect(
      failureDisposition(
        { retrySafe: true, attempts: 2, maxAttempts: 3 },
        10_000,
      ),
    ).toEqual({
      status: 'retry_scheduled',
      nextAttemptAt: 12_000,
      terminal: false,
    });
    expect(
      failureDisposition(
        { retrySafe: true, attempts: 3, maxAttempts: 3 },
        10_000,
      ),
    ).toEqual({
      status: 'dead_letter',
      nextAttemptAt: 10_000,
      terminal: true,
    });
  });

  it('marks an ambiguous non-idempotent failure as unknown instead of replaying it', () => {
    expect(
      failureDisposition(
        { retrySafe: false, attempts: 1, maxAttempts: 3 },
        10_000,
      ),
    ).toEqual({
      status: 'unknown',
      nextAttemptAt: 10_000,
      terminal: true,
    });
  });

  it('derives retry safety from the registered tool contract', () => {
    const httpTool = (supportsIdempotency: boolean): ToolDefinition => ({
      name: 'external_write',
      description: 'External state change',
      parameters: {},
      mutating: true,
      kind: 'http',
      config: {
        url: 'https://example.com/tool',
        method: 'POST',
        supportsIdempotency,
      },
    });
    expect(supportsIdempotentExecution(httpTool(true))).toBe(true);
    expect(supportsIdempotentExecution(httpTool(false))).toBe(false);
    expect(
      supportsIdempotentExecution({ ...httpTool(false), mutating: false }),
    ).toBe(true);
  });

  it('makes the built-in refund result stable for one idempotency key', async () => {
    const args = { order_id: 'A-1042', amount: 79, reason: 'Customer request' };
    const first = await executeTool('issue_refund', args, {
      idempotencyKey: 'approval:abc-123',
    });
    const replay = await executeTool('issue_refund', args, {
      idempotencyKey: 'approval:abc-123',
    });
    const other = await executeTool('issue_refund', args, {
      idempotencyKey: 'approval:def-456',
    });
    expect(replay.reference).toBe(first.reference);
    expect(other.reference).not.toBe(first.reference);
  });
});
