import { env } from 'cloudflare:workers';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { z } from 'zod';

import {
  DEFAULT_WORKSPACE_ID,
  requireActor,
  writeAudit,
} from '@/lib/server-data';

const toolInput = z.object({
  name: z
    .string()
    .trim()
    .regex(/^[a-z][a-z0-9_]{2,48}$/),
  displayName: z.string().trim().min(2).max(80),
  description: z.string().trim().min(8).max(280),
  url: z
    .url()
    .refine((value) => value.startsWith('https://'), 'HTTPS is required'),
  method: z.enum(['GET', 'POST']).default('POST'),
  approvalRequired: z.boolean().default(false),
  supportsIdempotency: z.boolean().default(false),
});

export async function GET(request: NextRequest) {
  try {
    await requireActor(request);
    const result = await env.DB.prepare(
      `SELECT id, name, display_name, description, kind, approval_required, enabled, created_at
       FROM tools WHERE workspace_id = ? ORDER BY display_name`,
    )
      .bind(DEFAULT_WORKSPACE_ID)
      .all();
    return NextResponse.json({ tools: result.results });
  } catch (error) {
    if (error instanceof Response) return error;
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Unexpected error' },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const actor = await requireActor(request, 'builder');
    const parsed = toolInput.safeParse(await request.json());
    if (!parsed.success)
      return NextResponse.json(
        {
          error: 'Invalid HTTP tool configuration',
          issues: z.treeifyError(parsed.error),
        },
        { status: 400 },
      );
    const id = `tool_${crypto.randomUUID()}`;
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO tools (
        id, workspace_id, name, display_name, description, kind, config_json,
        approval_required, enabled, created_at
      ) VALUES (?, ?, ?, ?, ?, 'http', ?, ?, 1, ?)`,
    )
      .bind(
        id,
        DEFAULT_WORKSPACE_ID,
        parsed.data.name,
        parsed.data.displayName,
        parsed.data.description,
        JSON.stringify({
          url: parsed.data.url,
          method: parsed.data.method,
          supportsIdempotency: parsed.data.supportsIdempotency,
        }),
        parsed.data.approvalRequired ? 1 : 0,
        now,
      )
      .run();
    await writeAudit(actor.id, 'tool.connected', 'tool', id, {
      name: parsed.data.name,
      kind: 'http',
    });
    return NextResponse.json(
      { id, kind: 'http', ...parsed.data, createdAt: now },
      { status: 201 },
    );
  } catch (error) {
    if (error instanceof Response) return error;
    const message = error instanceof Error ? error.message : 'Unexpected error';
    return NextResponse.json(
      {
        error: message.includes('UNIQUE')
          ? 'A tool with that name already exists.'
          : message,
      },
      { status: message.includes('UNIQUE') ? 409 : 500 },
    );
  }
}
