import { env } from 'cloudflare:workers';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { z } from 'zod';

import {
  createGraphCheckpoint,
  executeGraph,
  graphCheckpointSchema,
  graphDefinitionSchema,
  type GraphNodeResult,
} from '@/lib/graph';
import { claimRunCheckpoint, loadRunCheckpoint } from '@/lib/run-checkpoints';
import { executeLeasedRun } from '@/lib/run-orchestrator';
import { createModelCheckpoint } from '@/lib/runtime-checkpoint';
import {
  DEFAULT_WORKSPACE_ID,
  getAgent,
  requireActor,
  writeAudit,
} from '@/lib/server-data';

const graphRunInput = z
  .object({
    graphId: z.string().min(1).optional(),
    runId: z.string().min(1).optional(),
    input: z.string().min(1).max(100_000).optional(),
  })
  .strict()
  .refine((value) => value.runId || (value.graphId && value.input), {
    message: 'Provide runId to resume, or graphId and input to start.',
  });

const LEASE_DURATION_MS = 930_000;

export async function GET(request: NextRequest) {
  try {
    await requireActor(request);
    const result = await env.DB.prepare(
      `SELECT id, graph_id, graph_version_id, status, checkpoint_json, version,
        created_by, created_at, updated_at, finished_at
       FROM graph_runs WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 100`,
    )
      .bind(DEFAULT_WORKSPACE_ID)
      .all<Record<string, unknown>>();
    return NextResponse.json({
      graphRuns: result.results.map((row) => ({
        ...row,
        checkpoint_json: graphCheckpointSchema.parse(
          JSON.parse(String(row.checkpoint_json)),
        ),
      })),
    });
  } catch (error) {
    return toResponse(error);
  }
}

export async function POST(request: NextRequest) {
  let graphRunId: string | undefined;
  let leaseOwner: string | undefined;
  try {
    const actor = await requireActor(request, 'operator');
    const parsed = graphRunInput.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json(
        {
          error: 'Invalid graph run request',
          issues: z.treeifyError(parsed.error),
        },
        { status: 400 },
      );
    }

    graphRunId = parsed.data.runId;
    if (!graphRunId) {
      const graph = await env.DB.prepare(
        `SELECT graphs.id, graphs.status, graph_versions.id AS version_id,
          graph_versions.definition_json
         FROM graphs JOIN graph_versions
           ON graph_versions.graph_id = graphs.id AND graph_versions.status = 'active'
         WHERE graphs.id = ? AND graphs.workspace_id = ?`,
      )
        .bind(parsed.data.graphId, DEFAULT_WORKSPACE_ID)
        .first<Record<string, unknown>>();
      if (!graph)
        return NextResponse.json({ error: 'Graph not found' }, { status: 404 });
      if (graph.status !== 'live')
        return NextResponse.json(
          { error: 'Only live graphs can run' },
          { status: 409 },
        );
      const definition = graphDefinitionSchema.parse(
        JSON.parse(String(graph.definition_json)),
      );
      graphRunId = `graph_run_${crypto.randomUUID()}`;
      const now = Date.now();
      await env.DB.prepare(
        `INSERT INTO graph_runs (
          id, workspace_id, graph_id, graph_version_id, status, checkpoint_json,
          version, created_by, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'ready', ?, 0, ?, ?, ?)`,
      )
        .bind(
          graphRunId,
          DEFAULT_WORKSPACE_ID,
          graph.id,
          graph.version_id,
          JSON.stringify(createGraphCheckpoint(definition, parsed.data.input!)),
          actor.id,
          now,
          now,
        )
        .run();
    }

    leaseOwner = `graph_worker_${crypto.randomUUID()}`;
    const now = Date.now();
    const claimed = await env.DB.prepare(
      `UPDATE graph_runs SET status = 'running', lease_owner = ?, lease_expires_at = ?,
        updated_at = ?, version = version + 1
       WHERE id = ? AND workspace_id = ?
         AND status IN ('ready','running','waiting_approval')
         AND (lease_owner IS NULL OR lease_expires_at <= ?)`,
    )
      .bind(
        leaseOwner,
        now + LEASE_DURATION_MS,
        now,
        graphRunId,
        DEFAULT_WORKSPACE_ID,
        now,
      )
      .run();
    if (claimed.meta.changes !== 1) {
      return NextResponse.json(
        { error: 'Graph run is terminal or already leased' },
        { status: 409 },
      );
    }

    const stored = await env.DB.prepare(
      `SELECT graph_runs.*, graph_versions.definition_json
       FROM graph_runs JOIN graph_versions ON graph_versions.id = graph_runs.graph_version_id
       WHERE graph_runs.id = ? AND graph_runs.workspace_id = ?`,
    )
      .bind(graphRunId, DEFAULT_WORKSPACE_ID)
      .first<Record<string, unknown>>();
    if (!stored) throw new Error('Claimed graph run disappeared.');
    const definition = graphDefinitionSchema.parse(
      JSON.parse(String(stored.definition_json)),
    );
    const checkpoint = graphCheckpointSchema.parse(
      JSON.parse(String(stored.checkpoint_json)),
    );

    const result = await executeGraph({
      definition,
      checkpoint,
      executeAgentNode: (node, prompt, cursor) =>
        executeChildRun({
          graphRunId: graphRunId!,
          node,
          prompt,
          visit: cursor.visit,
          actorId: actor.id,
        }),
      onProgress: async (next) => {
        const progress = await env.DB.prepare(
          `UPDATE graph_runs SET status = ?, checkpoint_json = ?, version = version + 1,
            lease_expires_at = ?, updated_at = ?
           WHERE id = ? AND workspace_id = ? AND lease_owner = ?`,
        )
          .bind(
            next.status,
            JSON.stringify(next),
            Date.now() + LEASE_DURATION_MS,
            Date.now(),
            graphRunId,
            DEFAULT_WORKSPACE_ID,
            leaseOwner,
          )
          .run();
        if (progress.meta.changes !== 1)
          throw new Error('Graph run checkpoint lease was lost.');
      },
    });
    const finishedAt = Date.now();
    const terminal =
      result.status === 'completed' || result.status === 'failed';
    const finalized = await env.DB.prepare(
      `UPDATE graph_runs SET status = ?, checkpoint_json = ?, version = version + 1,
        lease_owner = NULL, lease_expires_at = NULL, updated_at = ?, finished_at = ?
       WHERE id = ? AND workspace_id = ? AND lease_owner = ?`,
    )
      .bind(
        result.status,
        JSON.stringify(result),
        finishedAt,
        terminal ? finishedAt : null,
        graphRunId,
        DEFAULT_WORKSPACE_ID,
        leaseOwner,
      )
      .run();
    if (finalized.meta.changes !== 1)
      throw new Error('Graph run lease was lost before finalization.');
    await writeAudit(actor.id, 'graph_run.executed', 'graph_run', graphRunId, {
      graphId: stored.graph_id,
      graphVersionId: stored.graph_version_id,
      status: result.status,
      steps: result.stepCount,
    });
    return NextResponse.json(
      { id: graphRunId, ...result },
      {
        status: result.status === 'waiting_approval' ? 202 : 200,
      },
    );
  } catch (error) {
    if (graphRunId && leaseOwner) {
      await env.DB.prepare(
        `UPDATE graph_runs SET status = 'failed', lease_owner = NULL, lease_expires_at = NULL,
          updated_at = ?, finished_at = ? WHERE id = ? AND workspace_id = ? AND lease_owner = ?`,
      )
        .bind(
          Date.now(),
          Date.now(),
          graphRunId,
          DEFAULT_WORKSPACE_ID,
          leaseOwner,
        )
        .run()
        .catch(() => undefined);
    }
    return toResponse(error);
  }
}

