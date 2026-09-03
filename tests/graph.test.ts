import { describe, expect, it, vi } from 'vitest';

import {
  createGraphCheckpoint,
  executeGraph,
  graphDefinitionSchema,
  renderPrompt,
} from '../lib/graph';

const loopGraph = graphDefinitionSchema.parse({
  version: 1,
  entryNodeId: 'worker',
  maxSteps: 5,
  maxVisitsPerNode: 3,
  nodes: [
    {
      id: 'worker',
      type: 'agent',
      agentId: 'agent_worker',
      prompt: '{{input}} {{nodes.worker.output}}',
    },
    { id: 'done', type: 'end' },
  ],
  edges: [
    {
      from: 'worker',
      to: 'done',
      priority: 10,
      when: { type: 'output_contains', value: 'DONE' },
    },
    { from: 'worker', to: 'worker', priority: 0, when: { type: 'always' } },
  ],
});

describe('graph engine', () => {
  it('executes a deterministic bounded loop and checkpoints every boundary', async () => {
    const executeAgentNode = vi
      .fn()
      .mockResolvedValueOnce({ status: 'succeeded', output: 'try again' })
      .mockResolvedValueOnce({ status: 'succeeded', output: 'DONE' });
    const checkpoints: number[] = [];
    const result = await executeGraph({
      definition: loopGraph,
      checkpoint: createGraphCheckpoint(loopGraph, 'solve'),
      executeAgentNode,
      onProgress: (checkpoint) => {
        checkpoints.push(checkpoint.stepCount);
      },
    });

    expect(result.status).toBe('completed');
    expect(result.stepCount).toBe(2);
    expect(result.visits.worker).toBe(2);
    expect(executeAgentNode).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      'solve try again',
      { step: 1, visit: 2 },
    );
    expect(checkpoints).toEqual([0, 1, 1, 2, 2]);
  });

  it('fails closed when a cycle exceeds its per-node visit budget', async () => {
    const result = await executeGraph({
      definition: { ...loopGraph, maxVisitsPerNode: 2 },
      checkpoint: createGraphCheckpoint(loopGraph, 'solve'),
      executeAgentNode: async () => ({
        status: 'succeeded',
        output: 'not yet',
      }),
    });
    expect(result.status).toBe('failed');
    expect(result.stepCount).toBe(2);
  });

  it('pauses on approval without consuming a completed step or another visit on resume', async () => {
    const waiting = await executeGraph({
      definition: loopGraph,
      checkpoint: createGraphCheckpoint(loopGraph, 'solve'),
      executeAgentNode: async (_node, _prompt, cursor) => ({
        status: 'waiting_approval',
        output: 'approval required',
        runId: `child-${cursor.visit}`,
      }),
    });
    expect(waiting.status).toBe('waiting_approval');
    expect(waiting.stepCount).toBe(0);
    expect(waiting.visits.worker).toBe(1);

    const resumed = await executeGraph({
      definition: loopGraph,
      checkpoint: waiting,
      executeAgentNode: async (_node, _prompt, cursor) => {
        expect(cursor.visit).toBe(1);
        return { status: 'succeeded', output: 'DONE', runId: 'child-1' };
      },
    });
    expect(resumed.status).toBe('completed');
    expect(resumed.stepCount).toBe(1);
    expect(resumed.visits.worker).toBe(1);
  });

  it('rejects ambiguous equal-priority transitions at execution time', async () => {
    const definition = graphDefinitionSchema.parse({
      ...loopGraph,
      edges: [
        {
          from: 'worker',
          to: 'done',
          priority: 1,
          when: { type: 'succeeded' },
        },
        {
          from: 'worker',
          to: 'worker',
          priority: 1,
          when: { type: 'output_contains', value: 'ok' },
        },
      ],
    });
    await expect(
      executeGraph({
        definition,
        checkpoint: createGraphCheckpoint(definition, 'input'),
        executeAgentNode: async () => ({ status: 'succeeded', output: 'ok' }),
      }),
    ).rejects.toThrow('ambiguous transition');
  });

  it('rejects missing nodes and duplicate fallbacks', () => {
    expect(() =>
      graphDefinitionSchema.parse({
        ...loopGraph,
        edges: [
          { from: 'worker', to: 'missing', when: { type: 'always' } },
          { from: 'worker', to: 'worker', when: { type: 'always' } },
        ],
      }),
    ).toThrow();
  });

  it('rejects unreachable nodes and outgoing edges from an end node', () => {
    expect(() =>
      graphDefinitionSchema.parse({
        ...loopGraph,
        nodes: [...loopGraph.nodes, { id: 'orphan', type: 'end' }],
      }),
    ).toThrow('unreachable');
    expect(() =>
      graphDefinitionSchema.parse({
        ...loopGraph,
        edges: [
          ...loopGraph.edges,
          { from: 'done', to: 'worker', when: { type: 'always' } },
        ],
      }),
    ).toThrow('cannot have outgoing');
  });

  it('renders only declared input and node-output placeholders', () => {
    const checkpoint = {
      ...createGraphCheckpoint(loopGraph, 'hello'),
      outputs: { worker: 'world' },
    };
    expect(
      renderPrompt('{{input}} {{nodes.worker.output}} {{secret}}', checkpoint),
    ).toBe('hello world {{secret}}');
  });
});
