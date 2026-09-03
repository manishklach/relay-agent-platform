import { env } from 'cloudflare:workers';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { z } from 'zod';

import {
  agentVersionConfigSchema,
  assertProposalCanActivate,
} from '@/lib/agent-version';
import {
  DEFAULT_WORKSPACE_ID,
  parseJson,
  requireActor,
  writeAudit,
} from '@/lib/server-data';

const decisionSchema = z
  .object({
    proposalId: z.string().min(1),
    action: z.enum(['approve', 'reject', 'activate']),
  })
  .strict();

export async function POST(request: NextRequest) {
  try {
    const actor = await requireActor(request, 'owner');
    const parsed = decisionSchema.safeParse(await request.json());
    if (!parsed.success)
      return NextResponse.json(
        { error: 'Invalid improvement decision' },
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
    const now = Date.now();

    if (parsed.data.action === 'approve' || parsed.data.action === 'reject') {
      if (proposal.status !== 'awaiting_approval') {
        return NextResponse.json(
          { error: 'Proposal is not awaiting approval' },
          { status: 409 },
        );
      }
      const status = parsed.data.action === 'approve' ? 'approved' : 'rejected';
      const update = await env.DB.prepare(
        `UPDATE improvement_proposals SET status = ?, reviewed_by = ?, reviewed_at = ?
         WHERE id = ? AND workspace_id = ? AND status = 'awaiting_approval'`,
      )
        .bind(status, actor.id, now, proposal.id, DEFAULT_WORKSPACE_ID)
        .run();
      if (update.meta.changes !== 1)
        return NextResponse.json(
          { error: 'Decision conflict' },
          { status: 409 },
        );
      await writeAudit(
        actor.id,
        `improvement.${status}`,
        'improvement_proposal',
        String(proposal.id),
      );
      return NextResponse.json({ id: proposal.id, status });
    }

    const active = await env.DB.prepare(
      `SELECT id FROM agent_versions WHERE agent_id = ? AND workspace_id = ? AND status = 'active'
       ORDER BY version DESC LIMIT 1`,
    )
      .bind(proposal.agent_id, DEFAULT_WORKSPACE_ID)
      .first<{ id: string }>();
    if (!active)
      return NextResponse.json(
        { error: 'Agent has no active version' },
        { status: 409 },
      );
    assertProposalCanActivate({
      status: String(proposal.status),
      score: proposal.score === null ? null : Number(proposal.score),
      minimumScore: Number(proposal.minimum_score),
      baseVersionId: String(proposal.base_version_id),
      activeVersionId: active.id,
    });
    const candidate = agentVersionConfigSchema.parse(
      parseJson(proposal.config_json, null),
    );
    const statements = [
      env.DB.prepare(
        `UPDATE agent_versions SET status = 'active'
         WHERE id = ? AND workspace_id = ? AND status = 'candidate'
           AND EXISTS (SELECT 1 FROM agent_versions WHERE id = ? AND status = 'active')
           AND EXISTS (SELECT 1 FROM improvement_proposals WHERE id = ? AND status = 'approved')`,
      ).bind(
        proposal.candidate_version_id,
        DEFAULT_WORKSPACE_ID,
        proposal.base_version_id,
        proposal.id,
      ),
      env.DB.prepare(
        `UPDATE agent_versions SET status = 'archived'
         WHERE id = ? AND workspace_id = ? AND status = 'active'
           AND EXISTS (SELECT 1 FROM agent_versions WHERE id = ? AND status = 'active')`,
      ).bind(
        proposal.base_version_id,
        DEFAULT_WORKSPACE_ID,
        proposal.candidate_version_id,
      ),
      env.DB.prepare(
        `UPDATE agents SET system_prompt = ?, provider = ?, model = ?, temperature = ?,
          allowed_tools = ?, guardrail_config = ?, updated_at = ?
         WHERE id = ? AND workspace_id = ?
           AND EXISTS (SELECT 1 FROM agent_versions WHERE id = ? AND status = 'active')`,
      ).bind(
        candidate.systemPrompt,
        candidate.provider,
        candidate.model,
        candidate.temperature,
        JSON.stringify(candidate.allowedTools),
        JSON.stringify(candidate.guardrails),
        now,
        proposal.agent_id,
        DEFAULT_WORKSPACE_ID,
        proposal.candidate_version_id,
      ),
      env.DB.prepare(
        `UPDATE improvement_proposals SET status = 'activated', activated_at = ?
         WHERE id = ? AND workspace_id = ? AND status = 'approved'
           AND EXISTS (SELECT 1 FROM agent_versions WHERE id = ? AND status = 'active')`,
      ).bind(
        now,
        proposal.id,
        DEFAULT_WORKSPACE_ID,
        proposal.candidate_version_id,
      ),
    ];
    const results = await env.DB.batch(statements);
    if (results.some((result) => result.meta.changes !== 1)) {
      throw new Error(
        'The proposal activation lost a concurrent version race.',
      );
    }
    await writeAudit(
      actor.id,
      'improvement.activated',
      'improvement_proposal',
      String(proposal.id),
      {
        previousVersionId: active.id,
        activeVersionId: proposal.candidate_version_id,
      },
    );
    return NextResponse.json({
      id: proposal.id,
      status: 'activated',
      activeVersionId: proposal.candidate_version_id,
    });
  } catch (error) {
    if (error instanceof Response) return error;
    const message = error instanceof Error ? error.message : 'Unexpected error';
    const status = /approved|threshold|stale/.test(message) ? 409 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
