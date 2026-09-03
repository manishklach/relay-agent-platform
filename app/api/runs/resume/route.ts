import { env } from 'cloudflare:workers';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { z } from 'zod';

import { claimRunCheckpoint, loadRunCheckpoint } from '@/lib/run-checkpoints';
import { executeLeasedRun } from '@/lib/run-orchestrator';
import {
  DEFAULT_WORKSPACE_ID,
  getAgent,
  requireActor,
  writeAudit,
  type Actor,
} from '@/lib/server-data';

const resumeInput = z.object({
  runId: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(20).default(5),
});

export async function POST(request: NextRequest) {
  try {
    const actor = await requireActor(request, 'operator');
    const parsed = resumeInput.safeParse(await request.json());
    if (!parsed.success)
      return NextResponse.json(
        { error: 'Invalid resume request' },
        { status: 400 },
      );
    if (parsed.data.runId) {
      const result = await resumeRun(parsed.data.runId, actor);
      return NextResponse.json(result, {
        status: result.status === 'failed' ? 502 : 200,
      });
    }

    const available = await env.DB.prepare(
      `SELECT run_id FROM run_checkpoints
       WHERE workspace_id = ? AND (status = 'ready' OR (status = 'running' AND lease_expires_at <= ?))
       ORDER BY updated_at LIMIT ?`,
    )
      .bind(DEFAULT_WORKSPACE_ID, Date.now(), parsed.data.limit)
      .all<{ run_id: string }>();
    const runs: Array<Record<string, unknown>> = [];
    for (const item of available.results) {
      try {
        runs.push(await resumeRun(item.run_id, actor));
      } catch (error) {
        runs.push({
          id: item.run_id,
          status: 'skipped',
          error: error instanceof Error ? error.message : 'Resume failed',
        });
      }
    }
    return NextResponse.json({ runs });
  } catch (error) {
    return toResponse(error);
  }
}

async function resumeRun(runId: string, actor: Actor) {
  const run = await env.DB.prepare(
    `SELECT runs.id, runs.agent_id, runs.input, runs.status, runs.created_at,
      run_agent_versions.agent_version_id
     FROM runs LEFT JOIN run_agent_versions ON run_agent_versions.run_id = runs.id
     WHERE runs.id = ? AND runs.workspace_id = ?`,
  )
    .bind(runId, DEFAULT_WORKSPACE_ID)
    .first<Record<string, unknown>>();
  if (!run) throw new Response('Run not found', { status: 404 });
  if (run.status !== 'running')
    throw new Response('Only interrupted running runs can be resumed', {
      status: 409,
    });
  const agent = await getAgent(
    String(run.agent_id),
    typeof run.agent_version_id === 'string' ? run.agent_version_id : undefined,
  );
  if (!agent) throw new Response('Agent not found', { status: 404 });
  if (agent.status !== 'live')
    throw new Response('Agent is not live', { status: 409 });

  const leaseOwner = `resume_${crypto.randomUUID()}`;
  if (!(await claimRunCheckpoint(runId, DEFAULT_WORKSPACE_ID, leaseOwner))) {
    throw new Response('Run is actively leased or is not resumable', {
      status: 409,
    });
  }
  const stored = await loadRunCheckpoint(runId, DEFAULT_WORKSPACE_ID);
  const result = await executeLeasedRun({
    runId,
    workspaceId: DEFAULT_WORKSPACE_ID,
    agent,
    prompt: String(run.input),
    leaseOwner,
    checkpoint: stored.state,
  });
  await writeAudit(actor.id, 'run.resumed', 'run', runId, {
    fromCheckpointVersion: stored.version,
    status: result.status,
  });
  return result;
}

function toResponse(error: unknown) {
  if (error instanceof Response) return error;
  const message = error instanceof Error ? error.message : 'Unexpected error';
  return NextResponse.json(
    { error: message },
    { status: message.includes('not found') ? 404 : 500 },
  );
}
