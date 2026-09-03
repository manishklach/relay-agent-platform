# Operations runbook

## Durable tool-execution queue

Approved mutating actions are persisted in `tool_executions` before execution. Normal approval requests attempt the queued job immediately; interrupted or transiently failed work remains durable and can be recovered through `POST /api/tool-executions` by an operator.

The queue states are:

- `queued`: persisted and ready for its first claim.
- `running`: owned by one worker until `lease_expires_at`.
- `retry_scheduled`: an idempotent attempt failed and is waiting for bounded backoff.
- `succeeded`: the result and run trace were committed.
- `dead_letter`: an idempotent job exhausted its attempt budget.
- `unknown`: a non-idempotent action may have happened and must not be replayed automatically.

## Routine recovery

1. Inspect `GET /api/tool-executions` as an operator.
2. Call `POST /api/tool-executions` with `{ "limit": 10 }` to claim due queued/retry jobs and recover expired idempotent leases.
3. Confirm `queuedToolExecutions` returns to zero in `/api/overview`.
4. Investigate every nonzero `toolExecutionsNeedingAttention` value.

## Interrupted agent runs

Every new run has a `run_checkpoints` row. A synchronous request owns a lease while it advances provider and tool steps. If the Worker terminates, the run remains `running`; after the lease expires it becomes claimable without losing its provider context, tool cursor, trace sequence, or accumulated budgets.

Call `POST /api/runs/resume` with `{ "runId": "run_..." }` to recover one interrupted run, or `{ "limit": 5 }` to drain a bounded batch of ready/expired checkpoints. A `409` for a named run means it is actively leased, already terminal, waiting for approval, or otherwise not resumable. Monitor `resumableRunsReady` and `expiredRunLeases` from `/api/overview`; both should normally be zero.

Use `defer: true` with `POST /api/runs` when execution should be queued rather than held open on the initiating HTTP request. The resume drain is safe to invoke concurrently because each worker must win the D1 lease claim.

Until scheduled Worker triggers are configured by the deployment platform, invoke both the tool-execution drain and run-resume endpoints from an authenticated external scheduler at least once per minute. The endpoints are workspace-scoped, role-protected, bounded per call, and safe to invoke concurrently.

## Unknown outcomes

Never blindly replay an `unknown` execution. Use its approval ID, tool name, persisted arguments, idempotency key, timestamps, and the downstream system's audit trail to determine whether the side effect occurred. If it occurred, reconcile the downstream reference into an operator audit record; if it provably did not, create a new approval rather than mutating the old job. Preserve the original record for incident analysis.

HTTP tools should advertise `supportsIdempotency` only when the downstream endpoint durably deduplicates the `Idempotency-Key` header and returns the original result for replays. A header that is merely accepted or logged is not sufficient.

## Graph runs and improvement proposals

`POST /api/graphs/run` starts a live graph with `{ "graphId": "graph_...", "input": "..." }`. Resume an approval-waiting or interrupted run with `{ "runId": "graph_run_..." }`. A `409` means another worker owns the lease or the graph is terminal. Inspect the pinned graph/agent versions and checkpoint through `GET /api/graphs/run`; never edit stored checkpoint JSON manually.

An improvement moves through `pending_evaluation → awaiting_approval → approved → activated`. Evaluation is claimed with a unique evaluation-run reference so concurrent evaluators cannot both advance it. A score below the proposal threshold moves directly to `rejected`. Owners should review the evaluation details and candidate diff before approval, then activate in a separate request. Activation rejects stale proposals whose base is no longer active.

Use `POST /api/agents/versions` with an archived `versionId` and incident reason for rollback. Rollback copies the known-good configuration into a new monotonic active version; it does not delete history or reactivate an old row in place. Existing graph versions remain pinned to their original snapshots.

## Alert thresholds

Alert immediately when `toolExecutionsNeedingAttention` is nonzero. Warn when `queuedToolExecutions` remains nonzero for more than two drain intervals, or when a `running` lease remains expired after a drain. Correlate incidents by run ID, approval ID, execution ID, and the attributed audit entries.

## Deployment and rollback

Apply migrations through `drizzle/0005_fine_squadron_supreme.sql` in order before deploying code that uses durable executions, graphs, or immutable versions. The application bootstrap creates the tables idempotently for local environments, but production migrations should be explicit and backed up. Rolling application code back does not remove the tables; keep them intact so checkpoints, execution history, and ambiguous outcomes are not lost.
