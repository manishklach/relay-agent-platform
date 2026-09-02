# Relay architecture and refactoring audit

Audit target: `codex/hardening-review` after PR #1 hardening changes  
Audit date: 2026-09-02

## Executive summary

**Overall rating: 5.2 / 10 for a production agent-orchestration platform.**

Relay is a coherent and understandable single-agent operations MVP. Its strongest qualities are a small deployment footprint, server-enforced roles, parameterized D1 queries, persistent run/step records, a deterministic four-model-turn ceiling, explicit tool allowlists, human approval gates, boundary validation with Zod, and focused tests for SSRF and safety policies.

The main architectural mismatch is that Relay does not currently implement a relay mechanism between agents. A run invokes one configured agent with one user input; there is no durable conversation, task graph, agent-to-agent message envelope, handoff protocol, checkpoint, or resumable workflow state. This is acceptable for the stated MVP but not yet an architecture for multi-agent orchestration.

The highest production risks are incomplete run/approval recovery around external side effects, no context-window policy, provider/tool payloads that become trusted through TypeScript casts rather than runtime schemas, and a hard-coded single-workspace membership bootstrap that can race when the first users arrive. D1 traces are useful product observability, but they are not a substitute for correlated logs, metrics, distributed traces, alerting, or operational retry controls.

### Scorecard

| Area | Rating | Assessment |
| --- | ---: | --- |
| Architecture and orchestration | 4/10 | Clear single-agent loop; no actual inter-agent relay, durable workflow, or provider registry |
| State and context handling | 3/10 | Request-local state is bounded by turns, but no conversation persistence, token budget, pruning, summaries, or handoff schema |
| Reliability and control flow | 5/10 | Four-turn loop guard and HTTP-tool bounds exist; model calls, run finalization, retries, and external side effects are not recoverable |
| Type safety and validation | 5/10 | Strong API request schemas; weak DB JSON decoding, LLM argument validation, provider response validation, and frontend response typing |
| Production readiness and DX | 6/10 | Good build/test/docs baseline and useful D1 traces; limited telemetry, config validation, tenancy, and operational controls |

## Multi-pass evaluation

### 1. Architecture and orchestration pattern

#### Relay mechanism

`executeAgent` accepts one `AgentConfig` and one string, then chooses the mock path or OpenAI path (`lib/runtime.ts:16-34`). The OpenAI path maintains an in-memory array for one request and loops for at most four model turns (`lib/runtime.ts:79-175`). The database stores runs and ordered steps, but it has no conversation, message, task, dependency, handoff, checkpoint, or workflow tables (`db/schema.ts:67-107`).

Consequently, agents do not pass tasks, messages, or state to one another. There is no state-transition definition for a relay chain, no durable cursor, and no deterministic resume operation after a Worker interruption. Current transitions are implicit return values such as `succeeded`, `failed`, and `waiting_approval`, distributed between the runtime and routes.

#### Decoupling

The code has useful initial seams: guardrails, safe HTTP, graders, tool policy, and approval decisions are separate modules. However, `lib/runtime.ts` still owns provider selection, OpenAI wire types, orchestration, context assembly, tool dispatch, approval creation intent, cost estimation, and error mapping. `lib/tools.ts` combines catalog metadata, D1 loading, built-in implementations, and transport execution (`lib/tools.ts:6-129`).

The API routes also perform application-service work directly: run creation/finalization is embedded in `app/api/runs/route.ts:38-89`, and approval claiming, tool execution, state persistence, and response formatting are combined in `app/api/approvals/route.ts:38-90`.

#### Extensibility

Adding an agent is data-driven. Adding a deterministic grader is now registry-driven. Adding a provider still requires editing the conditional in `executeAgent` and adding provider-specific code to the central runtime (`lib/runtime.ts:29-33`). `AgentConfig.provider` is just `string` (`lib/types.ts:7`), so unsupported values silently take the OpenAI branch when a key is present.

