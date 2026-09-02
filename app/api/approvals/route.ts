import { env } from 'cloudflare:workers';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { z } from 'zod';

import {
  DEFAULT_WORKSPACE_ID,
  requireActor,
  writeAudit,
} from '@/lib/server-data';
import { transitionApproval } from '@/lib/approvals';
import { processToolExecution } from '@/lib/tool-executions';
import { loadRuntimeTools, supportsIdempotentExecution } from '@/lib/tools';

const decisionInput = z.object({
  approvalId: z.string().min(1),
  decision: z.enum(['approved', 'rejected']),
});

export async function GET(request: NextRequest) {
  try {
    await requireActor(request);
    const result = await env.DB.prepare(
      `SELECT approvals.*, runs.input, agents.name AS agent_name
       FROM approvals
       JOIN runs ON runs.id = approvals.run_id
       JOIN agents ON agents.id = runs.agent_id
       WHERE approvals.workspace_id = ? AND approvals.status = 'pending'
       ORDER BY approvals.requested_at DESC`,
    )
      .bind(DEFAULT_WORKSPACE_ID)
      .all<Record<string, unknown>>();
    return NextResponse.json({ approvals: result.results });
  } catch (error) {
    return toResponse(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const actor = await requireActor(request, 'operator');
    const parsed = decisionInput.safeParse(await request.json());
    if (!parsed.success)
      return NextResponse.json(
        { error: 'Invalid approval decision' },
        { status: 400 },
      );

    const approval = await env.DB.prepare(
      `SELECT id, run_id, tool_name, arguments_json, status FROM approvals
       WHERE id = ? AND workspace_id = ?`,
    )
      .bind(parsed.data.approvalId, DEFAULT_WORKSPACE_ID)
      .first<Record<string, unknown>>();
    if (!approval)
      return NextResponse.json(
        { error: 'Approval not found' },
        { status: 404 },
      );
    if (approval.status !== 'pending')
      return NextResponse.json(
        { error: 'Approval has already been decided' },
        { status: 409 },
      );

    const now = Date.now();
    const runId = String(approval.run_id);
    const transition = transitionApproval('pending', parsed.data.decision);
    if (!transition.executeTool) {
      const results = await env.DB.batch([
        env.DB.prepare(
          `UPDATE approvals SET status = 'rejected', decided_at = ?, decided_by = ?
           WHERE id = ? AND workspace_id = ? AND status = 'pending'`,
        ).bind(now, actor.id, parsed.data.approvalId, DEFAULT_WORKSPACE_ID),
        env.DB.prepare(
          `INSERT OR IGNORE INTO run_steps (
          id, run_id, sequence, kind, name, status, input_json, output_json, duration_ms, created_at
        ) SELECT ?, ?, (SELECT COALESCE(MAX(sequence), -1) + 1 FROM run_steps WHERE run_id = ?),
          'tool', ?, 'blocked', ?, '{"rejected":true}', 1, ?
          WHERE EXISTS (SELECT 1 FROM approvals
            WHERE id = ? AND workspace_id = ? AND status = 'rejected' AND decided_by = ? AND decided_at = ?)`,
        ).bind(
          `approval_step_${parsed.data.approvalId}`,
          runId,
          runId,
          String(approval.tool_name),
          String(approval.arguments_json),
          now,
          parsed.data.approvalId,
          DEFAULT_WORKSPACE_ID,
          actor.id,
          now,
        ),
        env.DB.prepare(
          `UPDATE runs SET status = 'succeeded', output = ?, error = NULL, finished_at = ?
           WHERE id = ? AND EXISTS (SELECT 1 FROM approvals
             WHERE id = ? AND workspace_id = ? AND status = 'rejected' AND decided_by = ? AND decided_at = ?)`,
        ).bind(
          'The requested action was rejected by an operator.',
          now,
          runId,
          parsed.data.approvalId,
          DEFAULT_WORKSPACE_ID,
          actor.id,
          now,
        ),
      ]);
      if (results[0]?.meta.changes !== 1) {
        return NextResponse.json(
          { error: 'Approval has already been decided' },
          { status: 409 },
        );
      }
      await writeAudit(
        actor.id,
        'approval.rejected',
        'approval',
        parsed.data.approvalId,
        { runId },
      );
      return NextResponse.json({
        approvalId: parsed.data.approvalId,
        status: 'rejected',
        result: { rejected: true },
      });
    }

    const [tool] = await loadRuntimeTools(DEFAULT_WORKSPACE_ID, [
      String(approval.tool_name),
    ]);
    if (!tool)
      return NextResponse.json(
        { error: 'Approved tool is no longer available' },
        { status: 409 },
      );
    const executionId = `execution_${crypto.randomUUID()}`;
    const idempotencyKey = `approval:${parsed.data.approvalId}`;
    const retrySafe = supportsIdempotentExecution(tool);
    const results = await env.DB.batch([
      env.DB.prepare(
        `UPDATE approvals SET status = 'approved', decided_at = ?, decided_by = ?
         WHERE id = ? AND workspace_id = ? AND status = 'pending'`,
      ).bind(now, actor.id, parsed.data.approvalId, DEFAULT_WORKSPACE_ID),
      env.DB.prepare(
        `INSERT OR IGNORE INTO tool_executions (
          id, workspace_id, run_id, approval_id, tool_name, arguments_json, idempotency_key,
          retry_safe, status, attempts, max_attempts, next_attempt_at, created_at, updated_at
        ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, 3, ?, ?, ?
          WHERE EXISTS (SELECT 1 FROM approvals WHERE id = ? AND workspace_id = ? AND status = 'approved')`,
      ).bind(
        executionId,
        DEFAULT_WORKSPACE_ID,
        runId,
        parsed.data.approvalId,
        String(approval.tool_name),
        String(approval.arguments_json),
        idempotencyKey,
        retrySafe ? 1 : 0,
        now,
        now,
        now,
        parsed.data.approvalId,
        DEFAULT_WORKSPACE_ID,
      ),
      env.DB.prepare(
        `UPDATE runs SET status = 'running', output = ?, error = NULL, finished_at = NULL
         WHERE id = ? AND EXISTS (SELECT 1 FROM tool_executions
           WHERE approval_id = ? AND workspace_id = ? AND status = 'queued')`,
      ).bind(
        'Approved action queued for durable execution.',
        runId,
        parsed.data.approvalId,
        DEFAULT_WORKSPACE_ID,
      ),
    ]);
    if (results[0]?.meta.changes !== 1) {
      return NextResponse.json(
        { error: 'Approval has already been decided' },
        { status: 409 },
      );
    }

    await writeAudit(
      actor.id,
      'approval.approved',
      'approval',
      parsed.data.approvalId,
      {
        runId,
        executionId,
        retrySafe,
      },
    );
    const execution = await processToolExecution(
      executionId,
      DEFAULT_WORKSPACE_ID,
    );
    return NextResponse.json(
      { approvalId: parsed.data.approvalId, status: 'approved', execution },
      { status: execution.status === 'succeeded' ? 200 : 202 },
    );
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
