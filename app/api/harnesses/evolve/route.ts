import { env } from 'cloudflare:workers';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { z } from 'zod';

import { assertOfficialCandidate } from '@/lib/harness-dev';
import {
  DEFAULT_WORKSPACE_ID,
  requireActor,
  writeAudit,
} from '@/lib/server-data';

const evolutionInput = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('start'),
      projectId: z.string().min(1),
      baselineVersionId: z.string().min(1),
    })
    .strict(),
  z
    .object({
      action: z.literal('declare_final'),
      projectId: z.string().min(1),
      harnessVersionId: z.string().min(1),
    })
    .strict(),
]);

export async function POST(request: NextRequest) {
  try {
    const actor = await requireActor(request, 'operator');
    const parsed = evolutionInput.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json(
        {
          error: 'Invalid evolution request',
          issues: z.treeifyError(parsed.error),
        },
        { status: 400 },
      );
    }
    const project = await env.DB.prepare(
      `SELECT * FROM harness_projects WHERE id = ? AND workspace_id = ?`,
    )
      .bind(parsed.data.projectId, DEFAULT_WORKSPACE_ID)
      .first<Record<string, unknown>>();
    if (!project)
      return NextResponse.json(
        { error: 'Harness project not found' },
        { status: 404 },
      );

    if (parsed.data.action === 'start') {
      if (project.status !== 'creation') {
        return NextResponse.json(
          { error: 'Project is not in creation' },
          { status: 409 },
        );
      }
      const baseline = await env.DB.prepare(
        `SELECT id, stage, status FROM harness_versions
         WHERE id = ? AND project_id = ?`,
      )
        .bind(parsed.data.baselineVersionId, parsed.data.projectId)
        .first<{ id: string; stage: string; status: string }>();
      if (
        !baseline ||
        baseline.stage !== 'creation' ||
        baseline.status !== 'frozen'
      ) {
        return NextResponse.json(
          {
            error:
              'Evolution requires a compliant frozen Creation harness as H0',
          },
          { status: 409 },
        );
      }
      const updated = await env.DB.prepare(
        `UPDATE harness_projects SET status = 'evolution', baseline_version_id = ?, updated_at = ?
         WHERE id = ? AND workspace_id = ? AND status = 'creation'`,
      )
        .bind(baseline.id, Date.now(), project.id, DEFAULT_WORKSPACE_ID)
        .run();
      if (updated.meta.changes !== 1)
        return NextResponse.json(
          { error: 'Evolution start conflict' },
          { status: 409 },
        );
      await writeAudit(
        actor.id,
        'harness.evolution_started',
        'harness_project',
        String(project.id),
        {
          baselineVersionId: baseline.id,
        },
      );
      return NextResponse.json({
        id: project.id,
        status: 'evolution',
        baselineVersionId: baseline.id,
        officialCandidateBudget: project.official_candidate_budget,
        probeBudgetPerRound: project.probe_budget_per_round,
      });
    }

    if (project.status !== 'evolution') {
      return NextResponse.json(
        { error: 'Project is not in evolution' },
        { status: 409 },
      );
    }
    const candidate = await env.DB.prepare(
      `SELECT id, stage, status, constraint_audit_json FROM harness_versions
       WHERE id = ? AND project_id = ?`,
    )
      .bind(parsed.data.harnessVersionId, parsed.data.projectId)
      .first<Record<string, unknown>>();
    if (
      !candidate ||
      candidate.stage !== 'evolution' ||
      candidate.status !== 'frozen'
    ) {
      return NextResponse.json(
        {
          error:
            'Final declaration requires a frozen post-H0 evolution version',
        },
        { status: 409 },
      );
    }
    const requiredBenchmarks = await feedbackBenchmarks(parsed.data.projectId);
    const evaluations = await env.DB.prepare(
      `SELECT benchmark, executor_mode, executor_config_json, metrics_json
       FROM harness_evaluations WHERE harness_version_id = ? AND split = 'feedback'
         AND lane = 'official' AND status = 'completed'`,
    )
      .bind(candidate.id)
      .all<Record<string, unknown>>();
    const completePair = findCompleteExecutorPair(
      evaluations.results,
      requiredBenchmarks,
    );
    if (!completePair) {
      return NextResponse.json(
        {
          error: `Candidate lacks a complete same-executor feedback set: ${requiredBenchmarks.join(', ')}`,
        },
        { status: 409 },
      );
    }
    const audit = JSON.parse(String(candidate.constraint_audit_json)) as {
      compliant?: boolean;
    };
    assertOfficialCandidate({
      harnessVersionId: String(candidate.id),
      completeBenchmarks: completePair.benchmarks,
      requiredBenchmarks,
      constraintCompliant: audit.compliant === true,
      capabilityScore: completePair.capabilityScore,
      executorTokensMean: completePair.executorTokensMean,
    });
    const officialVersions = await countOfficialVersions(parsed.data.projectId);
    if (officialVersions > Number(project.official_candidate_budget)) {
      return NextResponse.json(
        { error: 'Official candidate budget exceeded' },
        { status: 409 },
      );
    }
    const now = Date.now();
    const results = await env.DB.batch([
      env.DB.prepare(
        `UPDATE harness_versions SET status = 'declared'
         WHERE id = ? AND project_id = ? AND status = 'frozen'`,
      ).bind(candidate.id, project.id),
      env.DB.prepare(
        `UPDATE harness_projects SET status = 'completed', final_version_id = ?,
          official_candidates_used = ?, updated_at = ?
         WHERE id = ? AND workspace_id = ? AND status = 'evolution'`,
      ).bind(
        candidate.id,
        officialVersions,
        now,
        project.id,
        DEFAULT_WORKSPACE_ID,
      ),
    ]);
    if (results.some((result) => result.meta.changes !== 1)) {
      return NextResponse.json(
        { error: 'Final declaration conflict' },
        { status: 409 },
      );
    }
    await writeAudit(
      actor.id,
      'harness.final_declared',
      'harness_project',
      String(project.id),
      {
        harnessVersionId: candidate.id,
        executorMode: completePair.executorMode,
        capabilityScore: completePair.capabilityScore,
        executorTokensMean: completePair.executorTokensMean,
        officialCandidatesUsed: officialVersions,
      },
    );
    return NextResponse.json({
      id: project.id,
      status: 'completed',
      finalVersionId: candidate.id,
      officialCandidatesUsed: officialVersions,
      feedbackMetrics: {
        capabilityScore: completePair.capabilityScore,
        executorTokensMean: completePair.executorTokensMean,
        benchmarks: completePair.benchmarks,
      },
      heldoutStatus: 'eligible_sealed_evaluation',
    });
  } catch (error) {
    return toResponse(error);
  }
}

