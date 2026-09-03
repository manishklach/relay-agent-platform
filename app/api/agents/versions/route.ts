import { env } from 'cloudflare:workers';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { z } from 'zod';

import { agentVersionConfigSchema } from '@/lib/agent-version';
import {
  DEFAULT_WORKSPACE_ID,
  parseJson,
  requireActor,
  writeAudit,
} from '@/lib/server-data';

const rollbackSchema = z
  .object({
    agentId: z.string().min(1),
    versionId: z.string().min(1),
    reason: z.string().trim().min(10).max(1_000),
  })
  .strict();

export async function GET(request: NextRequest) {
  try {
    await requireActor(request);
    const agentId = request.nextUrl.searchParams.get('agentId');
    if (!agentId)
      return NextResponse.json(
        { error: 'agentId is required' },
        { status: 400 },
      );
    const result = await env.DB.prepare(
      `SELECT id, agent_id, version, config_json, status, source, parent_version_id,
        created_by, created_at FROM agent_versions
       WHERE agent_id = ? AND workspace_id = ? ORDER BY version DESC`,
    )
      .bind(agentId, DEFAULT_WORKSPACE_ID)
      .all<Record<string, unknown>>();
    return NextResponse.json({
      versions: result.results.map((row) => ({
        ...row,
        config_json: agentVersionConfigSchema.parse(
          parseJson(row.config_json, null),
        ),
      })),
    });
  } catch (error) {
    return toResponse(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const actor = await requireActor(request, 'owner');
    const parsed = rollbackSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json(
        {
          error: 'Invalid rollback request',
          issues: z.treeifyError(parsed.error),
        },
        { status: 400 },
      );
    }
    const target = await env.DB.prepare(
      `SELECT id, config_json FROM agent_versions
       WHERE id = ? AND agent_id = ? AND workspace_id = ?`,
    )
      .bind(parsed.data.versionId, parsed.data.agentId, DEFAULT_WORKSPACE_ID)
      .first<{ id: string; config_json: string }>();
    if (!target)
      return NextResponse.json(
        { error: 'Agent version not found' },
        { status: 404 },
      );
    const active = await env.DB.prepare(
      `SELECT id, version,
        (SELECT MAX(version) FROM agent_versions WHERE agent_id = ?) AS max_version
       FROM agent_versions WHERE agent_id = ? AND workspace_id = ?
       AND status = 'active' ORDER BY version DESC LIMIT 1`,
    )
      .bind(parsed.data.agentId, parsed.data.agentId, DEFAULT_WORKSPACE_ID)
      .first<{
        id: string;
        version: number;
        max_version: number;
      }>();
    if (!active)
      return NextResponse.json(
        { error: 'Agent has no active version' },
        { status: 409 },
      );
    if (target.id === active.id)
      return NextResponse.json(
        { error: 'Version is already active' },
        { status: 409 },
      );

    const config = agentVersionConfigSchema.parse(
      JSON.parse(target.config_json),
    );
    const versionId = `agent_version_${crypto.randomUUID()}`;
    const version = Number(active.max_version) + 1;
    const now = Date.now();
    const results = await env.DB.batch([
      env.DB.prepare(
        `UPDATE agent_versions SET status = 'archived'
         WHERE id = ? AND agent_id = ? AND workspace_id = ? AND status = 'active'`,
      ).bind(active.id, parsed.data.agentId, DEFAULT_WORKSPACE_ID),
      env.DB.prepare(
        `INSERT INTO agent_versions (
          id, workspace_id, agent_id, version, config_json, status, source,
          parent_version_id, created_by, created_at
        ) VALUES (?, ?, ?, ?, ?, 'active', 'rollback', ?, ?, ?)`,
      ).bind(
        versionId,
        DEFAULT_WORKSPACE_ID,
        parsed.data.agentId,
        version,
        JSON.stringify(config),
        active.id,
        actor.id,
        now,
      ),
      env.DB.prepare(
        `UPDATE agents SET system_prompt = ?, provider = ?, model = ?, temperature = ?,
          allowed_tools = ?, guardrail_config = ?, updated_at = ?
         WHERE id = ? AND workspace_id = ?`,
      ).bind(
        config.systemPrompt,
        config.provider,
        config.model,
        config.temperature,
        JSON.stringify(config.allowedTools),
        JSON.stringify(config.guardrails),
        now,
        parsed.data.agentId,
        DEFAULT_WORKSPACE_ID,
      ),
    ]);
    if (results.some((result) => result.meta.changes !== 1)) {
      throw new Error('Rollback lost a concurrent version race.');
    }
    await writeAudit(
      actor.id,
      'agent.rolled_back',
      'agent',
      parsed.data.agentId,
      {
        restoredFromVersionId: target.id,
        previousVersionId: active.id,
        activeVersionId: versionId,
        reason: parsed.data.reason,
      },
    );
    return NextResponse.json({
      agentId: parsed.data.agentId,
      activeVersionId: versionId,
      version,
      restoredFromVersionId: target.id,
    });
  } catch (error) {
    return toResponse(error);
  }
}

function toResponse(error: unknown) {
  if (error instanceof Response) return error;
  const message = error instanceof Error ? error.message : 'Unexpected error';
  return NextResponse.json(
    { error: message },
    { status: /concurrent/.test(message) ? 409 : 500 },
  );
}
