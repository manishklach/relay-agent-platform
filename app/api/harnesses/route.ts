import { env } from 'cloudflare:workers';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { z } from 'zod';

import {
  createWeakSeed,
  harnessCaseInputSchema,
  harnessProjectInputSchema,
} from '@/lib/harness-dev';
import {
  DEFAULT_WORKSPACE_ID,
  requireActor,
  writeAudit,
} from '@/lib/server-data';

const createProjectSchema = harnessProjectInputSchema
  .extend({
    cases: z.array(harnessCaseInputSchema).min(3).max(500),
  })
  .superRefine((value, context) => {
    const development = value.cases.filter(
      (item) => item.split === 'development',
    ).length;
    const feedback = value.cases.filter(
      (item) => item.split === 'feedback',
    ).length;
    const heldout = value.cases.filter(
      (item) => item.split === 'heldout',
    ).length;
    if (development < 1 || development > 3) {
      context.addIssue({
        code: 'custom',
        message: 'Creation requires one to three development cases.',
      });
    }
    if (feedback < 1)
      context.addIssue({
        code: 'custom',
        message: 'At least one feedback case is required.',
      });
    if (heldout < 1)
      context.addIssue({
        code: 'custom',
        message: 'At least one held-out case is required.',
      });
  });

export async function GET(request: NextRequest) {
  try {
    await requireActor(request);
    const projects = await env.DB.prepare(
      `SELECT harness_projects.*,
        (SELECT COUNT(*) FROM harness_cases WHERE project_id = harness_projects.id AND split = 'development') AS development_cases,
        (SELECT COUNT(*) FROM harness_cases WHERE project_id = harness_projects.id AND split = 'feedback') AS feedback_cases,
        (SELECT COUNT(*) FROM harness_cases WHERE project_id = harness_projects.id AND split = 'heldout') AS heldout_cases,
        (SELECT COUNT(*) FROM harness_versions WHERE project_id = harness_projects.id) AS version_count
       FROM harness_projects WHERE workspace_id = ? ORDER BY updated_at DESC`,
    )
      .bind(DEFAULT_WORKSPACE_ID)
      .all<Record<string, unknown>>();
    return NextResponse.json({ harnesses: projects.results });
  } catch (error) {
    return toResponse(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const actor = await requireActor(request, 'builder');
    const parsed = createProjectSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json(
        {
          error: 'Invalid HarnessDev project',
          issues: z.treeifyError(parsed.error),
        },
        { status: 400 },
      );
    }
    const creator = await env.DB.prepare(
      `SELECT agent_versions.id FROM agent_versions JOIN agents ON agents.id = agent_versions.agent_id
       WHERE agent_versions.id = ? AND agent_versions.workspace_id = ?`,
    )
      .bind(parsed.data.creatorAgentVersionId, DEFAULT_WORKSPACE_ID)
      .first();
    if (!creator)
      return NextResponse.json(
        { error: 'Creator agent version not found' },
        { status: 404 },
      );

    const projectId = `harness_${crypto.randomUUID()}`;
    const seedVersionId = `harness_version_${crypto.randomUUID()}`;
    const caseRows = parsed.data.cases.map((item) => ({
      id: `harness_case_${crypto.randomUUID()}`,
      ...item,
    }));
    const developmentCount = caseRows.filter(
      (item) => item.split === 'development',
    ).length;
    const seed = createWeakSeed(
      Array.from(
        { length: developmentCount },
        (_, index) => `development_${index + 1}`,
      ),
    );
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO harness_projects (
          id, workspace_id, name, description, domain, creator_agent_version_id,
          status, official_candidate_budget, probe_budget_per_round,
          official_candidates_used, created_by, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'creation', ?, ?, 0, ?, ?, ?)`,
      ).bind(
        projectId,
        DEFAULT_WORKSPACE_ID,
        parsed.data.name,
        parsed.data.description,
        parsed.data.domain,
        parsed.data.creatorAgentVersionId,
        parsed.data.officialCandidateBudget,
        parsed.data.probeBudgetPerRound,
        actor.id,
        now,
        now,
      ),
      env.DB.prepare(
        `INSERT INTO harness_versions (
          id, project_id, version, parent_version_id, stage, status, artifact_json,
          constraint_audit_json, creator_agent_version_id, created_by, created_at
        ) VALUES (?, ?, 0, NULL, 'seed', 'frozen', ?, ?, ?, ?, ?)`,
      ).bind(
        seedVersionId,
        projectId,
        JSON.stringify(seed),
        JSON.stringify({ compliant: true, violations: [] }),
        parsed.data.creatorAgentVersionId,
        actor.id,
        now,
      ),
      ...caseRows.map((item) =>
        env.DB.prepare(
          `INSERT INTO harness_cases (
          id, project_id, external_id, name, split, benchmark, input,
          expected_json, grader_type, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          item.id,
          projectId,
          item.externalId ?? null,
          item.name,
          item.split,
          item.benchmark,
          item.input,
          JSON.stringify(item.expected),
          item.graderType,
          now,
        ),
      ),
    ]);
    await writeAudit(
      actor.id,
      'harness.created',
      'harness_project',
      projectId,
      {
        seedVersionId,
        domain: parsed.data.domain,
        developmentCases: caseRows.filter(
          (item) => item.split === 'development',
        ).length,
        feedbackCases: caseRows.filter((item) => item.split === 'feedback')
          .length,
        heldoutCases: caseRows.filter((item) => item.split === 'heldout')
          .length,
      },
    );
    return NextResponse.json(
      {
        id: projectId,
        seedVersionId,
        seedArtifact: seed,
        status: 'creation',
        name: parsed.data.name,
        domain: parsed.data.domain,
        developmentCases: caseRows
          .filter((item) => item.split === 'development')
          .map(({ id, name, benchmark, input, expected, graderType }) => ({
            id,
            name,
            benchmark,
            input,
            expected,
            graderType,
          })),
        feedbackCaseCount: caseRows.filter((item) => item.split === 'feedback')
          .length,
        heldoutCaseCount: caseRows.filter((item) => item.split === 'heldout')
          .length,
      },
      { status: 201 },
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
