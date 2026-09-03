import { z } from 'zod';

const graphNodeId = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);

export const graphNodeSchema = z.discriminatedUnion('type', [
  z
    .object({
      id: graphNodeId,
      type: z.literal('agent'),
      agentId: z.string().min(1),
      agentVersionId: z.string().min(1).optional(),
      prompt: z.string().min(1).max(20_000).default('{{input}}'),
    })
    .strict(),
  z
    .object({
      id: graphNodeId,
      type: z.literal('end'),
    })
    .strict(),
]);

export const graphEdgeSchema = z
  .object({
    from: graphNodeId,
    to: graphNodeId,
    priority: z.number().int().min(0).max(100).default(0),
    when: z.discriminatedUnion('type', [
      z.object({ type: z.literal('always') }).strict(),
      z.object({ type: z.literal('succeeded') }).strict(),
      z.object({ type: z.literal('failed') }).strict(),
      z
        .object({
          type: z.literal('output_contains'),
          value: z.string().min(1).max(500),
          caseSensitive: z.boolean().default(false),
        })
        .strict(),
      z
        .object({
          type: z.literal('output_not_contains'),
          value: z.string().min(1).max(500),
          caseSensitive: z.boolean().default(false),
        })
        .strict(),
    ]),
  })
  .strict();

export const graphDefinitionSchema = z
  .object({
    version: z.literal(1),
    entryNodeId: graphNodeId,
    maxSteps: z.number().int().min(1).max(100).default(20),
    maxVisitsPerNode: z.number().int().min(1).max(20).default(3),
    nodes: z.array(graphNodeSchema).min(2).max(100),
    edges: z.array(graphEdgeSchema).max(500),
  })
  .strict()
  .superRefine((definition, context) => {
    const ids = new Set<string>();
    for (const node of definition.nodes) {
      if (ids.has(node.id)) {
        context.addIssue({
          code: 'custom',
          message: `Duplicate node id: ${node.id}`,
        });
      }
      ids.add(node.id);
    }
    if (!ids.has(definition.entryNodeId)) {
      context.addIssue({
        code: 'custom',
        message: 'Entry node does not exist.',
      });
    }
    if (!definition.nodes.some((node) => node.type === 'end')) {
      context.addIssue({
        code: 'custom',
        message: 'Graph requires at least one end node.',
      });
    }
    for (const edge of definition.edges) {
      if (!ids.has(edge.from) || !ids.has(edge.to)) {
        context.addIssue({
          code: 'custom',
          message: `Edge ${edge.from} -> ${edge.to} references a missing node.`,
        });
      }
    }
    for (const node of definition.nodes) {
      const outgoing = definition.edges.filter((edge) => edge.from === node.id);
      if (node.type === 'end' && outgoing.length > 0) {
        context.addIssue({
          code: 'custom',
          message: `End node ${node.id} cannot have outgoing edges.`,
        });
      }
      const fallbacks = outgoing.filter((edge) => edge.when.type === 'always');
      if (fallbacks.length > 1) {
        context.addIssue({
          code: 'custom',
          message: `Node ${node.id} has more than one fallback edge.`,
        });
      }
      const keys = new Set<string>();
      for (const edge of outgoing) {
        const key = `${edge.priority}:${JSON.stringify(edge.when)}`;
        if (keys.has(key)) {
          context.addIssue({
            code: 'custom',
            message: `Node ${node.id} has duplicate edge conditions at the same priority.`,
          });
        }
        keys.add(key);
      }
    }
    const reachable = new Set([definition.entryNodeId]);
    const queue = [definition.entryNodeId];
    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const edge of definition.edges.filter(
        (item) => item.from === current,
      )) {
        if (!reachable.has(edge.to)) {
          reachable.add(edge.to);
          queue.push(edge.to);
        }
      }
    }
    for (const node of definition.nodes) {
      if (!reachable.has(node.id)) {
        context.addIssue({
          code: 'custom',
          message: `Node ${node.id} is unreachable.`,
        });
      }
    }
  });

export type GraphDefinition = z.infer<typeof graphDefinitionSchema>;
export type GraphNode = z.infer<typeof graphNodeSchema>;
export type GraphNodeResult = {
  status: 'succeeded' | 'failed' | 'waiting_approval';
  output: string;
  runId?: string;
};

export const graphCheckpointSchema = z
  .object({
    version: z.literal(1),
    status: z.enum([
      'ready',
      'running',
      'waiting_approval',
      'completed',
      'failed',
    ]),
    currentNodeId: graphNodeId,
    input: z.string().max(100_000),
    stepCount: z.number().int().nonnegative(),
    visits: z.record(graphNodeId, z.number().int().nonnegative()),
    outputs: z.record(graphNodeId, z.string().max(100_000)),
    lastResult: z
      .object({
        nodeId: graphNodeId,
        status: z.enum(['succeeded', 'failed', 'waiting_approval']),
        output: z.string().max(100_000),
        runId: z.string().optional(),
      })
      .optional(),
  })
  .strict();

