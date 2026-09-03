import { env } from 'cloudflare:workers';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { z } from 'zod';

import { auditHarnessArtifact, harnessArtifactSchema } from '@/lib/harness-dev';
import {
  DEFAULT_WORKSPACE_ID,
  requireActor,
  writeAudit,
} from '@/lib/server-data';

const versionInput = z
  .object({
    projectId: z.string().min(1),
    parentVersionId: z.string().min(1),
    stage: z.enum(['creation', 'evolution']),
    artifact: harnessArtifactSchema,
  })
  .strict();

export async function GET(request: NextRequest) {
  try {
    await requireActor(request);
    const projectId = request.nextUrl.searchParams.get('projectId');
    if (!projectId)
      return NextResponse.json(
        { error: 'projectId is required' },
        { status: 400 },
      );
    const result = await env.DB.prepare(
      `SELECT id, project_id, version, parent_version_id, stage, status,
        constraint_audit_json, creator_agent_version_id, created_by, created_at
       FROM harness_versions WHERE project_id = ?
       AND EXISTS (SELECT 1 FROM harness_projects WHERE id = ? AND workspace_id = ?)
       ORDER BY version`,
    )
      .bind(projectId, projectId, DEFAULT_WORKSPACE_ID)
      .all<Record<string, unknown>>();
    return NextResponse.json({
      versions: result.results.map((row) => ({
        ...row,
        constraint_audit_json: JSON.parse(String(row.constraint_audit_json)),
      })),
    });
  } catch (error) {
    return toResponse(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const actor = await requireActor(request, 'builder');
    const parsed = versionInput.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json(
        {
          error: 'Invalid harness version',
          issues: z.treeifyError(parsed.error),
        },
        { status: 400 },
      );
    }
    if (parsed.data.artifact.kind !== 'developed') {
      return NextResponse.json(
        { error: 'Only the controller may create seed artifacts' },
        { status: 400 },
      );
    }
    const project = await env.DB.prepare(
      `SELECT status, creator_agent_version_id, baseline_version_id FROM harness_projects
       WHERE id = ? AND workspace_id = ?`,
    )
      .bind(parsed.data.projectId, DEFAULT_WORKSPACE_ID)
      .first<Record<string, unknown>>();
    if (!project)
      return NextResponse.json(
        { error: 'Harness project not found' },
        { status: 404 },
      );
    if (project.status !== parsed.data.stage) {
      return NextResponse.json(
        {
          error: `Project is in ${String(project.status)}, not ${parsed.data.stage}`,
        },
        { status: 409 },
      );
    }
    const parent = await env.DB.prepare(
      `SELECT id, stage FROM harness_versions
       WHERE id = ? AND project_id = ? AND status IN ('frozen','declared')`,
    )
      .bind(parsed.data.parentVersionId, parsed.data.projectId)
      .first<{ id: string; stage: 'seed' | 'creation' | 'evolution' }>();
    if (!parent)
      return NextResponse.json(
        { error: 'Frozen parent version not found' },
        { status: 404 },
      );
    const validParent =
      parsed.data.stage === 'creation'
        ? ['seed', 'creation'].includes(parent.stage)
        : parent.stage === 'evolution' ||
          parent.id === project.baseline_version_id;
    if (!validParent) {
      return NextResponse.json(
        { error: 'Parent version does not belong to this stage lineage' },
        { status: 409 },
      );
    }

    const identifiers = await env.DB.prepare(
      `SELECT id, external_id, expected_json FROM harness_cases WHERE project_id = ?`,
    )
      .bind(parsed.data.projectId)
      .all<{ id: string; external_id: string | null; expected_json: string }>();
    const audit = auditHarnessArtifact(
      parsed.data.artifact,
      identifiers.results.flatMap((item) => [
        item.id,
        item.external_id ?? '',
        ...caseAnswerEvidence(item.expected_json),
      ]),
    );
    const graph =
      parsed.data.artifact.execution.mode === 'graph'
        ? parsed.data.artifact.execution.graph
        : null;
    if (!graph) throw new Error('Developed harness graph was not parsed.');
    for (const node of graph.nodes) {
      if (node.type !== 'agent' || !node.agentVersionId) {
        if (node.type === 'agent')
          audit.violations.push(`unpinned_agent:${node.id}`);
        continue;
      }
      const version = await env.DB.prepare(
        `SELECT config_json FROM agent_versions WHERE id = ? AND workspace_id = ?`,
      )
        .bind(node.agentVersionId, DEFAULT_WORKSPACE_ID)
        .first<{ config_json: string }>();
      if (!version) {
        audit.violations.push(`unknown_agent_version:${node.id}`);
        continue;
      }
      const config = JSON.parse(version.config_json) as {
        allowedTools?: string[];
      };
      const excess = (config.allowedTools ?? []).filter(
        (tool) => !parsed.data.artifact.tools.allowed.includes(tool),
      );
      if (excess.length > 0)
        audit.violations.push(`agent_tools_exceed_harness:${node.id}`);
    }
    audit.compliant = audit.violations.length === 0;

    const latest = await env.DB.prepare(
      'SELECT COALESCE(MAX(version), 0) AS version FROM harness_versions WHERE project_id = ?',
    )
      .bind(parsed.data.projectId)
      .first<{ version: number }>();
    const versionNumber = Number(latest?.version ?? 0) + 1;
    const versionId = `harness_version_${crypto.randomUUID()}`;
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO harness_versions (
        id, project_id, version, parent_version_id, stage, status, artifact_json,
        constraint_audit_json, creator_agent_version_id, created_by, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        versionId,
        parsed.data.projectId,
        versionNumber,
        parsed.data.parentVersionId,
        parsed.data.stage,
        audit.compliant ? 'frozen' : 'rejected',
        JSON.stringify(parsed.data.artifact),
        JSON.stringify(audit),
        project.creator_agent_version_id,
        actor.id,
        now,
      )
      .run();
    await writeAudit(
      actor.id,
      'harness.version_created',
      'harness_version',
      versionId,
      {
        projectId: parsed.data.projectId,
        stage: parsed.data.stage,
        version: versionNumber,
        constraintCompliant: audit.compliant,
      },
    );
    return NextResponse.json(
      {
        id: versionId,
        version: versionNumber,
        stage: parsed.data.stage,
        status: audit.compliant ? 'frozen' : 'rejected',
        constraintAudit: audit,
      },
      { status: audit.compliant ? 201 : 422 },
    );
  } catch (error) {
    return toResponse(error);
  }
}

function caseAnswerEvidence(expectedJson: string): string[] {
  const values: string[] = [];
  const visit = (value: unknown) => {
    if (typeof value === 'string' && value.trim().length >= 8)
      values.push(value.trim());
    else if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === 'object')
      Object.values(value).forEach(visit);
  };
  try {
    visit(JSON.parse(expectedJson));
  } catch {
    return [];
  }
  return values;
}

function toResponse(error: unknown) {
  if (error instanceof Response) return error;
  return NextResponse.json(
    { error: error instanceof Error ? error.message : 'Unexpected error' },
    { status: 500 },
  );
}
