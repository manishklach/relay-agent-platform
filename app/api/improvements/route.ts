import { env } from 'cloudflare:workers';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { z } from 'zod';

import { agentVersionConfigSchema } from '@/lib/agent-version';
import {
  DEFAULT_WORKSPACE_ID,
  getAgent,
  requireActor,
  writeAudit,
} from '@/lib/server-data';

const proposalInput = z
  .object({
    agentId: z.string().min(1),
    evaluationSuiteId: z.string().min(1),
    minimumScore: z.number().min(0).max(100).default(90),
    rationale: z.string().trim().min(10).max(2_000),
    candidate: agentVersionConfigSchema,
  })
  .strict();

export async function GET(request: NextRequest) {
  try {
    await requireActor(request);
    const result = await env.DB.prepare(
      `SELECT improvement_proposals.*, agents.name AS agent_name,
        base.version AS base_version, candidate.version AS candidate_version
       FROM improvement_proposals
       JOIN agents ON agents.id = improvement_proposals.agent_id
       JOIN agent_versions base ON base.id = improvement_proposals.base_version_id
       JOIN agent_versions candidate ON candidate.id = improvement_proposals.candidate_version_id
       WHERE improvement_proposals.workspace_id = ?
       ORDER BY improvement_proposals.created_at DESC LIMIT 100`,
    )
      .bind(DEFAULT_WORKSPACE_ID)
      .all();
    return NextResponse.json({ improvements: result.results });
  } catch (error) {
    return toResponse(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const actor = await requireActor(request, 'builder');
    const parsed = proposalInput.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json(
        {
          error: 'Invalid improvement proposal',
          issues: z.treeifyError(parsed.error),
        },
        { status: 400 },
      );
    }
    const agent = await getAgent(parsed.data.agentId);
    if (!agent)
      return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
    const suite = await env.DB.prepare(
      `SELECT id FROM evaluation_suites
       WHERE id = ? AND agent_id = ? AND workspace_id = ?`,
    )
      .bind(parsed.data.evaluationSuiteId, agent.id, DEFAULT_WORKSPACE_ID)
      .first();
    if (!suite) {
      return NextResponse.json(
        { error: 'Evaluation suite does not belong to this agent' },
        { status: 400 },
      );
    }
    const active = await env.DB.prepare(
      `SELECT id, version,
        (SELECT MAX(version) FROM agent_versions WHERE agent_id = ?) AS max_version
       FROM agent_versions
       WHERE agent_id = ? AND workspace_id = ? AND status = 'active'
       ORDER BY version DESC LIMIT 1`,
    )
      .bind(agent.id, agent.id, DEFAULT_WORKSPACE_ID)
      .first<{ id: string; version: number; max_version: number }>();
    if (!active) {
      return NextResponse.json(
        { error: 'Agent has no active immutable version' },
        { status: 409 },
      );
    }

    const now = Date.now();
    const candidateVersionId = `agent_version_${crypto.randomUUID()}`;
    const proposalId = `improvement_${crypto.randomUUID()}`;
    const nextVersion = Number(active.max_version) + 1;
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO agent_versions (
          id, workspace_id, agent_id, version, config_json, status, source,
          parent_version_id, created_by, created_at
        ) VALUES (?, ?, ?, ?, ?, 'candidate', 'improvement', ?, ?, ?)`,
      ).bind(
        candidateVersionId,
        DEFAULT_WORKSPACE_ID,
        agent.id,
        nextVersion,
        JSON.stringify(parsed.data.candidate),
        active.id,
        actor.id,
        now,
      ),
      env.DB.prepare(
        `INSERT INTO improvement_proposals (
          id, workspace_id, agent_id, base_version_id, candidate_version_id,
          evaluation_suite_id, minimum_score, status, rationale, proposed_by, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending_evaluation', ?, ?, ?)`,
      ).bind(
        proposalId,
        DEFAULT_WORKSPACE_ID,
        agent.id,
        active.id,
        candidateVersionId,
        parsed.data.evaluationSuiteId,
        parsed.data.minimumScore,
        parsed.data.rationale,
        actor.id,
        now,
      ),
    ]);
    await writeAudit(
      actor.id,
      'improvement.proposed',
      'improvement_proposal',
      proposalId,
      {
        agentId: agent.id,
        baseVersionId: active.id,
        candidateVersionId,
        minimumScore: parsed.data.minimumScore,
      },
    );
    return NextResponse.json(
      {
        id: proposalId,
        status: 'pending_evaluation',
        baseVersionId: active.id,
        candidateVersionId,
        candidateVersion: nextVersion,
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
