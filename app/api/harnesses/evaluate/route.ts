import { env } from 'cloudflare:workers';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { z } from 'zod';

import { harnessArtifactSchema } from '@/lib/harness-dev';
import {
  executeHarnessEvaluation,
  executorConfigSchema,
} from '@/lib/harness-runner';
import {
  DEFAULT_WORKSPACE_ID,
  parseJson,
  requireActor,
  writeAudit,
} from '@/lib/server-data';

const evaluationInput = z
  .object({
    harnessVersionId: z.string().min(1),
    split: z.enum(['development', 'feedback', 'heldout']),
    benchmark: z.string().trim().min(1).max(100),
    lane: z.enum(['probe', 'official']).default('official'),
    executorMode: z.enum(['self', 'unified']).default('self'),
    executor: executorConfigSchema.optional(),
    sealed: z.boolean().default(false),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.executorMode === 'unified' && !value.executor) {
      context.addIssue({
        code: 'custom',
        message: 'Unified evaluation requires an executor.',
      });
    }
    if (value.split === 'heldout' && value.lane !== 'official') {
      context.addIssue({
        code: 'custom',
        message: 'Held-out evaluations must be official.',
      });
    }
  });

export async function POST(request: NextRequest) {
  let evaluationId: string | undefined;
  try {
    const actor = await requireActor(request, 'operator');
    const parsed = evaluationInput.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json(
        {
          error: 'Invalid harness evaluation',
          issues: z.treeifyError(parsed.error),
        },
        { status: 400 },
      );
    }
    const version = await env.DB.prepare(
      `SELECT harness_versions.*, harness_projects.workspace_id, harness_projects.status AS project_status,
        harness_projects.probe_budget_per_round
       FROM harness_versions JOIN harness_projects ON harness_projects.id = harness_versions.project_id
       WHERE harness_versions.id = ? AND harness_projects.workspace_id = ?`,
    )
      .bind(parsed.data.harnessVersionId, DEFAULT_WORKSPACE_ID)
      .first<Record<string, unknown>>();
    if (!version)
      return NextResponse.json(
        { error: 'Harness version not found' },
        { status: 404 },
      );
    if (!['frozen', 'declared'].includes(String(version.status))) {
      return NextResponse.json(
        { error: 'Only compliant frozen versions can execute' },
        { status: 409 },
      );
    }
    if (parsed.data.split === 'heldout') {
      if (version.project_status !== 'completed' && !parsed.data.sealed) {
        return NextResponse.json(
          {
            error:
              'Held-out evaluation must remain sealed until a final harness is declared',
          },
          { status: 403 },
        );
      }
      if (version.project_status === 'completed') {
        const project = await env.DB.prepare(
          `SELECT baseline_version_id, final_version_id FROM harness_projects
           WHERE id = ? AND workspace_id = ?`,
        )
          .bind(version.project_id, DEFAULT_WORKSPACE_ID)
          .first<{
            baseline_version_id: string | null;
            final_version_id: string | null;
          }>();
        if (
          ![project?.baseline_version_id, project?.final_version_id].includes(
            String(version.id),
          )
        ) {
          return NextResponse.json(
            {
              error:
                'Held-out evaluation is limited to the declared baseline and final harnesses',
            },
            { status: 409 },
          );
        }
      }
    }
    if (parsed.data.lane === 'probe') {
      const probes = await env.DB.prepare(
        `SELECT COUNT(*) AS count FROM harness_evaluations
         WHERE harness_version_id = ? AND split = ? AND benchmark = ? AND lane = 'probe'`,
      )
        .bind(version.id, parsed.data.split, parsed.data.benchmark)
        .first<{ count: number }>();
      if (
        Number(probes?.count ?? 0) >= Number(version.probe_budget_per_round)
      ) {
        return NextResponse.json(
          { error: 'Probe budget exhausted for this version and benchmark' },
          { status: 409 },
        );
      }
    }
    const activeSlots = await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM harness_evaluations
       WHERE project_id = ? AND benchmark = ? AND lane = ? AND status = 'running'`,
    )
      .bind(version.project_id, parsed.data.benchmark, parsed.data.lane)
      .first<{ count: number }>();
    if (Number(activeSlots?.count ?? 0) >= 2) {
      return NextResponse.json(
        { error: 'Evaluation lane slots are full' },
        { status: 409 },
      );
    }
    if (
      parsed.data.split === 'feedback' &&
      parsed.data.lane === 'official' &&
      version.stage === 'evolution'
    ) {
      const reserved = await env.DB.prepare(
        `UPDATE harness_versions SET official_submitted = 1
         WHERE id = ? AND project_id = ? AND official_submitted = 0
           AND (SELECT COUNT(*) FROM harness_versions
                WHERE project_id = ? AND stage = 'evolution' AND official_submitted = 1)
             < (SELECT official_candidate_budget FROM harness_projects WHERE id = ?)`,
      )
        .bind(
          version.id,
          version.project_id,
          version.project_id,
          version.project_id,
        )
        .run();
      if (reserved.meta.changes !== 1) {
        const current = await env.DB.prepare(
          `SELECT official_submitted FROM harness_versions WHERE id = ?`,
        )
          .bind(version.id)
          .first<{ official_submitted: number }>();
        if (Number(current?.official_submitted ?? 0) !== 1) {
          return NextResponse.json(
            { error: 'Official candidate budget exhausted' },
            { status: 409 },
          );
        }
      }
    }

    const executor =
      parsed.data.executorMode === 'unified'
        ? parsed.data.executor!
        : await selfExecutor(String(version.creator_agent_version_id));
    const caseQuery = `SELECT id, benchmark, input, expected_json, grader_type
      FROM harness_cases WHERE project_id = ? AND split = ? AND benchmark = ?
      ORDER BY created_at${parsed.data.lane === 'probe' ? ' LIMIT 5' : ''}`;
    const cases = await env.DB.prepare(caseQuery)
      .bind(version.project_id, parsed.data.split, parsed.data.benchmark)
      .all<Record<string, unknown>>();
    if (cases.results.length === 0) {
      return NextResponse.json(
        { error: 'No cases match this split and benchmark' },
        { status: 404 },
      );
    }

    evaluationId = `harness_eval_${crypto.randomUUID()}`;
    const startedAt = Date.now();
    await env.DB.prepare(
      `INSERT INTO harness_evaluations (
        id, project_id, harness_version_id, split, benchmark, lane, executor_mode,
        executor_config_json, status, created_by, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?)`,
    )
      .bind(
        evaluationId,
        version.project_id,
        version.id,
        parsed.data.split,
        parsed.data.benchmark,
        parsed.data.lane,
        parsed.data.executorMode,
        JSON.stringify(executor),
        actor.id,
        startedAt,
      )
      .run();

    const artifact = harnessArtifactSchema.parse(
      JSON.parse(String(version.artifact_json)),
    );
    const evaluation = await executeHarnessEvaluation({
      artifact,
      executor,
      cases: cases.results.map((item) => ({
        id: String(item.id),
        benchmark: String(item.benchmark),
        input: String(item.input),
        expected: parseJson<Record<string, unknown>>(item.expected_json, {}),
        graderType: String(item.grader_type),
      })),
    });
    const finishedAt = Date.now();
    await env.DB.prepare(
      `UPDATE harness_evaluations SET status = 'completed', metrics_json = ?, results_json = ?,
        finished_at = ? WHERE id = ? AND status = 'running'`,
    )
      .bind(
        JSON.stringify(evaluation.metrics),
        JSON.stringify(evaluation.results),
        finishedAt,
        evaluationId,
      )
      .run();
    await writeAudit(
      actor.id,
      'harness.evaluated',
      'harness_evaluation',
      evaluationId,
      {
        harnessVersionId: version.id,
        split: parsed.data.split,
        benchmark: parsed.data.benchmark,
        lane: parsed.data.lane,
        executorMode: parsed.data.executorMode,
        capabilityScore: evaluation.metrics.capabilityScore,
        executorTokensTotal: evaluation.metrics.executorTokensTotal,
      },
    );
    const heldout = parsed.data.split === 'heldout';
    const sealed =
      heldout && (parsed.data.sealed || version.project_status !== 'completed');
    if (sealed) {
      return NextResponse.json(
        {
          id: evaluationId,
          harnessVersionId: version.id,
          split: parsed.data.split,
          status: 'completed',
          sealed: true,
        },
        { status: 201 },
      );
    }
    return NextResponse.json(
      {
        id: evaluationId,
        harnessVersionId: version.id,
        split: parsed.data.split,
        benchmark: parsed.data.benchmark,
        lane: parsed.data.lane,
        executorMode: parsed.data.executorMode,
        metrics: evaluation.metrics,
        ...(heldout ? {} : { results: evaluation.results }),
        latencyMs: finishedAt - startedAt,
      },
      { status: 201 },
    );
  } catch (error) {
    if (evaluationId) {
      await env.DB.prepare(
        `UPDATE harness_evaluations SET status = 'failed', error = ?, finished_at = ?
         WHERE id = ? AND status = 'running'`,
      )
        .bind(
          error instanceof Error ? error.message : 'Unexpected error',
          Date.now(),
          evaluationId,
        )
        .run()
        .catch(() => undefined);
    }
    return toResponse(error);
  }
}

export async function GET(request: NextRequest) {
  try {
    await requireActor(request);
    const projectId = request.nextUrl.searchParams.get('projectId');
    if (!projectId)
      return NextResponse.json(
        { error: 'projectId is required' },
        { status: 400 },
      );
    const project = await env.DB.prepare(
      `SELECT status FROM harness_projects WHERE id = ? AND workspace_id = ?`,
    )
      .bind(projectId, DEFAULT_WORKSPACE_ID)
      .first<{ status: string }>();
    if (!project)
      return NextResponse.json(
        { error: 'Harness project not found' },
        { status: 404 },
      );
    const rows = await env.DB.prepare(
      `SELECT id, harness_version_id, split, benchmark, lane, executor_mode,
        executor_config_json, status, metrics_json, error, created_at, finished_at
       FROM harness_evaluations WHERE project_id = ? ORDER BY created_at DESC`,
    )
      .bind(projectId)
      .all<Record<string, unknown>>();
    return NextResponse.json({
      evaluations: rows.results.map((row) => {
        const heldout = row.split === 'heldout';
        const sealed = heldout && project.status !== 'completed';
        return {
          id: row.id,
          harnessVersionId: row.harness_version_id,
          split: row.split,
          benchmark: row.benchmark,
          lane: row.lane,
          executorMode: row.executor_mode,
          status: row.status,
          error: row.error,
          createdAt: row.created_at,
          finishedAt: row.finished_at,
          sealed,
          ...(sealed ? {} : { metrics: parseJson(row.metrics_json, {}) }),
        };
      }),
    });
  } catch (error) {
    return toResponse(error);
  }
}

async function selfExecutor(creatorVersionId: string) {
  const row = await env.DB.prepare(
    `SELECT config_json FROM agent_versions WHERE id = ? AND workspace_id = ?`,
  )
    .bind(creatorVersionId, DEFAULT_WORKSPACE_ID)
    .first<{ config_json: string }>();
  if (!row)
    throw new Error('Creator version is unavailable for self-evaluation.');
  const config = parseJson<Record<string, unknown>>(row.config_json, {});
  return executorConfigSchema.parse({
    label: `self:${creatorVersionId}`,
    provider: config.provider,
    model: config.model,
    temperature: config.temperature,
  });
}

function toResponse(error: unknown) {
  if (error instanceof Response) return error;
  return NextResponse.json(
    { error: error instanceof Error ? error.message : 'Unexpected error' },
    { status: 500 },
  );
}