async function executeChildRun(input: {
  graphRunId: string;
  node: { id: string; agentId: string; agentVersionId?: string };
  prompt: string;
  visit: number;
  actorId: string;
}): Promise<GraphNodeResult> {
  const runId = `run_${input.graphRunId}_${input.node.id}_${input.visit}`;
  const agent = await getAgent(input.node.agentId, input.node.agentVersionId);
  if (!agent)
    return {
      status: 'failed',
      output: 'Pinned agent version was not found.',
      runId,
    };
  const startedAt = Date.now();
  const initialCheckpoint = createModelCheckpoint(
    runId,
    input.prompt,
    startedAt,
  );
  await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO runs (
        id, workspace_id, agent_id, status, input, provider, model, created_by, created_at
      ) VALUES (?, ?, ?, 'running', ?, ?, ?, ?, ?)`,
    ).bind(
      runId,
      DEFAULT_WORKSPACE_ID,
      agent.id,
      input.prompt,
      agent.provider,
      agent.model,
      input.actorId,
      startedAt,
    ),
    ...(agent.versionId
      ? [
          env.DB.prepare(
            `INSERT OR IGNORE INTO run_agent_versions (run_id, agent_version_id) VALUES (?, ?)`,
          ).bind(runId, agent.versionId),
        ]
      : []),
    env.DB.prepare(
      `INSERT OR IGNORE INTO run_checkpoints (
        run_id, workspace_id, status, state_json, version, created_at, updated_at
      ) VALUES (?, ?, 'ready', ?, 0, ?, ?)`,
    ).bind(
      runId,
      DEFAULT_WORKSPACE_ID,
      JSON.stringify(initialCheckpoint),
      startedAt,
      startedAt,
    ),
  ]);

  const existing = await env.DB.prepare(
    'SELECT status, output FROM runs WHERE id = ? AND workspace_id = ?',
  )
    .bind(runId, DEFAULT_WORKSPACE_ID)
    .first<{ status: string; output: string | null }>();
  if (!existing) throw new Error('Graph child run could not be created.');
  if (existing.status === 'succeeded' || existing.status === 'failed') {
    return { status: existing.status, output: existing.output ?? '', runId };
  }
  if (existing.status === 'waiting_approval') {
    return {
      status: 'waiting_approval',
      output: existing.output ?? 'Approval required.',
      runId,
    };
  }

  const childLeaseOwner = `graph_child_${crypto.randomUUID()}`;
  if (
    !(await claimRunCheckpoint(runId, DEFAULT_WORKSPACE_ID, childLeaseOwner))
  ) {
    return {
      status: 'waiting_approval',
      output: 'Child run is still executing.',
      runId,
    };
  }
  const stored = await loadRunCheckpoint(runId, DEFAULT_WORKSPACE_ID);
  const result = await executeLeasedRun({
    runId,
    workspaceId: DEFAULT_WORKSPACE_ID,
    agent,
    prompt: input.prompt,
    leaseOwner: childLeaseOwner,
    checkpoint: stored.state,
  });
  return { status: result.status, output: result.output, runId };
}

function toResponse(error: unknown) {
  if (error instanceof Response) return error;
  return NextResponse.json(
    { error: error instanceof Error ? error.message : 'Unexpected error' },
    { status: 500 },
  );
}
