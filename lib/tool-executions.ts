import { env } from 'cloudflare:workers';
import { z } from 'zod';

import { failureDisposition } from './tool-execution-policy';
import { supportsIdempotentExecution } from './tool-contract';
import { executeRuntimeTool, loadRuntimeTools } from './tools';

const LEASE_DURATION_MS = 30_000;
const jobRowSchema = z.object({
  id: z.string(),
  workspace_id: z.string(),
  run_id: z.string(),
  approval_id: z.string(),
  tool_name: z.string(),
  arguments_json: z.string(),
  idempotency_key: z.string(),
  retry_safe: z.coerce.number().int().transform(Boolean),
  status: z.enum([
    'queued',
    'running',
    'retry_scheduled',
    'succeeded',
    'dead_letter',
    'unknown',
  ]),
  attempts: z.coerce.number().int().nonnegative(),
  max_attempts: z.coerce.number().int().positive(),
  lease_owner: z.string().nullable(),
  lease_expires_at: z.coerce.number().int().nullable(),
  next_attempt_at: z.coerce.number().int(),
  result_json: z.string().nullable(),
  error: z.string().nullable(),
  created_at: z.coerce.number().int(),
  updated_at: z.coerce.number().int(),
  finished_at: z.coerce.number().int().nullable(),
});

const argumentsSchema = z.record(z.string(), z.unknown());

export type ToolExecutionStatus = z.infer<typeof jobRowSchema>['status'];
export type ToolExecutionResult = {
  id: string;
  runId: string;
  status: ToolExecutionStatus;
  attempts: number;
  result?: Record<string, unknown>;
  error?: string;
  nextAttemptAt?: number;
};

export async function processToolExecution(
  executionId: string,
  workspaceId: string,
  options: { workerId?: string; now?: () => number } = {},
): Promise<ToolExecutionResult> {
  const now = options.now ?? Date.now;
  const claimedAt = now();
  const workerId = options.workerId ?? `worker_${crypto.randomUUID()}`;

  await reconcileExpiredUnsafeJob(executionId, workspaceId, claimedAt);
  const claimed = await env.DB.prepare(
    `UPDATE tool_executions
     SET status = 'running', attempts = attempts + 1, lease_owner = ?, lease_expires_at = ?,
         updated_at = ?, error = NULL
     WHERE id = ? AND workspace_id = ? AND (
       (status IN ('queued', 'retry_scheduled') AND next_attempt_at <= ?)
       OR (status = 'running' AND retry_safe = 1 AND lease_expires_at <= ?)
     )`,
  )
    .bind(
      workerId,
      claimedAt + LEASE_DURATION_MS,
      claimedAt,
      executionId,
      workspaceId,
      claimedAt,
      claimedAt,
    )
    .run();

  if (claimed.meta.changes !== 1) return loadResult(executionId, workspaceId);
  const job = await loadJob(executionId, workspaceId);

  try {
    const [tool] = await loadRuntimeTools(job.workspace_id, [job.tool_name]);
    if (!tool) throw new Error('Approved tool is no longer available.');
    if (supportsIdempotentExecution(tool) !== job.retry_safe) {
      throw new Error('Tool idempotency configuration changed after approval.');
    }
    const args = parseArguments(job.arguments_json);
    const result = await executeRuntimeTool(tool, args, {
      idempotencyKey: job.idempotency_key,
    });
    const finishedAt = now();
    const statements = await env.DB.batch([
      env.DB.prepare(
        `UPDATE tool_executions
         SET status = 'succeeded', result_json = ?, lease_owner = NULL, lease_expires_at = NULL,
             updated_at = ?, finished_at = ?
         WHERE id = ? AND status = 'running' AND lease_owner = ?`,
      ).bind(JSON.stringify(result), finishedAt, finishedAt, job.id, workerId),
      env.DB.prepare(
        `INSERT OR IGNORE INTO run_steps (
          id, run_id, sequence, kind, name, status, input_json, output_json, duration_ms, created_at
        ) SELECT ?, run_id, (SELECT COALESCE(MAX(sequence), -1) + 1 FROM run_steps WHERE run_id = tool_executions.run_id),
          'tool', tool_name, 'succeeded', arguments_json, ?, ?, ?
          FROM tool_executions WHERE id = ? AND status = 'succeeded' AND result_json = ?`,
      ).bind(
        `execution_step_${job.id}`,
        JSON.stringify(result),
        Math.max(0, finishedAt - claimedAt),
        finishedAt,
        job.id,
        JSON.stringify(result),
      ),
      env.DB.prepare(
        `UPDATE runs SET status = 'succeeded', output = ?, error = NULL, finished_at = ?
         WHERE id = (SELECT run_id FROM tool_executions WHERE id = ? AND status = 'succeeded' AND result_json = ?)`,
      ).bind(successOutput(result), finishedAt, job.id, JSON.stringify(result)),
      env.DB.prepare(
        `UPDATE run_checkpoints SET status = 'completed', updated_at = ?, lease_owner = NULL, lease_expires_at = NULL
         WHERE run_id = ? AND workspace_id = ? AND status = 'waiting_approval'`,
      ).bind(finishedAt, job.run_id, job.workspace_id),
    ]);
    if (statements[0]?.meta.changes !== 1) {
      throw new Error(
        'Tool execution lease was lost before the result could be committed.',
      );
    }
    return {
      id: job.id,
      runId: job.run_id,
      status: 'succeeded',
      attempts: job.attempts,
      result,
    };
  } catch (error) {
    return recordFailure(job, workerId, error, now());
  }
}

