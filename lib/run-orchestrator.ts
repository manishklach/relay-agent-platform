import { env } from 'cloudflare:workers';

import { executeAgent } from './runtime';
import { persistRunProgress } from './run-checkpoints';
import type { ModelRuntimeCheckpoint } from './runtime-checkpoint';
import type { AgentConfig, RuntimeResult } from './types';

export type PersistedRunResult = RuntimeResult & {
  id: string;
  agentId: string;
  agentName: string;
  input: string;
  approvalId?: string;
  latencyMs: number;
  createdAt: number;
};

export async function executeLeasedRun(input: {
  runId: string;
  workspaceId: string;
  agent: AgentConfig;
  prompt: string;
  leaseOwner: string;
  checkpoint: ModelRuntimeCheckpoint;
}): Promise<PersistedRunResult> {
  let latestCheckpoint = input.checkpoint;
  const result = await executeAgent(input.agent, input.prompt, {
    runId: input.runId,
    checkpoint: input.checkpoint,
    onProgress: ({ checkpoint, steps }) => {
      latestCheckpoint = checkpoint;
      return persistRunProgress(
        input.runId,
        input.workspaceId,
        input.leaseOwner,
        checkpoint,
        steps,
      );
    },
  });
  const finishedAt = Date.now();
  const checkpointStatus =
    result.status === 'waiting_approval'
      ? 'waiting_approval'
      : result.status === 'succeeded'
        ? 'completed'
        : 'failed';
  const approvalId = result.pendingApproval
    ? `approval_${input.runId}`
    : undefined;
  const statements = [
    env.DB.prepare(
      `UPDATE run_checkpoints
       SET status = ?, state_json = ?, version = version + 1, lease_owner = NULL,
           lease_expires_at = NULL, updated_at = ?
       WHERE run_id = ? AND workspace_id = ? AND status = 'running' AND lease_owner = ?`,
    ).bind(
      checkpointStatus,
      JSON.stringify(latestCheckpoint),
      finishedAt,
      input.runId,
      input.workspaceId,
      input.leaseOwner,
    ),
    ...result.steps.map((item) =>
      env.DB.prepare(
        `INSERT OR IGNORE INTO run_steps (
        id, run_id, sequence, kind, name, status, input_json, output_json, duration_ms, created_at
      ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        WHERE EXISTS (SELECT 1 FROM run_checkpoints
          WHERE run_id = ? AND workspace_id = ? AND status = ? AND updated_at = ?)`,
      ).bind(
        item.id,
        input.runId,
        item.sequence,
        item.kind,
        item.name,
        item.status,
        JSON.stringify(item.input),
        JSON.stringify(item.output),
        item.durationMs,
        finishedAt,
        input.runId,
        input.workspaceId,
        checkpointStatus,
        finishedAt,
      ),
    ),
    env.DB.prepare(
      `UPDATE runs SET status = ?, output = ?, latency_ms = ?, input_tokens = ?, output_tokens = ?,
        estimated_cost_usd = ?, error = ?, finished_at = ?
       WHERE id = ? AND workspace_id = ? AND EXISTS (SELECT 1 FROM run_checkpoints
         WHERE run_id = ? AND workspace_id = ? AND status = ? AND updated_at = ?)`,
    ).bind(
      result.status,
      result.output,
      finishedAt - latestCheckpoint.startedAt,
      result.inputTokens,
      result.outputTokens,
      result.estimatedCostUsd,
      result.error ?? null,
      finishedAt,
      input.runId,
      input.workspaceId,
      input.runId,
      input.workspaceId,
      checkpointStatus,
      finishedAt,
    ),
  ];
  if (result.pendingApproval && approvalId) {
    statements.push(
      env.DB.prepare(
        `INSERT OR IGNORE INTO approvals (
        id, workspace_id, run_id, tool_name, arguments_json, status, requested_at
      ) SELECT ?, ?, ?, ?, ?, 'pending', ?
        WHERE EXISTS (SELECT 1 FROM run_checkpoints
          WHERE run_id = ? AND workspace_id = ? AND status = 'waiting_approval' AND updated_at = ?)`,
      ).bind(
        approvalId,
        input.workspaceId,
        input.runId,
        result.pendingApproval.toolName,
        JSON.stringify(result.pendingApproval.arguments),
        finishedAt,
        input.runId,
        input.workspaceId,
        finishedAt,
      ),
    );
  }
  const persisted = await env.DB.batch(statements);
  if (persisted[0]?.meta.changes !== 1)
    throw new Error('Run checkpoint lease was lost before finalization.');
  return {
    id: input.runId,
    agentId: input.agent.id,
    agentName: input.agent.name,
    input: input.prompt,
    ...result,
    approvalId,
    latencyMs: finishedAt - latestCheckpoint.startedAt,
    createdAt: latestCheckpoint.startedAt,
  };
}
