import { env } from 'cloudflare:workers';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { z } from 'zod';

import { executeAgent } from '@/lib/runtime';
import { getAgent, parseJson, requireActor, writeAudit } from '@/lib/server-data';
import { defaultGraderRegistry } from '@/lib/graders';

const evaluationInput = z.object({ suiteId: z.string().min(1) });

export async function POST(request: NextRequest) {
  try {
    const actor = await requireActor(request, 'operator');
    const parsed = evaluationInput.safeParse(await request.json());
    if (!parsed.success) return NextResponse.json({ error: 'Invalid evaluation request' }, { status: 400 });

    const suite = await env.DB.prepare(
      'SELECT id, agent_id, name FROM evaluation_suites WHERE id = ?',
    ).bind(parsed.data.suiteId).first<Record<string, unknown>>();
    if (!suite) return NextResponse.json({ error: 'Evaluation suite not found' }, { status: 404 });
    const agent = await getAgent(String(suite.agent_id));
    if (!agent) return NextResponse.json({ error: 'Suite agent not found' }, { status: 404 });

    const cases = await env.DB.prepare(
      'SELECT id, name, input, expected_json, grader_type FROM evaluation_cases WHERE suite_id = ? ORDER BY created_at',
    ).bind(parsed.data.suiteId).all<Record<string, unknown>>();
    const evaluationRunId = `eval_${crypto.randomUUID()}`;
    const startedAt = Date.now();
    await env.DB.prepare(
      `INSERT INTO evaluation_runs (id, suite_id, status, created_by, created_at) VALUES (?, ?, 'running', ?, ?)`,
    ).bind(evaluationRunId, parsed.data.suiteId, actor.id, startedAt).run();

    const details: Array<Record<string, unknown>> = [];
    for (const testCase of cases.results) {
      const result = await executeAgent(agent, String(testCase.input));
      const expected = parseJson<Record<string, unknown>>(testCase.expected_json, {});
      const graderType = String(testCase.grader_type);
      const grade = await defaultGraderRegistry.grade(graderType, { output: result.output, expected });
      details.push({
        caseId: testCase.id,
        name: testCase.name,
        passed: grade.passed,
        graderType,
        graderScore: grade.score,
        graderReason: grade.reason,
        output: result.output,
        status: result.status,
        latencyMs: result.steps.reduce((sum, item) => sum + item.durationMs, 0),
      });
    }

    const passed = details.filter((item) => item.passed).length;
    const total = details.length;
    const score = total ? Math.round((passed / total) * 1000) / 10 : 0;
    const finishedAt = Date.now();
    await env.DB.prepare(
      `UPDATE evaluation_runs SET status = 'completed', passed = ?, total = ?, score = ?, details_json = ?, finished_at = ? WHERE id = ?`,
    ).bind(passed, total, score, JSON.stringify(details), finishedAt, evaluationRunId).run();
    await writeAudit(actor.id, 'evaluation.completed', 'evaluation_run', evaluationRunId, { suiteId: parsed.data.suiteId, score });
    return NextResponse.json({ id: evaluationRunId, suiteId: parsed.data.suiteId, suiteName: suite.name, passed, total, score, details, latencyMs: finishedAt - startedAt }, { status: 201 });
  } catch (error) {
    if (error instanceof Response) return error;
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Unexpected error' }, { status: 500 });
  }
}
