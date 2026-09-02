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

Until a scheduled Worker trigger is configured by the deployment platform, invoke the drain endpoint from an authenticated external scheduler at least once per minute. The endpoint is workspace-scoped, role-protected, bounded to 50 jobs per call, and safe to invoke concurrently.

## Unknown outcomes

Never blindly replay an `unknown` execution. Use its approval ID, tool name, persisted arguments, idempotency key, timestamps, and the downstream system's audit trail to determine whether the side effect occurred. If it occurred, reconcile the downstream reference into an operator audit record; if it provably did not, create a new approval rather than mutating the old job. Preserve the original record for incident analysis.

HTTP tools should advertise `supportsIdempotency` only when the downstream endpoint durably deduplicates the `Idempotency-Key` header and returns the original result for replays. A header that is merely accepted or logged is not sufficient.

## Alert thresholds

Alert immediately when `toolExecutionsNeedingAttention` is nonzero. Warn when `queuedToolExecutions` remains nonzero for more than two drain intervals, or when a `running` lease remains expired after a drain. Correlate incidents by run ID, approval ID, execution ID, and the attributed audit entries.

## Deployment and rollback

Apply `drizzle/0002_third_the_hood.sql` before deploying code that uses durable executions. The application bootstrap creates the table idempotently for local environments, but production migrations should be explicit and backed up. Rolling application code back does not remove the table; keep it intact so execution history and ambiguous outcomes are not lost.