Adding a tool kind requires edits to the `ToolDefinition` union and the branching executor (`lib/tools.ts:6-13`, `lib/tools.ts:109-129`). Built-in tool schemas are descriptive JSON Schema only; execution remains a name-based conditional.

### 2. State management and context handling

#### Context-window management

The runtime starts with exactly one user message (`lib/runtime.ts:81`) and appends complete provider output items and complete tool results (`lib/runtime.ts:130`, `lib/runtime.ts:172`). There is no model capability lookup, token budget, reserved output budget, truncation, semantic compaction, summary, or maximum tool-result token policy.

The four-turn ceiling (`lib/runtime.ts:87`) prevents an infinite model/tool loop, which is a meaningful safety property. It does not prevent a context overflow: one HTTP tool may return up to 512 KiB and that payload is serialized directly into the next model request. The rough token estimator is used only for reporting fallback counts, not admission control (`lib/runtime.ts:276-281`).

There is no persisted conversation history to prune or summarize. `runs` stores one input and output (`db/schema.ts:67-85`), so a future relay cannot reconstruct a typed message stream or resume from a checkpoint.

#### State serialization

JSON fields are serialized consistently, but deserialization is not schema-safe. `parseJson<T>` asserts a generic type after `JSON.parse` without validation (`lib/server-data.ts:73-79`). Approval arguments are parsed and cast directly before an external action (`app/api/approvals/route.ts:61-65`). Agent fields from D1 are converted with `String` and type assertions (`lib/server-data.ts:51-63`), allowing corrupt or stale data to cross the domain boundary.

Request-local arrays do not present an obvious long-lived memory leak because Workers discard request state. However, large tool results and model output items can cause per-request memory pressure, and the sequential 100-case evaluation loop retains all details until completion (`app/api/evaluations/run/route.ts:34-59`).

### 3. Reliability, error handling, and control flow

#### Error propagation and recovery

Model failures inside the OpenAI loop become a `failed` result (`lib/runtime.ts:176-185`), but model fetches have no timeout, bounded response reader, retry policy, or 429/5xx backoff (`lib/runtime.ts:189-222`). A missing OpenAI key silently changes an `openai` agent into the mock provider (`lib/runtime.ts:29-30`), which is convenient locally but unsafe as a production fallback because a run can appear successful without using the configured provider.

The run row is inserted as `running` before execution (`app/api/runs/route.ts:38-46`). Exceptions that escape `executeAgent`, D1 tool loading, result serialization, or the final batch are converted to an HTTP 500 without a compensating run update (`app/api/runs/route.ts:90-97`). Such runs can remain `running` forever.

Approval claiming is now conditional, so two callers cannot both transition the same pending decision (`app/api/approvals/route.ts:54-59`). The external tool executes after the approval is permanently marked approved but before the run/step batch commits (`app/api/approvals/route.ts:61-88`). A timeout or D1 failure can therefore leave an approved action with an unknown external outcome and no durable retry/idempotency record.

There is no automatic retry or fallback policy. That is preferable to unsafe blind retries for mutating tools, but transient read/model failures need bounded, classified retries, while write retries require idempotency keys and an outbox/job state machine.

#### Loop prevention

The four-turn `for` loop is a strict recursion guard (`lib/runtime.ts:87-175`). Evaluation suites are capped at 100 cases at the API boundary (`app/api/evaluations/route.ts:12-17`). Missing controls include a total run deadline, maximum tool calls, total tool bytes, token/cost budget, and cancellation state.

### 4. Type safety and validation

HTTP API request bodies are generally validated with Zod, including lengths and enum constraints (`app/api/agents/route.ts:8-22`, `app/api/tools/route.ts:8-15`, `app/api/evaluations/route.ts:8-18`). SQL uses bound parameters rather than string-concatenated values; the generated placeholder list is derived from the trusted array length.