export async function drainToolExecutions(
  workspaceId: string,
  limit = 10,
): Promise<ToolExecutionResult[]> {
  const boundedLimit = Math.max(1, Math.min(limit, 50));
  const now = Date.now();
  const staleUnsafe = await env.DB.prepare(
    `SELECT id FROM tool_executions
     WHERE workspace_id = ? AND status = 'running' AND retry_safe = 0 AND lease_expires_at <= ?
     ORDER BY lease_expires_at LIMIT ?`,
  )
    .bind(workspaceId, now, boundedLimit)
    .all<{ id: string }>();
  for (const item of staleUnsafe.results)
    await reconcileExpiredUnsafeJob(item.id, workspaceId, now);

  const available = await env.DB.prepare(
    `SELECT id FROM tool_executions
     WHERE workspace_id = ? AND ((status IN ('queued', 'retry_scheduled') AND next_attempt_at <= ?)
        OR (status = 'running' AND retry_safe = 1 AND lease_expires_at <= ?)
     ) ORDER BY next_attempt_at, created_at LIMIT ?`,
  )
    .bind(workspaceId, now, now, boundedLimit)
    .all<{ id: string }>();

  const results: ToolExecutionResult[] = [];
  for (const item of available.results)
    results.push(await processToolExecution(item.id, workspaceId));
  return results;
}

async function reconcileExpiredUnsafeJob(
  executionId: string,
  workspaceId: string,
  now: number,
): Promise<void> {
  const result = await env.DB.prepare(
    `UPDATE tool_executions
     SET status = 'unknown', error = 'Execution lease expired after a non-idempotent tool call; operator reconciliation is required.',
         lease_owner = NULL, lease_expires_at = NULL, updated_at = ?, finished_at = ?
     WHERE id = ? AND workspace_id = ? AND status = 'running' AND retry_safe = 0 AND lease_expires_at <= ?`,
  )
    .bind(now, now, executionId, workspaceId, now)
    .run();
  if (result.meta.changes === 1) {
    await markRunFailed(
      executionId,
      now,
      'External action outcome is unknown; operator reconciliation is required.',
    );
  }
}

