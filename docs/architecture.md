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
- `approvals`: human decisions for state-changing calls.
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