The weaker boundary is model and persistence data. Function-call arguments use `safeJsonObject`, which verifies only “object, not array” (`lib/runtime.ts:267-273`); it never validates against `ToolDefinition.parameters`. HTTP tools explicitly advertise `additionalProperties: true` and provider strictness is disabled (`lib/tools.ts:71-76`, `lib/runtime.ts:204-210`). Provider output is cast to a handwritten shape after `response.json()` (`lib/runtime.ts:218-222`). HTTP tool JSON output is parsed and cast to `Record<string, unknown>` without a declared output schema (`lib/tools.ts:125-129`).

Frontend API data is dominated by `Array<Record<string, unknown>>` and assertions after `response.json()` (`components/control-plane.tsx:39-57`, `components/control-plane.tsx:113-121`). This loses compile-time exhaustiveness and makes API drift a runtime concern.

### 5. Production readiness and developer experience

Relay records product-level traces, latency, tokens, estimated cost, errors, evaluations, and audit actions in D1. This is valuable for UI inspection. It lacks structured server logs, request/run correlation IDs propagated to provider and tool calls, OpenTelemetry spans, metrics aggregation, sampling, alert thresholds, and trace export. A Worker/provider failure before final persistence can leave no complete trace.

Environment configuration is small and secrets remain server-side. However, `OPENAI_API_KEY` and `OPENAI_BASE_URL` are read directly from the runtime environment without startup validation or an explicit environment mode (`lib/runtime.ts:29`, `lib/runtime.ts:190-195`). There is no per-provider configuration object, model capability registry, or validated timeout/retry/cost policy.

The build and developer experience are otherwise straightforward: Vinext/Vite is authoritative, unit tests are fast, smoke coverage exercises the product loop, and the project documents deployment. Remaining weaknesses include no CI workflow, no integration test with a mocked OpenAI server, no D1 migration test, and known dependency advisories requiring coordinated upgrades.

## Top architectural bottlenecks

### ARCH-01 — No durable relay or multi-agent orchestration model

- **Severity:** High
- **Location:** `lib/runtime.ts:16-34`, `lib/runtime.ts:79-175`, `db/schema.ts:67-107`
- **Evidence:** The runtime accepts one agent/input and keeps one request-local item array. Persistence contains runs and steps but no typed messages, handoffs, checkpoints, or task dependencies.
- **Impact:** Agent-to-agent delegation, deterministic resumption, replay, cancellation, and branching cannot be added without changing both the runtime and data model. Worker termination loses in-flight orchestration state.
- **Recommendation:** Introduce a durable workflow aggregate with explicit commands/events, typed message envelopes, optimistic versioning, and a small-step executor that checkpoints after every model/tool/handoff transition.

### REL-02 — External side effects and run state are not recoverable

- **Severity:** High
- **Location:** `app/api/runs/route.ts:38-46`, `app/api/runs/route.ts:78-97`, `app/api/approvals/route.ts:54-88`
- **Evidence:** Runs are inserted before execution with no `finally` transition. Approval status is committed before the tool call, while the completion trace is committed afterward.
- **Impact:** Exceptions can leave permanently running runs or approved actions with an unknown outcome. Retrying manually can duplicate a refund or other mutating operation.
- **Recommendation:** Persist a transactional outbox/tool job with a stable idempotency key, execute it asynchronously, and make every terminal transition conditional and replay-safe.

### STATE-03 — No context/token budget or compaction policy

- **Severity:** High
- **Location:** `lib/runtime.ts:81-89`, `lib/runtime.ts:130`, `lib/runtime.ts:172`, `lib/runtime.ts:276-281`
- **Evidence:** Complete provider items and tool results are appended; token estimation is reporting-only.
- **Impact:** Large tool responses can overflow the model context, increase cost unpredictably, or exhaust Worker memory despite the four-turn loop cap.
- **Recommendation:** Add model capability metadata and enforce per-run token, byte, tool-call, elapsed-time, and cost budgets. Compact persisted message history with deterministic truncation plus an attributed summary.

