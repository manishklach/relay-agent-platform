import { env } from 'cloudflare:workers';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { z } from 'zod';

import { executeAgent } from '@/lib/runtime';
import { DEFAULT_WORKSPACE_ID, getAgent, requireActor, writeAudit } from '@/lib/server-data';

const runInput = z.object({
  agentId: z.string().min(1),
  input: z.string().trim().min(1).max(20000),
});

export async function GET(request: NextRequest) {
  try {
    await requireActor(request);
    const result = await env.DB.prepare(
      `SELECT runs.*, agents.name AS agent_name
       FROM runs JOIN agents ON agents.id = runs.agent_id
       WHERE runs.workspace_id = ? ORDER BY runs.created_at DESC LIMIT 100`,
    ).bind(DEFAULT_WORKSPACE_ID).all<Record<string, unknown>>();
    return NextResponse.json({ runs: result.results });
  } catch (error) {
    return toResponse(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const actor = await requireActor(request, 'operator');
    const parsed = runInput.safeParse(await request.json());
    if (!parsed.success) return NextResponse.json({ error: 'Invalid run request', issues: z.treeifyError(parsed.error) }, { status: 400 });

    const agent = await getAgent(parsed.data.agentId);
    if (!agent) return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
    if (agent.status === 'paused') return NextResponse.json({ error: 'Agent is paused' }, { status: 409 });

    const runId = `run_${crypto.randomUUID()}`;
    const startedAt = Date.now();
    await env.DB.prepare(
      `INSERT INTO runs (
        id, workspace_id, agent_id, status, input, provider, model, created_by, created_at
      ) VALUES (?, ?, ?, 'running', ?, ?, ?, ?, ?)`,
    ).bind(runId, DEFAULT_WORKSPACE_ID, agent.id, parsed.data.input, agent.provider, agent.model, actor.id, startedAt).run();

    const result = await executeAgent(agent, parsed.data.input);
    const finishedAt = Date.now();
    const statements = result.steps.map((item) => env.DB.prepare(
      `INSERT INTO run_steps (
        id, run_id, sequence, kind, name, status, input_json, output_json, duration_ms, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      item.id, runId, item.sequence, item.kind, item.name, item.status,
      JSON.stringify(item.input), JSON.stringify(item.output), item.durationMs, finishedAt,
    ));

    statements.push(env.DB.prepare(
      `UPDATE runs SET status = ?, output = ?, latency_ms = ?, input_tokens = ?, output_tokens = ?,
        estimated_cost_usd = ?, error = ?, finished_at = ? WHERE id = ?`,
    ).bind(
      result.status, result.output, finishedAt - startedAt, result.inputTokens,
      result.outputTokens, result.estimatedCostUsd, result.error ?? null, finishedAt, runId,
    ));

    let approvalId: string | undefined;
    if (result.pendingApproval) {
      approvalId = `approval_${crypto.randomUUID()}`;
      statements.push(env.DB.prepare(
        `INSERT INTO approvals (
          id, workspace_id, run_id, tool_name, arguments_json, status, requested_at
        ) VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
      ).bind(
        approvalId, DEFAULT_WORKSPACE_ID, runId, result.pendingApproval.toolName,
        JSON.stringify(result.pendingApproval.arguments), finishedAt,
      ));
    }

    if (statements.length) await env.DB.batch(statements);
    await writeAudit(actor.id, 'run.executed', 'run', runId, { agentId: agent.id, status: result.status });
    return NextResponse.json({
      id: runId,
      agentId: agent.id,
      agentName: agent.name,
      input: parsed.data.input,
      ...result,
      approvalId,
      latencyMs: finishedAt - startedAt,
      createdAt: startedAt,
    }, { status: result.status === 'failed' ? 502 : 201 });
  } catch (error) {
    return toResponse(error);
  }
}

function toResponse(error: unknown) {
  if (error instanceof Response) return error;
  return NextResponse.json({ error: error instanceof Error ? error.message : 'Unexpected error' }, { status: 500 });
}
