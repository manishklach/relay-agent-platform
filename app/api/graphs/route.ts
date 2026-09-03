import { env } from 'cloudflare:workers';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { z } from 'zod';

import { graphDefinitionSchema } from '@/lib/graph';
import {
  DEFAULT_WORKSPACE_ID,
  requireActor,
  writeAudit,
} from '@/lib/server-data';

const graphInput = z
  .object({
    name: z.string().trim().min(2).max(100),
    description: z.string().trim().min(8).max(500),
    status: z.enum(['draft', 'live', 'paused']).default('draft'),
    definition: graphDefinitionSchema,
  })
  .strict();

export async function GET(request: NextRequest) {
  try {
    await requireActor(request);
    const result = await env.DB.prepare(
      `SELECT graphs.*, graph_versions.id AS active_version_id,
        graph_versions.version AS active_version, graph_versions.definition_json
       FROM graphs LEFT JOIN graph_versions
         ON graph_versions.graph_id = graphs.id AND graph_versions.status = 'active'
       WHERE graphs.workspace_id = ? ORDER BY graphs.updated_at DESC`,
    )
      .bind(DEFAULT_WORKSPACE_ID)
      .all<Record<string, unknown>>();
    return NextResponse.json({
      graphs: result.results.map((row) => ({
        ...row,
        definition_json:
          typeof row.definition_json === 'string'
            ? JSON.parse(row.definition_json)
            : null,
      })),
    });
  } catch (error) {
    return toResponse(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const actor = await requireActor(request, 'builder');
    const parsed = graphInput.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json(
        {
          error: 'Invalid graph definition',
          issues: z.treeifyError(parsed.error),
        },
        { status: 400 },
      );
    }
    const pinnedNodes = [];
    const agentIds = new Set<string>();
    for (const node of parsed.data.definition.nodes) {
      if (node.type !== 'agent') {
        pinnedNodes.push(node);
        continue;
      }
      const agentId = node.agentId;
      agentIds.add(agentId);
      const agent = await env.DB.prepare(
        'SELECT status FROM agents WHERE id = ? AND workspace_id = ?',
      )
        .bind(agentId, DEFAULT_WORKSPACE_ID)
        .first<{ status: string }>();
      if (!agent)
        return NextResponse.json(
          { error: `Graph agent not found: ${agentId}` },
          { status: 400 },
        );
      if (parsed.data.status === 'live' && agent.status !== 'live') {
        return NextResponse.json(
          { error: `Live graph references non-live agent: ${agentId}` },
          { status: 409 },
        );
      }
      const version = await env.DB.prepare(
        `SELECT id FROM agent_versions WHERE agent_id = ? AND workspace_id = ?
         AND ((? IS NULL AND status = 'active') OR id = ?) ORDER BY version DESC LIMIT 1`,
      )
        .bind(
          agentId,
          DEFAULT_WORKSPACE_ID,
          node.agentVersionId ?? null,
          node.agentVersionId ?? null,
        )
        .first<{ id: string }>();
      if (!version)
        return NextResponse.json(
          { error: `Agent has no requested version: ${agentId}` },
          { status: 409 },
        );
      pinnedNodes.push({ ...node, agentVersionId: version.id });
    }
    const definition = graphDefinitionSchema.parse({
      ...parsed.data.definition,
      nodes: pinnedNodes,
    });
    const graphId = `graph_${crypto.randomUUID()}`;
    const versionId = `graph_version_${crypto.randomUUID()}`;
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO graphs (id, workspace_id, name, description, status, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        graphId,
        DEFAULT_WORKSPACE_ID,
        parsed.data.name,
        parsed.data.description,
        parsed.data.status,
        actor.id,
        now,
        now,
      ),
      env.DB.prepare(
        `INSERT INTO graph_versions (id, graph_id, version, definition_json, status, created_by, created_at)
         VALUES (?, ?, 1, ?, 'active', ?, ?)`,
      ).bind(versionId, graphId, JSON.stringify(definition), actor.id, now),
    ]);
    await writeAudit(actor.id, 'graph.created', 'graph', graphId, {
      versionId,
      agentIds: [...agentIds],
    });
    return NextResponse.json(
      {
        id: graphId,
        versionId,
        version: 1,
        ...parsed.data,
        definition,
        createdAt: now,
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
