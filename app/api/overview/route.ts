import { env } from 'cloudflare:workers';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { DEFAULT_WORKSPACE_ID, requireActor } from '@/lib/server-data';

export async function GET(request: NextRequest) {
  try {
    const actor = await requireActor(request);
    const [
      agents,
      tools,
      runs,
      approvals,
      evaluations,
      audit,
      executions,
      checkpoints,
      graphHealth,
      improvementHealth,
    ] = await Promise.all([
      env.DB.prepare(
        `SELECT id, name, description, provider, model, status, updated_at FROM agents WHERE workspace_id = ? ORDER BY updated_at DESC`,
      )
        .bind(DEFAULT_WORKSPACE_ID)
        .all(),
      env.DB.prepare(
        `SELECT id, name, display_name, description, kind, approval_required, enabled FROM tools WHERE workspace_id = ? ORDER BY display_name`,
      )
        .bind(DEFAULT_WORKSPACE_ID)
        .all(),
      env.DB.prepare(`SELECT runs.id, runs.agent_id, agents.name AS agent_name,
        run_agent_versions.agent_version_id, agent_versions.version AS agent_version,
        runs.status, runs.input, runs.output, runs.latency_ms, runs.estimated_cost_usd, runs.created_at
        FROM runs JOIN agents ON agents.id = runs.agent_id
        LEFT JOIN run_agent_versions ON run_agent_versions.run_id = runs.id
        LEFT JOIN agent_versions ON agent_versions.id = run_agent_versions.agent_version_id
        WHERE runs.workspace_id = ? ORDER BY runs.created_at DESC LIMIT 20`)
        .bind(DEFAULT_WORKSPACE_ID)
        .all(),
      env.DB.prepare(`SELECT approvals.id, approvals.run_id, approvals.tool_name, approvals.arguments_json, approvals.status, approvals.requested_at, agents.name AS agent_name
        FROM approvals JOIN runs ON runs.id = approvals.run_id JOIN agents ON agents.id = runs.agent_id
        WHERE approvals.workspace_id = ? AND approvals.status = 'pending' ORDER BY approvals.requested_at DESC`)
        .bind(DEFAULT_WORKSPACE_ID)
        .all(),
      env.DB.prepare(`SELECT evaluation_suites.id, evaluation_suites.name, evaluation_suites.description,
        COUNT(evaluation_cases.id) AS case_count,
        (SELECT score FROM evaluation_runs WHERE evaluation_runs.suite_id = evaluation_suites.id ORDER BY created_at DESC LIMIT 1) AS latest_score
        FROM evaluation_suites LEFT JOIN evaluation_cases ON evaluation_cases.suite_id = evaluation_suites.id
        WHERE evaluation_suites.workspace_id = ? GROUP BY evaluation_suites.id`)
        .bind(DEFAULT_WORKSPACE_ID)
        .all(),
      env.DB.prepare(
        `SELECT action, target_type, target_id, created_at FROM audit_logs WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 12`,
      )
        .bind(DEFAULT_WORKSPACE_ID)
        .all(),
      env.DB.prepare(
        `SELECT status, COUNT(*) AS count FROM tool_executions WHERE workspace_id = ? GROUP BY status`,
      )
        .bind(DEFAULT_WORKSPACE_ID)
        .all(),
      env.DB.prepare(
        `SELECT
            SUM(CASE WHEN status = 'ready' THEN 1 ELSE 0 END) AS ready_count,
            SUM(CASE WHEN status = 'running' AND lease_expires_at <= ? THEN 1 ELSE 0 END) AS expired_count
           FROM run_checkpoints WHERE workspace_id = ?`,
      )
        .bind(Date.now(), DEFAULT_WORKSPACE_ID)
        .first<Record<string, unknown>>(),
      env.DB.prepare(
        `SELECT
          SUM(CASE WHEN status = 'ready' THEN 1 ELSE 0 END) AS ready_count,
          SUM(CASE WHEN status = 'waiting_approval' THEN 1 ELSE 0 END) AS waiting_count,
          SUM(CASE WHEN status = 'running' AND lease_expires_at <= ? THEN 1 ELSE 0 END) AS expired_count
         FROM graph_runs WHERE workspace_id = ?`,
      )
        .bind(Date.now(), DEFAULT_WORKSPACE_ID)
        .first<Record<string, unknown>>(),
      env.DB.prepare(
        `SELECT
          SUM(CASE WHEN status = 'pending_evaluation' THEN 1 ELSE 0 END) AS pending_evaluation_count,
          SUM(CASE WHEN status = 'awaiting_approval' THEN 1 ELSE 0 END) AS awaiting_approval_count,
          SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END) AS approved_count
         FROM improvement_proposals WHERE workspace_id = ?`,
      )
        .bind(DEFAULT_WORKSPACE_ID)
        .first<Record<string, unknown>>(),
    ]);

    const succeeded = runs.results.filter(
      (run) => run.status === 'succeeded',
    ).length;
    const finished = runs.results.filter(
      (run) => run.status !== 'running',
    ).length;
    const latencies = runs.results
      .map((run) => Number(run.latency_ms))
      .filter((value) => Number.isFinite(value) && value > 0)
      .sort((a, b) => a - b);
    const executionCounts = Object.fromEntries(
      executions.results.map((item) => [
        String(item.status),
        Number(item.count),
      ]),
    );
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
        successRate: finished
          ? Math.round((succeeded / finished) * 1000) / 10
          : 0,
        medianLatencyMs: latencies.length
          ? latencies[Math.floor(latencies.length / 2)]
          : 0,
        pendingApprovals: approvals.results.length,
        queuedToolExecutions:
          (executionCounts.queued ?? 0) +
          (executionCounts.retry_scheduled ?? 0),
        toolExecutionsNeedingAttention:
          (executionCounts.dead_letter ?? 0) + (executionCounts.unknown ?? 0),
        resumableRunsReady: Number(checkpoints?.ready_count ?? 0),
        expiredRunLeases: Number(checkpoints?.expired_count ?? 0),
        resumableGraphRunsReady: Number(graphHealth?.ready_count ?? 0),
        graphRunsWaitingApproval: Number(graphHealth?.waiting_count ?? 0),
        expiredGraphRunLeases: Number(graphHealth?.expired_count ?? 0),
        improvementsPendingEvaluation: Number(
          improvementHealth?.pending_evaluation_count ?? 0,
        ),
        improvementsAwaitingApproval: Number(
          improvementHealth?.awaiting_approval_count ?? 0,
        ),
        approvedImprovementsNotActivated: Number(
          improvementHealth?.approved_count ?? 0,
        ),
      },
    });
  } catch (error) {
    if (error instanceof Response) return error;
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Unexpected error' },
      { status: 500 },
    );
  }
}
