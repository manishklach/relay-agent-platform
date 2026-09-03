# Relay architecture

Relay is a small, production-shaped agent operations platform. It deliberately keeps one deployable application and one durable database while preserving clear seams between configuration, execution, governance, and evaluation.

## Product loop

```text
Agent Studio
  -> versioned configuration (model, prompt, tool allowlist, guardrails)
  -> execution runtime
       -> input guardrails
       -> model provider
       -> approved tool registry
       -> human approval gate for writes
       -> output redaction
  -> immutable run and step traces
  -> evaluation suites
  -> release decision
```

## Runtime

The deterministic `mock` provider makes local development and evaluation reproducible without credentials. When `OPENAI_API_KEY` is present, an agent configured with provider `openai` uses the Responses API at `OPENAI_BASE_URL`. The runtime preserves response output items across tool turns, returns function-call outputs by `call_id`, disables provider-side storage, and caps each agent run at four model turns.

The model receives only tools listed in the agent's `allowed_tools`. Built-in tools execute inside the Worker. Custom HTTP tools call public HTTPS endpoints; loopback and common private-network destinations are rejected. Mutating tools stop before execution and create an approval record. An operator can approve or reject the exact captured arguments.

### Prompt-injection threat model

Relay's prompt-injection matcher is deliberately a weak first-line tripwire. It normalizes common Unicode spacing tricks and blocks conspicuous requests to ignore instructions, reveal privileged prompts, or bypass policy. It cannot reliably identify semantic attacks, arbitrary encodings, translated instructions, novel phrasing, or instructions hidden in otherwise legitimate data. A passing match is not proof that content is safe.

User input, tool output, and final model output are inspected. Tool output containing an obvious instruction override is withheld before it can be returned to the model. Final model output is withheld when it claims to have bypassed the tool allowlist or contains common secret material. These checks reduce exposure but do not guarantee prompt-injection resistance or secret detection.

The enforceable boundaries are independent of the matcher: the runtime exposes only each agent's allowlisted tools, rejects unregistered tool calls, gates mutating calls for operator approval, and keeps credentials outside prompts and tool results. Integrations should return narrow structured data, use least-privilege credentials, and be treated as untrusted even when the lexical check passes.

## Data model

- `workspaces` and `workspace_members`: tenancy and roles.
- `agents`: model, prompt, lifecycle, tools, and guardrail configuration.
- `tools`: built-in, HTTP, and future MCP integration metadata.
- `runs` and `run_steps`: outcomes, cost/latency, and ordered traces.
- `run_checkpoints`: versioned model context, tool cursor, budget counters, and execution lease.
- `approvals`: human decisions for state-changing calls.
- `tool_executions`: durable, leased, idempotency-keyed jobs for approved external actions.
- `evaluation_suites`, `evaluation_cases`, and `evaluation_runs`: regression gates.
- `audit_logs`: attributed administrative and operational actions.

Cloudflare D1 is the authoritative store. `db/schema.ts` defines the Drizzle schema, generated migrations live in `drizzle/`, and `db/bootstrap.ts` provides idempotent local initialization and reference data.

## Authorization

Hosted requests use Sites' ChatGPT identity headers. The first authenticated member becomes the workspace owner; later new members default to viewer. API mutations require `builder` or `operator` privileges. Localhost receives an explicit `local-dev` owner identity so the full platform works without external authentication during development.

## Deployment

The application builds to Cloudflare Worker-compatible ESM through Vinext, the Cloudflare Vite plugin, and the Sites Vite plugin. `vite.config.ts` is the authoritative build configuration and the `vinext` CLI is the only development/build entrypoint. The `app/` router is a Next-compatible source convention consumed by Vinext; there is no separate Next.js CLI build. `.openai/hosting.json` declares the D1 binding. Secrets remain runtime environment values and are never stored in D1 or delivered to the browser.

## Deliberate boundaries

- One workspace is exposed in the first release, although every operational table carries a workspace identifier.
- HTTP tools support public endpoints without stored credentials. Managed secret references and OAuth are later integration work.
- MCP is represented in the registry but remote MCP transport is not enabled yet.
- The evaluation engine currently provides deterministic contains/not-contains graders. Model-graded rubrics can be added behind the same suite abstraction.

## Evaluation grader extension point

Evaluation execution resolves each case's `grader_type` through `GraderRegistry`. A grader receives the agent output plus the case's existing `expected_json` configuration and returns a pass/fail result, normalized score, and optional reason. Graders may be synchronous or asynchronous, so a future rubric grader can call a model without changing the evaluation-suite schema, endpoint shape, or execution loop. Registering such a grader still requires explicit code/configuration review; Relay intentionally ships without an LLM grader or grader credentials.

## Provider and execution safety boundary

Model access is resolved through an explicit `ProviderRegistry`; unknown providers fail closed. `OpenAICompatibleProvider` owns its wire protocol, response schema validation, response-size limit, per-attempt timeout, and bounded transient retries. Retries reuse one idempotency key for the logical model request. An agent configured for OpenAI cannot silently fall back to deterministic mock output when credentials are unavailable.

`ExecutionBudgetTracker` enforces independent ceilings for model turns, tool calls, input tokens, output tokens, estimated cost, elapsed time, serialized context bytes, and per-tool result bytes. Limits and accumulated usage survive resume through the checkpoint.

## Resumable model execution

Each run begins with a schema-versioned `run_checkpoints` row. The runtime checkpoints before a provider request, after its response, after every tool cursor transition, and during finalization. Provider idempotency keys derive deterministically from run ID and turn, so resuming the same model turn does not invent a new logical request. Checkpoints preserve complete provider input items, pending function calls, the next tool cursor, trace sequence, token/cost counters, and original start time.

A conditional D1 lease permits only one worker to advance a checkpoint. A normal request executes synchronously, while `defer: true` creates a ready checkpoint for asynchronous processing. `POST /api/runs/resume` claims either one named run or a bounded batch of ready/expired checkpoints. Completed, failed, approval-waiting, and actively leased runs cannot be resumed. Every operation is workspace-scoped and requires the operator role.

Context is measured as serialized UTF-8 bytes before each provider call and after provider/tool additions. Oversized tool results are replaced with a structural truncation marker before entering model context or traces. Exceeding the total context limit fails the run deterministically instead of exhausting Worker memory. This is deterministic bounding, not semantic summarization; an attributed summarization policy is still future work for long-lived conversational agents.

## Durable approved actions

An approval decision and its `tool_executions` job are written in one D1 batch before external work begins. A worker conditionally claims a job with an expiring lease, increments its attempt counter, and sends the persisted idempotency key to the tool. A successful result, deterministic trace step, and final run status are committed together. Concurrent drains cannot claim the same live lease, and the unique approval/idempotency indexes prevent duplicate jobs.

Retries are deliberately asymmetric. Built-ins with stable results and HTTP tools explicitly configured with `supportsIdempotency` may retry with bounded exponential backoff. A non-idempotent execution that fails or loses its lease moves to `unknown` and fails the run for operator reconciliation; Relay does not pretend the external action did not happen. Exhausted safe retries move to `dead_letter`. Every query and claim is workspace-scoped.
