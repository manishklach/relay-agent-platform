import { env } from 'cloudflare:workers';

import {
  parseModelCheckpoint,
  type ModelRuntimeCheckpoint,
} from './runtime-checkpoint';
import type { RuntimeStep } from './types';

// Longer than the maximum configurable run deadline, preventing a live slow
// provider request from being stolen by a second worker.
const LEASE_DURATION_MS = 930_000;

export type StoredRunCheckpoint = {
  state: ModelRuntimeCheckpoint;
  status: 'ready' | 'running' | 'waiting_approval' | 'completed' | 'failed';
  version: number;
  leaseOwner: string | null;
  leaseExpiresAt: number | null;
};

export async function claimRunCheckpoint(
  runId: string,
  workspaceId: string,
  leaseOwner: string,
  now = Date.now(),
): Promise<boolean> {
  const result = await env.DB.prepare(
    `UPDATE run_checkpoints
     SET status = 'running', lease_owner = ?, lease_expires_at = ?, updated_at = ?, version = version + 1
     WHERE run_id = ? AND workspace_id = ? AND status IN ('ready', 'running')
       AND (lease_owner IS NULL OR lease_expires_at <= ? OR lease_owner = ?)`,
  )
    .bind(
      leaseOwner,
      now + LEASE_DURATION_MS,
      now,
      runId,
      workspaceId,
      now,
      leaseOwner,
    )
    .run();
  return result.meta.changes === 1;
}

export async function loadRunCheckpoint(
  runId: string,
  workspaceId: string,
): Promise<StoredRunCheckpoint> {
  const row = await env.DB.prepare(
    `SELECT state_json, status, version, lease_owner, lease_expires_at
     FROM run_checkpoints WHERE run_id = ? AND workspace_id = ?`,
  )
    .bind(runId, workspaceId)
    .first<Record<string, unknown>>();
  if (!row) throw new Error('Run checkpoint not found.');
  const status = String(row.status) as StoredRunCheckpoint['status'];
  if (
    !['ready', 'running', 'waiting_approval', 'completed', 'failed'].includes(
      status,
    )
  ) {
    throw new Error('Persisted run checkpoint has an invalid status.');
  }
  return {
    state: parseModelCheckpoint(String(row.state_json)),
    status,
    version: Number(row.version),
    leaseOwner: typeof row.lease_owner === 'string' ? row.lease_owner : null,
    leaseExpiresAt:
      row.lease_expires_at === null ? null : Number(row.lease_expires_at),
  };
}

export async function persistRunProgress(
  runId: string,
  workspaceId: string,
  leaseOwner: string,
  checkpoint: ModelRuntimeCheckpoint,
  steps: readonly RuntimeStep[] = [],
): Promise<void> {
  const now = Date.now();
  const statements = [
    env.DB.prepare(
      `UPDATE run_checkpoints
       SET state_json = ?, version = version + 1, lease_expires_at = ?, updated_at = ?
       WHERE run_id = ? AND workspace_id = ? AND status = 'running' AND lease_owner = ?`,
    ).bind(
      JSON.stringify(parseModelCheckpoint(checkpoint)),
      now + LEASE_DURATION_MS,
      now,
      runId,
      workspaceId,
      leaseOwner,
    ),
  ];
  for (const step of steps) {
    statements.push(
      env.DB.prepare(
        `INSERT OR IGNORE INTO run_steps (
        id, run_id, sequence, kind, name, status, input_json, output_json, duration_ms, created_at
      ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        WHERE EXISTS (SELECT 1 FROM run_checkpoints
          WHERE run_id = ? AND workspace_id = ? AND status = 'running' AND lease_owner = ?)`,
      ).bind(
        step.id,
        runId,
        step.sequence,
        step.kind,
        step.name,
        step.status,
        JSON.stringify(step.input),
        JSON.stringify(step.output),
        step.durationMs,
        now,
        runId,
        workspaceId,
        leaseOwner,
      ),
    );
  }
  const results = await env.DB.batch(statements);
  if (results[0]?.meta.changes !== 1)
    throw new Error('Run checkpoint lease was lost.');
}