export type GraphCheckpoint = z.infer<typeof graphCheckpointSchema>;

export function createGraphCheckpoint(
  definition: GraphDefinition,
  input: string,
): GraphCheckpoint {
  return graphCheckpointSchema.parse({
    version: 1,
    status: 'ready',
    currentNodeId: definition.entryNodeId,
    input,
    stepCount: 0,
    visits: {},
    outputs: {},
  });
}

export async function executeGraph(options: {
  definition: GraphDefinition;
  checkpoint: GraphCheckpoint;
  executeAgentNode: (
    node: Extract<GraphNode, { type: 'agent' }>,
    prompt: string,
    cursor: { step: number; visit: number },
  ) => Promise<GraphNodeResult>;
  onProgress?: (checkpoint: GraphCheckpoint) => void | Promise<void>;
}): Promise<GraphCheckpoint> {
  const definition = graphDefinitionSchema.parse(options.definition);
  let state = graphCheckpointSchema.parse(options.checkpoint);
  const nodes = new Map(definition.nodes.map((node) => [node.id, node]));

  while (state.status !== 'completed' && state.status !== 'failed') {
    if (state.stepCount >= definition.maxSteps) {
      state = { ...state, status: 'failed' };
      await options.onProgress?.(state);
      return state;
    }

    const node = nodes.get(state.currentNodeId);
    if (!node)
      throw new Error(
        `Checkpoint references missing node: ${state.currentNodeId}`,
      );
    if (node.type === 'end') {
      state = { ...state, status: 'completed' };
      await options.onProgress?.(state);
      return state;
    }

    const resumingPending = state.status === 'waiting_approval';
    const visits = (state.visits[node.id] ?? 0) + (resumingPending ? 0 : 1);
    if (visits > definition.maxVisitsPerNode) {
      state = { ...state, status: 'failed' };
      await options.onProgress?.(state);
      return state;
    }

    const beforeNode: GraphCheckpoint = {
      ...state,
      status: 'running',
      visits: { ...state.visits, [node.id]: visits },
    };
    await options.onProgress?.(beforeNode);

    const result = await options.executeAgentNode(
      node,
      renderPrompt(node.prompt, beforeNode),
      { step: beforeNode.stepCount, visit: visits },
    );
    if (result.status === 'waiting_approval') {
      state = {
        ...beforeNode,
        status: 'waiting_approval',
        lastResult: { nodeId: node.id, ...result },
      };
      await options.onProgress?.(state);
      return state;
    }
    const afterNode: GraphCheckpoint = {
      ...beforeNode,
      stepCount: beforeNode.stepCount + 1,
      outputs: { ...beforeNode.outputs, [node.id]: result.output },
      lastResult: { nodeId: node.id, ...result },
    };
    const edge = selectEdge(definition, node.id, result);
    state = edge
      ? { ...afterNode, currentNodeId: edge.to }
      : {
          ...afterNode,
          status: result.status === 'succeeded' ? 'completed' : 'failed',
        };
    await options.onProgress?.(state);
  }
  return state;
}

function selectEdge(
  definition: GraphDefinition,
  nodeId: string,
  result: GraphNodeResult,
) {
  const matches = definition.edges
    .filter((edge) => edge.from === nodeId && edgeMatches(edge.when, result))
    .sort((left, right) => right.priority - left.priority);
  if (matches.length > 1 && matches[0].priority === matches[1].priority) {
    throw new Error(`Graph node ${nodeId} produced an ambiguous transition.`);
  }
  return matches[0];
}

function edgeMatches(
  when: GraphDefinition['edges'][number]['when'],
  result: GraphNodeResult,
) {
  if (when.type === 'always') return true;
  if (when.type === 'succeeded' || when.type === 'failed')
    return result.status === when.type;
  const output = when.caseSensitive
    ? result.output
    : result.output.toLowerCase();
  const value = when.caseSensitive ? when.value : when.value.toLowerCase();
  return when.type === 'output_contains'
    ? output.includes(value)
    : !output.includes(value);
}

export function renderPrompt(template: string, state: GraphCheckpoint): string {
  return template.replace(
    /\{\{(input|nodes\.([a-z][a-z0-9_-]{0,63})\.output)\}\}/g,
    (_match, key: string, nodeId?: string) => {
      if (key === 'input') return state.input;
      return state.outputs[nodeId ?? ''] ?? '';
    },
  );
}
