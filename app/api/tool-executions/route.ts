import { env } from 'cloudflare:workers';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { z } from 'zod';

import {
  DEFAULT_WORKSPACE_ID,
  requireActor,
  writeAudit,
} from '@/lib/server-data';
import {
  drainToolExecutions,
  processToolExecution,
} from '@/lib/tool-executions';

const drainInput = z.object({
  executionId: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(50).default(10),
});

export async function GET(request: NextRequest) {
  try {
    await requireActor(request, 'operator');
    const result = await env.DB.prepare(
      `SELECT id, run_id, approval_id, tool_name, status, attempts, max_attempts, retry_safe,
        next_attempt_at, error, created_at, updated_at, finished_at
       FROM tool_executions WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 100`,
    )
      .bind(DEFAULT_WORKSPACE_ID)
      .all();
    return NextResponse.json({ executions: result.results });
  } catch (error) {
    return toResponse(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const actor = await requireActor(request, 'operator');
    const parsed = drainInput.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json(
        {
          error: 'Invalid tool-execution request',
          issues: z.treeifyError(parsed.error),
        },
        { status: 400 },
      );
    }
    const executions = parsed.data.executionId
      ? [
          await processToolExecution(
            parsed.data.executionId,
            DEFAULT_WORKSPACE_ID,
          ),
        ]
      : await drainToolExecutions(DEFAULT_WORKSPACE_ID, parsed.data.limit);
    await writeAudit(
      actor.id,
      'tool_executions.drained',
      'tool_execution',
      parsed.data.executionId ?? 'queue',
      {
        count: executions.length,
      },
    );
    return NextResponse.json({ executions });
  } catch (error) {
    return toResponse(error);
  }
}

function toResponse(error: unknown) {
  if (error instanceof Response) return error;
  const message = error instanceof Error ? error.message : 'Unexpected error';
  return NextResponse.json(
    { error: message },
    { status: message.includes('not found') ? 404 : 500 },
  );
}