async function feedbackBenchmarks(projectId: string): Promise<string[]> {
  const result = await env.DB.prepare(
    `SELECT DISTINCT benchmark FROM harness_cases WHERE project_id = ? AND split = 'feedback'
     ORDER BY benchmark`,
  )
    .bind(projectId)
    .all<{ benchmark: string }>();
  return result.results.map((item) => item.benchmark);
}

function findCompleteExecutorPair(
  rows: Record<string, unknown>[],
  required: string[],
) {
  const groups = new Map<string, Record<string, unknown>[]>();
  for (const row of rows) {
    const key = `${String(row.executor_mode)}:${String(row.executor_config_json)}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  for (const [key, items] of groups) {
    const latest = new Map<string, Record<string, unknown>>();
    for (const item of items) latest.set(String(item.benchmark), item);
    if (!required.every((benchmark) => latest.has(benchmark))) continue;
    const metrics = required.map(
      (benchmark) =>
        JSON.parse(String(latest.get(benchmark)?.metrics_json)) as {
          capabilityScore: number;
          executorTokensMean: number;
        },
    );
    return {
      executorMode: key.split(':', 1)[0],
      benchmarks: required,
      capabilityScore: average(metrics.map((item) => item.capabilityScore)),
      executorTokensMean: average(
        metrics.map((item) => item.executorTokensMean),
      ),
    };
  }
  return null;
}

async function countOfficialVersions(projectId: string) {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS count FROM harness_versions
     WHERE project_id = ? AND stage = 'evolution' AND official_submitted = 1`,
  )
    .bind(projectId)
    .first<{ count: number }>();
  return Number(row?.count ?? 0);
}

function average(values: number[]) {
  return values.length
    ? Math.round(
        (values.reduce((sum, value) => sum + value, 0) / values.length) * 1_000,
      ) / 1_000
    : 0;
}

function toResponse(error: unknown) {
  if (error instanceof Response) return error;
  return NextResponse.json(
    { error: error instanceof Error ? error.message : 'Unexpected error' },
    { status: 500 },
  );
}
