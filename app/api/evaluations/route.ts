import { env } from 'cloudflare:workers';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { z } from 'zod';

import { DEFAULT_WORKSPACE_ID, getAgent, requireActor, writeAudit } from '@/lib/server-data';

const evaluationSuiteInput = z.object({
  agentId: z.string().min(1),
  name: z.string().trim().min(2).max(100),
  description: z.string().trim().min(8).max(400),
  cases: z.array(z.object({
    name: z.string().trim().min(2).max(120),
    input: z.string().trim().min(1).max(20000),
    graderType: z.enum(['contains', 'not_contains']),
    terms: z.array(z.string().trim().min(1)).min(1).max(20),
  })).min(1).max(100),
});

export async function GET(request: NextRequest) {
  try {
    await requireActor(request);
    const result = await env.DB.prepare(
      `SELECT evaluation_suites.id, evaluation_suites.agent_id, evaluation_suites.name,
        evaluation_suites.description, evaluation_suites.created_at,
        COUNT(evaluation_cases.id) AS case_count,
        (SELECT score FROM evaluation_runs WHERE evaluation_runs.suite_id = evaluation_suites.id ORDER BY created_at DESC LIMIT 1) AS latest_score
       FROM evaluation_suites LEFT JOIN evaluation_cases ON evaluation_cases.suite_id = evaluation_suites.id
       WHERE evaluation_suites.workspace_id = ? GROUP BY evaluation_suites.id ORDER BY evaluation_suites.created_at DESC`,
    ).bind(DEFAULT_WORKSPACE_ID).all();
    return NextResponse.json({ evaluations: result.results });
  } catch (error) {
    return toResponse(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const actor = await requireActor(request, 'builder');
    const parsed = evaluationSuiteInput.safeParse(await request.json());
    if (!parsed.success) return NextResponse.json({ error: 'Invalid evaluation suite', issues: z.treeifyError(parsed.error) }, { status: 400 });
    const agent = await getAgent(parsed.data.agentId);
    if (!agent) return NextResponse.json({ error: 'Agent not found' }, { status: 404 });

    const suiteId = `suite_${crypto.randomUUID()}`;
    const now = Date.now();
    const statements = [
      env.DB.prepare(
        `INSERT INTO evaluation_suites (id, workspace_id, agent_id, name, description, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).bind(suiteId, DEFAULT_WORKSPACE_ID, agent.id, parsed.data.name, parsed.data.description, now),
      ...parsed.data.cases.map((testCase) => env.DB.prepare(
        `INSERT INTO evaluation_cases (id, suite_id, name, input, expected_json, grader_type, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        `case_${crypto.randomUUID()}`, suiteId, testCase.name, testCase.input,
        JSON.stringify(testCase.graderType === 'contains' ? { contains: testCase.terms } : { notContains: testCase.terms }),
        testCase.graderType, now,
      )),
    ];
    await env.DB.batch(statements);
    await writeAudit(actor.id, 'evaluation_suite.created', 'evaluation_suite', suiteId, { agentId: agent.id, cases: parsed.data.cases.length });
    return NextResponse.json({ id: suiteId, ...parsed.data, createdAt: now }, { status: 201 });
  } catch (error) {
    return toResponse(error);
  }
}

function toResponse(error: unknown) {
  if (error instanceof Response) return error;
  return NextResponse.json({ error: error instanceof Error ? error.message : 'Unexpected error' }, { status: 500 });
}
