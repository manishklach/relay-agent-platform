import { env } from 'cloudflare:workers';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { DEFAULT_WORKSPACE_ID, requireActor } from '@/lib/server-data';

export async function GET(request: NextRequest) {
  try {
    const actor = await requireActor(request);
    const [agents, tools, runs, approvals, evaluations, audit] = await Promise.all([
      env.DB.prepare(`SELECT id, name, description, provider, model, status, updated_at FROM agents WHERE workspace_id = ? ORDER BY updated_at DESC`).bind(DEFAULT_WORKSPACE_ID).all(),
      env.DB.prepare(`SELECT id, name, display_name, description, kind, approval_required, enabled FROM tools WHERE workspace_id = ? ORDER BY display_name`).bind(DEFAULT_WORKSPACE_ID).all(),
      env.DB.prepare(`SELECT runs.id, runs.agent_id, agents.name AS agent_name, runs.status, runs.input, runs.output, runs.latency_ms, runs.estimated_cost_usd, runs.created_at
        FROM runs JOIN agents ON agents.id = runs.agent_id WHERE runs.workspace_id = ? ORDER BY runs.created_at DESC LIMIT 20`).bind(DEFAULT_WORKSPACE_ID).all(),
      env.DB.prepare(`SELECT approvals.id, approvals.run_id, approvals.tool_name, approvals.arguments_json, approvals.status, approvals.requested_at, agents.name AS agent_name
        FROM approvals JOIN runs ON runs.id = approvals.run_id JOIN agents ON agents.id = runs.agent_id
        WHERE approvals.workspace_id = ? AND approvals.status = 'pending' ORDER BY approvals.requested_at DESC`).bind(DEFAULT_WORKSPACE_ID).all(),
      env.DB.prepare(`SELECT evaluation_suites.id, evaluation_suites.name, evaluation_suites.description,
        COUNT(evaluation_cases.id) AS case_count,
        (SELECT score FROM evaluation_runs WHERE evaluation_runs.suite_id = evaluation_suites.id ORDER BY created_at DESC LIMIT 1) AS latest_score
        FROM evaluation_suites LEFT JOIN evaluation_cases ON evaluation_cases.suite_id = evaluation_suites.id
        WHERE evaluation_suites.workspace_id = ? GROUP BY evaluation_suites.id`).bind(DEFAULT_WORKSPACE_ID).all(),
      env.DB.prepare(`SELECT action, target_type, target_id, created_at FROM audit_logs WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 12`).bind(DEFAULT_WORKSPACE_ID).all(),
    ]);

    const succeeded = runs.results.filter((run) => run.status === 'succeeded').length;
    const finished = runs.results.filter((run) => run.status !== 'running').length;
    const latencies = runs.results.map((run) => Number(run.latency_ms)).filter((value) => Number.isFinite(value) && value > 0).sort((a, b) => a - b);
    return NextResponse.json({
      actor,
      workspace: { id: DEFAULT_WORKSPACE_ID, name: 'Production workspace' },
      agents: agents.results,
      tools: tools.results,
      runs: runs.results,
      approvals: approvals.results,
      evaluations: evaluations.results,
      audit: audit.results,
      metrics: {
        totalRuns: runs.results.length,
        successRate: finished ? Math.round((succeeded / finished) * 1000) / 10 : 0,
        medianLatencyMs: latencies.length ? latencies[Math.floor(latencies.length / 2)] : 0,
        pendingApprovals: approvals.results.length,
      },
    });
  } catch (error) {
    if (error instanceof Response) return error;
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Unexpected error' }, { status: 500 });
  }
}