### TYPE-04 — Provider, tool arguments, and persisted JSON are trusted by cast

- **Severity:** High
- **Location:** `lib/types.ts:7`, `lib/runtime.ts:29-33`, `lib/runtime.ts:141`, `lib/runtime.ts:218-222`, `lib/server-data.ts:51-63`, `lib/server-data.ts:73-79`
- **Evidence:** Provider is a free string; malformed LLM argument JSON becomes `{}`; response and database payloads are asserted into types without runtime schemas.
- **Impact:** Unsupported providers can route incorrectly, invalid tool calls can reach implementations, and corrupt data can cause unsafe behavior or misleading successful runs.
- **Recommendation:** Define provider and tool contracts with Zod input/output schemas, parse every external/persisted boundary, and return typed validation failures as trace steps.

### TENANT-05 — Single-workspace authorization bootstrap is race-prone

- **Severity:** High for multi-user exposure; Medium for the current private MVP
- **Location:** `lib/server-data.ts:8`, `lib/server-data.ts:21-39`, all API queries using `DEFAULT_WORKSPACE_ID`
- **Evidence:** Every request targets `ws_default`. A new member counts current rows and then inserts itself as owner/viewer in separate statements.
- **Impact:** Concurrent first requests can both observe zero members and both become owners. The architecture cannot safely expose multiple workspaces or scope a resource by a route-selected tenant.
- **Recommendation:** Provision the first owner explicitly during workspace creation, require membership invitations afterward, and resolve a workspace-scoped authorization context before every resource query.

## Refactoring snippets for the top three issues

These snippets show target seams rather than a drop-in migration. Introduce them incrementally behind the existing API.

### 1. Durable orchestration and relay state

Use explicit commands and persisted events instead of one request-local loop:

```ts
const relayMessageSchema = z.object({
  id: z.string().uuid(),
  runId: z.string(),
  fromAgentId: z.string().nullable(),
  toAgentId: z.string(),
  kind: z.enum(['task', 'result', 'tool_result', 'summary']),
  payload: z.record(z.string(), z.unknown()),
  createdAt: z.number().int(),
});

type RunState = {
  id: string;
  version: number;
  status: 'queued' | 'running' | 'waiting_approval' | 'completed' | 'failed';
  activeAgentId: string;
  stepCount: number;
  messageIds: string[];
};

type OrchestrationCommand =
  | { type: 'invoke_model'; agentId: string }
  | { type: 'invoke_tool'; callId: string; toolName: string; args: unknown }
  | { type: 'handoff'; fromAgentId: string; toAgentId: string; task: unknown }
  | { type: 'complete'; output: string };

interface RunStore {
  load(runId: string): Promise<RunState>;
  append(runId: string, expectedVersion: number, events: readonly object[]): Promise<void>;
}

async function executeNextStep(runId: string, store: RunStore) {
  const state = await store.load(runId);
  enforceBudget(state);
  const command = await decideNextCommand(state);
  const events = await handleCommand(command);
  await store.append(runId, state.version, events); // optimistic concurrency checkpoint
}
```

Each Worker invocation performs one bounded transition. `expectedVersion` prevents two workers from advancing the same run, and every handoff becomes replayable data rather than an in-memory call.

### 2. Transactional outbox for approved tools

Separate the approval decision from external execution and require idempotency at the tool boundary:

```ts
// In one D1 batch: consume pending approval and enqueue one unique job.
await db.batch([
  db.prepare(`
    UPDATE approvals
       SET status = 'approved', decided_at = ?, decided_by = ?
     WHERE id = ? AND status = 'pending'
  `).bind(now, actor.id, approvalId),
  db.prepare(`
    INSERT OR IGNORE INTO tool_jobs
      (id, approval_id, run_id, tool_name, arguments_json, status, attempts, created_at)
    SELECT ?, id, run_id, tool_name, arguments_json, 'queued', 0, ?
      FROM approvals WHERE id = ? AND status = 'approved'
  `).bind(`job_${approvalId}`, now, approvalId),
]);

// Queue/cron consumer. The stable job ID is passed downstream as the idempotency key.
const claimed = await db.prepare(`
  UPDATE tool_jobs SET status = 'running', attempts = attempts + 1
   WHERE id = ? AND status IN ('queued', 'retryable') AND attempts < ?
  RETURNING *
