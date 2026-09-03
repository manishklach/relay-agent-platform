import { z } from 'zod';

import { RuntimeLimitError } from './runtime-policy';

const recordSchema = z.record(z.string(), z.unknown());
const pendingCallSchema = z.looseObject({
  type: z.literal('function_call'),
  call_id: z.string(),
  name: z.string(),
  arguments: z.string().default('{}'),
});

export const modelRuntimeCheckpointSchema = z.object({
  schemaVersion: z.literal(1),
  phase: z.enum(['model', 'tools']),
  turn: z.number().int().nonnegative(),
  requestId: z.string().min(1),
  inputItems: z.array(recordSchema),
  pendingCalls: z.array(pendingCallSchema),
  toolIndex: z.number().int().nonnegative(),
  nextSequence: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  toolCalls: z.number().int().nonnegative(),
  estimatedCostUsd: z.number().nonnegative(),
  startedAt: z.number().int().positive(),
});

export type ModelRuntimeCheckpoint = z.infer<
  typeof modelRuntimeCheckpointSchema
>;

export function createModelCheckpoint(
  runId: string,
  input: string,
  startedAt = Date.now(),
): ModelRuntimeCheckpoint {
  return {
    schemaVersion: 1,
    phase: 'model',
    turn: 0,
    requestId: modelRequestId(runId, 0),
    inputItems: [{ role: 'user', content: input }],
    pendingCalls: [],
    toolIndex: 0,
    nextSequence: 0,
    inputTokens: 0,
    outputTokens: 0,
    toolCalls: 0,
    estimatedCostUsd: 0,
    startedAt,
  };
}

export function parseModelCheckpoint(value: unknown): ModelRuntimeCheckpoint {
  const decoded = typeof value === 'string' ? parseJson(value) : value;
  const parsed = modelRuntimeCheckpointSchema.safeParse(decoded);
  if (!parsed.success)
    throw new Error(
      `Invalid runtime checkpoint: ${z.prettifyError(parsed.error)}`,
    );
  if (parsed.data.toolIndex > parsed.data.pendingCalls.length) {
    throw new Error(
      'Invalid runtime checkpoint: tool cursor exceeds pending calls.',
    );
  }
  return parsed.data;
}

export function advanceToModel(
  checkpoint: ModelRuntimeCheckpoint,
  runId: string,
): void {
  checkpoint.turn += 1;
  checkpoint.phase = 'model';
  checkpoint.requestId = modelRequestId(runId, checkpoint.turn);
  checkpoint.pendingCalls = [];
  checkpoint.toolIndex = 0;
}

export function assertContextWithinLimit(
  inputItems: Array<Record<string, unknown>>,
  maxBytes: number,
): void {
  const bytes = byteLength(JSON.stringify(inputItems));
  if (bytes > maxBytes) {
    throw new RuntimeLimitError(
      'max_context_bytes',
      `Agent context exceeded the ${maxBytes}-byte serialized limit.`,
    );
  }
}

export function boundToolResult(
  result: Record<string, unknown>,
  maxBytes: number,
): { value: Record<string, unknown>; serialized: string; truncated: boolean } {
  const serialized = JSON.stringify(result);
  const bytes = byteLength(serialized);
  if (bytes <= maxBytes) return { value: result, serialized, truncated: false };
  const value = {
    truncated: true,
    originalBytes: bytes,
    reason: 'tool_result_size_limit',
  };
  return { value, serialized: JSON.stringify(value), truncated: true };
}

function modelRequestId(runId: string, turn: number): string {
  return `run:${runId}:turn:${turn}`;
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error('Invalid runtime checkpoint: malformed JSON.');
  }
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
