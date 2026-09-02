import { env } from 'cloudflare:workers';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { z } from 'zod';

import { DEFAULT_WORKSPACE_ID, requireActor, writeAudit } from '@/lib/server-data';
import { executeRuntimeTool, loadRuntimeTools } from '@/lib/tools';

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
       WHERE approvals.status = 'pending'
       ORDER BY approvals.requested_at DESC`,
    ).all<Record<string, unknown>>();
    return NextResponse.json({ approvals: result.results });
  } catch (error) {
    return toResponse(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const actor = await requireActor(request, 'operator');
    const parsed = decisionInput.safeParse(await request.json());
    if (!parsed.success) return NextResponse.json({ error: 'Invalid approval decision' }, { status: 400 });

    const approval = await env.DB.prepare(
      `SELECT id, run_id, tool_name, arguments_json, status FROM approvals WHERE id = ?`,
    ).bind(parsed.data.approvalId).first<Record<string, unknown>>();
    if (!approval) return NextResponse.json({ error: 'Approval not found' }, { status: 404 });
    if (approval.status !== 'pending') return NextResponse.json({ error: 'Approval has already been decided' }, { status: 409 });

    const now = Date.now();
    const runId = String(approval.run_id);
    let toolResult: Record<string, unknown> = { rejected: true };
    if (parsed.data.decision === 'approved') {
      const [tool] = await loadRuntimeTools(DEFAULT_WORKSPACE_ID, [String(approval.tool_name)]);
      if (!tool) return NextResponse.json({ error: 'Approved tool is no longer available' }, { status: 409 });
      toolResult = await executeRuntimeTool(tool, JSON.parse(String(approval.arguments_json)) as Record<string, unknown>);
    }

    await env.DB.batch([
      env.DB.prepare(
        `UPDATE approvals SET status = ?, decided_at = ?, decided_by = ? WHERE id = ?`,
      ).bind(parsed.data.decision, now, actor.id, parsed.data.approvalId),
      env.DB.prepare(
        `INSERT INTO run_steps (
          id, run_id, sequence, kind, name, status, input_json, output_json, duration_ms, created_at
        ) VALUES (?, ?, (SELECT COALESCE(MAX(sequence), -1) + 1 FROM run_steps WHERE run_id = ?),
          'tool', ?, ?, ?, ?, 1, ?)`,
      ).bind(
        crypto.randomUUID(), runId, runId, String(approval.tool_name),
        parsed.data.decision === 'approved' ? 'succeeded' : 'blocked',
        String(approval.arguments_json), JSON.stringify(toolResult), now,
      ),
      env.DB.prepare(
        `UPDATE runs SET status = ?, output = ?, finished_at = ? WHERE id = ?`,
      ).bind(
        'succeeded',
        parsed.data.decision === 'approved'
          ? `Approved action completed. Reference: ${typeof toolResult.reference === 'string' ? toolResult.reference : 'recorded'}`
          : 'The requested action was rejected by an operator.',
        now,
        runId,
      ),
    ]);
    await writeAudit(actor.id, `approval.${parsed.data.decision}`, 'approval', parsed.data.approvalId, { runId });
    return NextResponse.json({ approvalId: parsed.data.approvalId, status: parsed.data.decision, result: toolResult });
  } catch (error) {
    return toResponse(error);
  }
}

function toResponse(error: unknown) {
  if (error instanceof Response) return error;
  return NextResponse.json({ error: error instanceof Error ? error.message : 'Unexpected error' }, { status: 500 });
}