async function recordFailure(
  job: z.infer<typeof jobRowSchema>,
  workerId: string,
  error: unknown,
  now: number,
): Promise<ToolExecutionResult> {
  const message =
    error instanceof Error ? error.message : 'Unknown tool execution error';
  const disposition = failureDisposition(
    {
      retrySafe: job.retry_safe,
      attempts: job.attempts,
      maxAttempts: job.max_attempts,
    },
    now,
  );
  const updated = await env.DB.prepare(
    `UPDATE tool_executions
     SET status = ?, next_attempt_at = ?, error = ?, lease_owner = NULL, lease_expires_at = NULL,
         updated_at = ?, finished_at = ?
     WHERE id = ? AND status = 'running' AND lease_owner = ?`,
  )
    .bind(
      disposition.status,
      disposition.nextAttemptAt,
      message.slice(0, 1_000),
      now,
      disposition.terminal ? now : null,
      job.id,
      workerId,
    )
    .run();
  if (updated.meta.changes !== 1) {
    return {
      id: job.id,
      runId: job.run_id,
      status: 'unknown',
      attempts: job.attempts,
      error: 'Execution lease was lost.',
    };
  }
  if (disposition.terminal) await markRunFailed(job.id, now, message);
  return {
    id: job.id,
    runId: job.run_id,
    status: disposition.status,
    attempts: job.attempts,
    error: message,
    nextAttemptAt: disposition.terminal ? undefined : disposition.nextAttemptAt,
  };
}

async function markRunFailed(
  executionId: string,
  now: number,
  error: string,
): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO run_steps (
        id, run_id, sequence, kind, name, status, input_json, output_json, duration_ms, created_at
      ) SELECT ?, run_id, (SELECT COALESCE(MAX(sequence), -1) + 1 FROM run_steps WHERE run_id = tool_executions.run_id),
        'tool', tool_name, 'failed', arguments_json, ?, 0, ?
        FROM tool_executions WHERE id = ?`,
    ).bind(
      `execution_step_${executionId}`,
      JSON.stringify({ error }),
      now,
      executionId,
    ),
    env.DB.prepare(
      `UPDATE runs SET status = 'failed', error = ?, finished_at = ?
       WHERE id = (SELECT run_id FROM tool_executions WHERE id = ?)`,
    ).bind(error.slice(0, 1_000), now, executionId),
    env.DB.prepare(
      `UPDATE run_checkpoints SET status = 'failed', updated_at = ?, lease_owner = NULL, lease_expires_at = NULL
       WHERE run_id = (SELECT run_id FROM tool_executions WHERE id = ?)`,
    ).bind(now, executionId),
  ]);
}

async function loadJob(executionId: string, workspaceId: string) {
  const row = await env.DB.prepare(
    'SELECT * FROM tool_executions WHERE id = ? AND workspace_id = ?',
  )
    .bind(executionId, workspaceId)
    .first<Record<string, unknown>>();
  if (!row) throw new Error('Tool execution not found.');
  const parsed = jobRowSchema.safeParse(row);
  if (!parsed.success)
    throw new Error(
      `Invalid persisted tool execution: ${z.prettifyError(parsed.error)}`,
    );
  return parsed.data;
}

async function loadResult(
  executionId: string,
  workspaceId: string,
): Promise<ToolExecutionResult> {
  const job = await loadJob(executionId, workspaceId);
  return {
    id: job.id,
    runId: job.run_id,
    status: job.status,
    attempts: job.attempts,
    result: parseOptionalResult(job.result_json),
    error: job.error ?? undefined,
    nextAttemptAt:
      job.status === 'retry_scheduled' ? job.next_attempt_at : undefined,
  };
}

function parseArguments(value: string): Record<string, unknown> {
  let decoded: unknown;
  try {
    decoded = JSON.parse(value);
  } catch {
    throw new Error('Persisted tool arguments contain malformed JSON.');
  }
  const parsed = argumentsSchema.safeParse(decoded);
  if (!parsed.success)
    throw new Error('Persisted tool arguments must be a JSON object.');
  return parsed.data;
}

function parseOptionalResult(
  value: string | null,
): Record<string, unknown> | undefined {
  if (!value) return undefined;
  try {
    const parsed = argumentsSchema.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function successOutput(result: Record<string, unknown>): string {
  const reference =
    typeof result.reference === 'string' ? result.reference : 'recorded';
  return `Approved action completed. Reference: ${reference}`;
}
