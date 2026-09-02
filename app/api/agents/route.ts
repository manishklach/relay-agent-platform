import { env } from 'cloudflare:workers';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { z } from 'zod';

import { DEFAULT_WORKSPACE_ID, parseJson, requireActor, writeAudit } from '@/lib/server-data';

const agentInput = z.object({
  name: z.string().trim().min(2).max(80),
  description: z.string().trim().min(4).max(280),
  systemPrompt: z.string().trim().min(20).max(12000),
  provider: z.enum(['mock', 'openai']).default('mock'),
  model: z.string().trim().min(2).max(100).default('relay-sim-1'),
  temperature: z.number().min(0).max(2).default(0.2),
  status: z.enum(['draft', 'live', 'paused']).default('draft'),
  allowedTools: z.array(z.string()).max(30).default([]),
  guardrails: z.object({
    redactPii: z.boolean().default(true),
    blockPromptInjection: z.boolean().default(true),
    requireApprovalForWrites: z.boolean().default(true),
  }),
});

export async function GET(request: NextRequest) {
  try {
    await requireActor(request);
    const result = await env.DB.prepare(
      `SELECT id, name, description, provider, model, temperature, status, allowed_tools,
        guardrail_config, created_at, updated_at
       FROM agents WHERE workspace_id = ? ORDER BY updated_at DESC`,
    ).bind(DEFAULT_WORKSPACE_ID).all<Record<string, unknown>>();
    return NextResponse.json({
      agents: result.results.map((row) => ({
        ...row,
        allowed_tools: parseJson(row.allowed_tools, []),
        guardrail_config: parseJson(row.guardrail_config, {}),
      })),
    });
  } catch (error) {
    return toResponse(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const actor = await requireActor(request, 'builder');
    const parsed = agentInput.safeParse(await request.json());
    if (!parsed.success) return NextResponse.json({ error: 'Invalid agent configuration', issues: z.treeifyError(parsed.error) }, { status: 400 });

    const id = `agent_${crypto.randomUUID()}`;
    const now = Date.now();
    const agent = parsed.data;
    await env.DB.prepare(
      `INSERT INTO agents (
        id, workspace_id, name, description, system_prompt, provider, model, temperature,
        status, allowed_tools, guardrail_config, created_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      id, DEFAULT_WORKSPACE_ID, agent.name, agent.description, agent.systemPrompt,
      agent.provider, agent.model, agent.temperature, agent.status,
      JSON.stringify(agent.allowedTools), JSON.stringify(agent.guardrails), actor.id, now, now,
    ).run();
    await writeAudit(actor.id, 'agent.created', 'agent', id, { name: agent.name });
    return NextResponse.json({ id, ...agent, createdAt: now }, { status: 201 });
  } catch (error) {
    return toResponse(error);
  }
}

function toResponse(error: unknown) {
  if (error instanceof Response) return error;
  return NextResponse.json({ error: error instanceof Error ? error.message : 'Unexpected error' }, { status: 500 });
}
