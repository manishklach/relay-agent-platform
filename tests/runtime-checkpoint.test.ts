import { describe, expect, it } from 'vitest';

import {
  advanceToModel,
  assertContextWithinLimit,
  boundToolResult,
  createModelCheckpoint,
  parseModelCheckpoint,
} from '../lib/runtime-checkpoint';

describe('resumable model checkpoints', () => {
  it('creates stable provider request IDs and advances deterministic turns', () => {
    const checkpoint = createModelCheckpoint('run_123', 'hello', 10_000);
    expect(checkpoint.requestId).toBe('run:run_123:turn:0');
    checkpoint.phase = 'tools';
    checkpoint.pendingCalls = [
      {
        type: 'function_call',
        call_id: 'call_1',
        name: 'lookup',
        arguments: '{}',
      },
    ];
    checkpoint.toolIndex = 1;
    advanceToModel(checkpoint, 'run_123');
    expect(checkpoint).toMatchObject({
      phase: 'model',
      turn: 1,
      requestId: 'run:run_123:turn:1',
      pendingCalls: [],
      toolIndex: 0,
    });
  });

  it('rejects malformed, unsupported, and impossible persisted state', () => {
    expect(() => parseModelCheckpoint('{')).toThrow(/malformed JSON/);
    expect(() => parseModelCheckpoint({ schemaVersion: 2 })).toThrow(
      /Invalid runtime checkpoint/,
    );
    const checkpoint = createModelCheckpoint('run_123', 'hello');
    checkpoint.toolIndex = 1;
    expect(() => parseModelCheckpoint(checkpoint)).toThrow(
      /cursor exceeds pending calls/,
    );
  });

  it('measures serialized context in bytes rather than JavaScript characters', () => {
    expect(() => assertContextWithinLimit([{ content: '😀' }], 10)).toThrow(
      /serialized limit/,
    );
    expect(() =>
      assertContextWithinLimit([{ content: 'ok' }], 100),
    ).not.toThrow();
  });

  it('replaces oversized tool output with a bounded structural marker', () => {
    const bounded = boundToolResult({ content: 'x'.repeat(100) }, 20);
    expect(bounded.truncated).toBe(true);
    expect(bounded.value).toMatchObject({
      truncated: true,
      reason: 'tool_result_size_limit',
    });
    expect(JSON.parse(bounded.serialized)).toEqual(bounded.value);
  });

  it('preserves tool output within the configured limit', () => {
    const value = { answer: 42 };
    expect(boundToolResult(value, 100)).toEqual({
      value,
      serialized: JSON.stringify(value),
      truncated: false,
    });
  });
});
