import { env } from 'cloudflare:workers';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { z } from 'zod';

import { applyAgentVersion } from '@/lib/agent-version';
import { defaultGraderRegistry } from '@/lib/graders';
import { executeAgent } from '@/lib/runtime';
import {
  DEFAULT_WORKSPACE_ID,
  getAgent,
  parseJson,
  requireActor,
  writeAudit,
} from '@/lib/server-data';

const inputSchema = z.object({ proposalId: z.string().min(1) }).strict();

export async function POST(request: NextRequest) {
  let evaluationRunId: string | undefined;
  let proposalId: string | undefined;
  try {
    const actor = await requireActor(request, 'operator');
    const parsed = inputSchema.safeParse(await request.json());
    if (!parsed.success)
      return NextResponse.json(
        { error: 'Invalid evaluation request' },
        { status: 400 },
      );

    const proposal = await env.DB.prepare(
      `SELECT improvement_proposals.*, agent_versions.config_json
       FROM improvement_proposals
       JOIN agent_versions ON agent_versions.id = improvement_proposals.candidate_version_id
       WHERE improvement_proposals.id = ? AND improvement_proposals.workspace_id = ?`,
    )
      .bind(parsed.data.proposalId, DEFAULT_WORKSPACE_ID)
      .first<Record<string, unknown>>();
    if (!proposal)
      return NextResponse.json(
        { error: 'Improvement proposal not found' },
        { status: 404 },
      );
    proposalId = String(proposal.id);
    if (proposal.status !== 'pending_evaluation') {
      return NextResponse.json(
        { error: 'Proposal is not pending evaluation' },
        { status: 409 },
      );
    }
    const baseAgent = await getAgent(String(proposal.agent_id));
    if (!baseAgent)
      return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
    const candidate = applyAgentVersion(
      baseAgent,
      parseJson(proposal.config_json, null),
    );
    const cases = await env.DB.prepare(
      `SELECT id, name, input, expected_json, grader_type FROM evaluation_cases
       WHERE suite_id = ? ORDER BY created_at`,
    )
      .bind(proposal.evaluation_suite_id)
      .all<Record<string, unknown>>();
    if (cases.results.length === 0) {
      return NextResponse.json(
        { error: 'Evaluation suite has no cases' },
        { status: 409 },
      );
    }

    evaluationRunId = `eval_${crypto.randomUUID()}`;
    const startedAt = Date.now();
    await env.DB.prepare(
      `INSERT INTO evaluation_runs (id, suite_id, status, created_by, created_at)
       VALUES (?, ?, 'running', ?, ?)`,
    )
      .bind(evaluationRunId, proposal.evaluation_suite_id, actor.id, startedAt)
      .run();
    const claimed = await env.DB.prepare(
      `UPDATE improvement_proposals SET evaluation_run_id = ?
       WHERE id = ? AND workspace_id = ? AND status = 'pending_evaluation'
         AND evaluation_run_id IS NULL`,
    )
      .bind(evaluationRunId, proposal.id, DEFAULT_WORKSPACE_ID)
      .run();
    if (claimed.meta.changes !== 1) {
      await env.DB.prepare(
        `UPDATE evaluation_runs SET status = 'failed', finished_at = ? WHERE id = ?`,
      )
        .bind(Date.now(), evaluationRunId)
        .run();
      return NextResponse.json(
        { error: 'Proposal evaluation is already claimed' },
        { status: 409 },
      );
    }

    const details: Array<Record<string, unknown>> = [];
    for (const testCase of cases.results) {
      const result = await executeAgent(candidate, String(testCase.input));
      const expected = parseJson<Record<string, unknown>>(
        testCase.expected_json,
        {},
      );
      const graderType = String(testCase.grader_type);
      const grade = await defaultGraderRegistry.grade(graderType, {
        output: result.output,
        expected,
      });
      details.push({
        caseId: testCase.id,
        name: testCase.name,
        passed: grade.passed,
        graderType,
        graderScore: grade.score,
        graderReason: grade.reason,
        output: result.output,
        status: result.status,
      });
    }

    const passed = details.filter((item) => item.passed).length;
    const total = details.length;
    const score = Math.round((passed / total) * 1_000) / 10;
    const minimumScore = Number(proposal.minimum_score);
    const status = score >= minimumScore ? 'awaiting_approval' : 'rejected';
    const finishedAt = Date.now();
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE evaluation_runs SET status = 'completed', passed = ?, total = ?, score = ?,
          details_json = ?, finished_at = ? WHERE id = ? AND status = 'running'`,
      ).bind(
        passed,
        total,
        score,
        JSON.stringify(details),
        finishedAt,
        evaluationRunId,
      ),
      env.DB.prepare(
        `UPDATE improvement_proposals SET score = ?, status = ?
         WHERE id = ? AND workspace_id = ? AND status = 'pending_evaluation'
           AND evaluation_run_id = ?`,
      ).bind(score, status, proposal.id, DEFAULT_WORKSPACE_ID, evaluationRunId),
    ]);
    await writeAudit(
      actor.id,
      'improvement.evaluated',
      'improvement_proposal',
      String(proposal.id),
      {
        evaluationRunId,
        score,
        minimumScore,
        status,
      },
    );
    return NextResponse.json({
      id: proposal.id,
      evaluationRunId,
      status,
      score,
      minimumScore,
      passed,
      total,
      details,
    });
  } catch (error) {
    if (evaluationRunId) {
      await env.DB.prepare(
        `UPDATE evaluation_runs SET status = 'failed', finished_at = ? WHERE id = ? AND status = 'running'`,
      )
        .bind(Date.now(), evaluationRunId)
        .run()
        .catch(() => undefined);
      if (proposalId) {
        await env.DB.prepare(
          `UPDATE improvement_proposals SET evaluation_run_id = NULL
           WHERE id = ? AND evaluation_run_id = ? AND status = 'pending_evaluation'
             AND workspace_id = ?`,
        )
          .bind(proposalId, evaluationRunId, DEFAULT_WORKSPACE_ID)
          .run()
          .catch(() => undefined);
      }
    }
    if (error instanceof Response) return error;
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Unexpected error' },
      { status: 500 },
    );
  }
}
