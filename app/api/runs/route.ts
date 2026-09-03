import { env } from 'cloudflare:workers';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { z } from 'zod';

import { claimRunCheckpoint } from '@/lib/run-checkpoints';
import { createModelCheckpoint } from '@/lib/runtime-checkpoint';
import { executeLeasedRun } from '@/lib/run-orchestrator';
import {
  DEFAULT_WORKSPACE_ID,
  getAgent,
  requireActor,
  writeAudit,
} from '@/lib/server-data';

const runInput = z.object({
  agentId: z.string().min(1),
  input: z.string().trim().min(1).max(20000),
  defer: z.boolean().default(false),
});

export async function GET(request: NextRequest) {
  try {
    await requireActor(request);
    const result = await env.DB.prepare(
      `SELECT runs.*, agents.name AS agent_name, run_checkpoints.status AS checkpoint_status,
        run_checkpoints.version AS checkpoint_version, run_checkpoints.updated_at AS checkpoint_updated_at
       FROM runs JOIN agents ON agents.id = runs.agent_id
       LEFT JOIN run_checkpoints ON run_checkpoints.run_id = runs.id
       WHERE runs.workspace_id = ? ORDER BY runs.created_at DESC LIMIT 100`,
    )
      .bind(DEFAULT_WORKSPACE_ID)
      .all<Record<string, unknown>>();
    return NextResponse.json({ runs: result.results });
  } catch (error) {
    return toResponse(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const actor = await requireActor(request, 'operator');
    const parsed = runInput.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Invalid run request', issues: z.treeifyError(parsed.error) },
        { status: 400 },
      );
    }
    const agent = await getAgent(parsed.data.agentId);
    if (!agent)
      return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
    if (agent.status !== 'live') {
      return NextResponse.json(
        { error: 'Only live agents can execute' },
        { status: 409 },
      );
    }

    const runId = `run_${crypto.randomUUID()}`;
    const leaseOwner = `request_${crypto.randomUUID()}`;
    const startedAt = Date.now();
    const checkpoint = createModelCheckpoint(
      runId,
      parsed.data.input,
      startedAt,
    );
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO runs (
          id, workspace_id, agent_id, status, input, provider, model, created_by, created_at
        ) VALUES (?, ?, ?, 'running', ?, ?, ?, ?, ?)`,
      ).bind(
        runId,
        DEFAULT_WORKSPACE_ID,
        agent.id,
        parsed.data.input,
        agent.provider,
        agent.model,
        actor.id,
        startedAt,
      ),
      env.DB.prepare(
        `INSERT INTO run_checkpoints (
          run_id, workspace_id, status, state_json, version, created_at, updated_at
        ) VALUES (?, ?, 'ready', ?, 0, ?, ?)`,
      ).bind(
        runId,
        DEFAULT_WORKSPACE_ID,
        JSON.stringify(checkpoint),
        startedAt,
        startedAt,
      ),
    ]);
    if (parsed.data.defer) {
      await writeAudit(actor.id, 'run.queued', 'run', runId, {
        agentId: agent.id,
      });
      return NextResponse.json(
        {
          id: runId,
          agentId: agent.id,
          agentName: agent.name,
          input: parsed.data.input,
          status: 'running',
          checkpointStatus: 'ready',
          resumable: true,
          createdAt: startedAt,
        },
        { status: 202 },
      );
    }
    if (
      !(await claimRunCheckpoint(
        runId,
        DEFAULT_WORKSPACE_ID,
        leaseOwner,
        startedAt,
      ))
    ) {
      throw new Error('New run checkpoint could not be claimed.');
    }

    const result = await executeLeasedRun({
      runId,
      workspaceId: DEFAULT_WORKSPACE_ID,
      agent,
      prompt: parsed.data.input,
      leaseOwner,
      checkpoint,
    });
    await writeAudit(actor.id, 'run.executed', 'run', runId, {
      agentId: agent.id,
      status: result.status,
      checkpointed: true,
    });
    return NextResponse.json(result, {
      status: result.status === 'failed' ? 502 : 201,
    });
  } catch (error) {
    return toResponse(error);
  }
}

function toResponse(error: unknown) {
  if (error instanceof Response) return error;
  return NextResponse.json(
    { error: error instanceof Error ? error.message : 'Unexpected error' },
    { status: 500 },
  );
}