`).bind(jobId, MAX_ATTEMPTS).first<ToolJob>();

if (claimed) {
  const result = await tool.execute(parsedArgs, { idempotencyKey: claimed.id });
  await finalizeJobAndRun(claimed, result); // conditional terminal update
}
```

The production version should use a unique constraint on `approval_id`, classify retryable versus terminal failures, and reconcile jobs left `running` past a lease deadline.

### 3. Context and execution budgets

Make budget enforcement part of orchestration rather than reporting:

```ts
type ExecutionBudget = {
  maxModelTurns: number;
  maxToolCalls: number;
  maxInputTokens: number;
  reserveOutputTokens: number;
  maxToolResultBytes: number;
  deadlineMs: number;
};

async function prepareContext(
  messages: RelayMessage[],
  budget: ExecutionBudget,
  tokens: (value: string) => number,
  summarize: (older: RelayMessage[]) => Promise<RelayMessage>,
) {
  const available = budget.maxInputTokens - budget.reserveOutputTokens;
  const recent: RelayMessage[] = [];
  let used = 0;

  for (const message of messages.toReversed()) {
    const cost = tokens(JSON.stringify(message.payload));
    if (used + cost > available) break;
    recent.unshift(message);
    used += cost;
  }

  const omitted = messages.slice(0, messages.length - recent.length);
  return omitted.length ? [await summarize(omitted), ...recent] : recent;
}

function assertWithinBudget(usage: RunUsage, budget: ExecutionBudget) {
  if (usage.modelTurns >= budget.maxModelTurns) throw new BudgetExceeded('model_turns');
  if (usage.toolCalls >= budget.maxToolCalls) throw new BudgetExceeded('tool_calls');
  if (Date.now() >= budget.deadlineMs) throw new BudgetExceeded('deadline');
}
```

Persist the summary with source message IDs and model/version metadata so replay and audit can distinguish original content from lossy compaction.

## Recommended sequencing

1. Fix run finalization and approved-tool side effects with an outbox/idempotency design.
2. Add runtime Zod schemas for providers, tool arguments/results, and persisted JSON.
3. Introduce explicit execution budgets before enabling larger HTTP-tool responses or conversation history.
4. Extract provider/tool registries and move route orchestration into application services.
5. Add durable relay messages/checkpoints only after the single-agent state machine is replay-safe.
6. Replace implicit first-user ownership with explicit workspace provisioning.
7. Add correlated structured logs and OpenTelemetry spans around API, model, tool, approval, and D1 operations.

## Testing roadmap

- Contract tests for each provider using a mocked Responses-compatible server: malformed JSON, 429, 5xx, timeout, and retry-after.
- Tool schema tests that prove invalid LLM arguments never reach an implementation.
- Crash-point tests around run creation, tool completion, approval claiming, and final D1 persistence.
- Concurrency tests for first-member provisioning and duplicate approval decisions.
- Context-budget tests with large tool payloads, long histories, and summary provenance.
- Replay tests asserting the same persisted events produce the same next command.
- Migration tests that build an empty D1 database and upgrade a previous schema snapshot.
- Telemetry tests verifying one correlation ID spans route, model, tool, and audit records.

## Final assessment

Relay is well-positioned as a small agent-operations reference implementation. It should not yet be described as a multi-agent relay engine or production-safe side-effect orchestrator. The next architectural milestone is not more UI or more tools; it is a durable, typed, budgeted, replay-safe execution core with idempotent external actions.
