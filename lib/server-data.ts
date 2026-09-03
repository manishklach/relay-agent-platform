import { env } from 'cloudflare:workers';
import type { NextRequest } from 'next/server';

import { getChatGPTUser } from '@/app/chatgpt-auth';
import { ensureDatabase } from '@/db/bootstrap';
import { applyAgentVersion } from './agent-version';
import type { AgentConfig } from './types';

export const DEFAULT_WORKSPACE_ID = 'ws_default';

export type Actor = {
  id: string;
  email: string;
  role: 'owner' | 'builder' | 'operator' | 'viewer';
};

export async function requireActor(
  request: NextRequest,
  minimumRole: Actor['role'] = 'viewer',
): Promise<Actor> {
  await ensureDatabase();
  const user = await getChatGPTUser();
  const hostname = new URL(request.url).hostname;
  const isLocal = hostname === 'localhost' || hostname === '127.0.0.1';
  if (!user && !isLocal)
    throw new Response('Authentication required.', { status: 401 });

  const id = user?.userId ?? 'local-dev';
  const email = user?.email ?? 'local@relay.dev';
  const existing = await env.DB.prepare(
    'SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?',
  )
    .bind(DEFAULT_WORKSPACE_ID, id)
    .first<{ role: Actor['role'] }>();

  let role = existing?.role;
  if (!role) {
    const count = await env.DB.prepare(
      'SELECT COUNT(*) AS count FROM workspace_members WHERE workspace_id = ?',
    )
      .bind(DEFAULT_WORKSPACE_ID)
      .first<{ count: number }>();
    role = Number(count?.count ?? 0) === 0 ? 'owner' : 'viewer';
    await env.DB.prepare(
      'INSERT INTO workspace_members (workspace_id, user_id, email, role, created_at) VALUES (?, ?, ?, ?, ?)',
    )
      .bind(DEFAULT_WORKSPACE_ID, id, email, role, Date.now())
      .run();
  }

  if (roleRank(role) < roleRank(minimumRole)) {
    throw new Response(`Role ${minimumRole} or higher is required.`, {
      status: 403,
    });
  }
  return { id, email, role };
}

export async function getAgent(
  agentId: string,
  versionId?: string,
): Promise<AgentConfig | null> {
  await ensureDatabase();
  const row = await env.DB.prepare(
    `SELECT id, workspace_id, name, description, system_prompt, provider, model,
      temperature, status, allowed_tools, guardrail_config
     FROM agents WHERE id = ? AND workspace_id = ?`,
  )
    .bind(agentId, DEFAULT_WORKSPACE_ID)
    .first<Record<string, unknown>>();

  if (!row) return null;
  const agent: AgentConfig = {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    name: String(row.name),
    description: String(row.description),
    systemPrompt: String(row.system_prompt),
    provider: String(row.provider),
    model: String(row.model),
    temperature: Number(row.temperature),
    status: String(row.status) as AgentConfig['status'],
    allowedTools: parseJson<string[]>(row.allowed_tools, []),
    guardrails: parseJson<AgentConfig['guardrails']>(row.guardrail_config, {}),
  };
  const activeVersion = await env.DB.prepare(
    `SELECT id, config_json FROM agent_versions
     WHERE agent_id = ? AND workspace_id = ?
       AND ((? IS NULL AND status = 'active') OR id = ?)
     ORDER BY version DESC LIMIT 1`,
  )
    .bind(agentId, DEFAULT_WORKSPACE_ID, versionId ?? null, versionId ?? null)
    .first<{ id: string; config_json: string }>();
  if (versionId && !activeVersion) return null;
  return activeVersion
    ? {
        ...applyAgentVersion(agent, parseJson(activeVersion.config_json, null)),
        versionId: activeVersion.id,
      }
    : agent;
}

export async function writeAudit(
  actorId: string,
  action: string,
  targetType: string,
  targetId: string,
  metadata: Record<string, unknown> = {},
) {
  await env.DB.prepare(
    `INSERT INTO audit_logs (id, workspace_id, actor_id, action, target_type, target_id, metadata_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      crypto.randomUUID(),
      DEFAULT_WORKSPACE_ID,
      actorId,
      action,
      targetType,
      targetId,
      JSON.stringify(metadata),
      Date.now(),
    )
    .run();
}

export function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string') return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function roleRank(role: Actor['role']) {
  return { viewer: 0, operator: 1, builder: 2, owner: 3 }[role];
}
