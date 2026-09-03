# Changelog

All notable changes to Relay are documented here.

## [Unreleased]

### Versioned graphs and governed self-improvement

- Add immutable agent versions containing prompts, provider/model settings, tool allowlists, and guardrails.
- Add strict versioned graph schemas, deterministic conditional transitions, explicit loop budgets, pinned agent versions, leased checkpoints, and durable child runs.
- Pause and resume graph nodes across human approval without consuming a second visit.
- Add evaluation-gated improvement candidates with single-evaluator claims, score thresholds, owner approval, stale-base protection, explicit activation, and audited rollback copies.
- Extend the smoke suite across graph execution, graph approval/resume, candidate evaluation/activation, and rollback.

### Provider and runtime production safety

- Add an explicit provider registry and a runtime-validated OpenAI-compatible response boundary.
- Fail closed instead of silently switching an OpenAI-configured agent to mock output when credentials are absent.
- Bound model calls by timeout, response bytes, and retry attempts; reuse one idempotency key across transient retries.
- Enforce per-run model-turn, tool-call, token, estimated-cost, and elapsed-time budgets.
- Validate all safety configuration, including HTTPS-only provider endpoints in production.
- Add CI for linting, type checking, unit tests, and production builds.
- Add focused tests for configuration, budgets, retry classification, idempotency, timeout, size caps, and malformed provider responses.
- Upgrade React Server Components, Vinext, Vite, Cloudflare tooling, and transitive production packages to clear the production dependency audit.

### Durable approved tool execution

- Persist approved mutating actions as unique, idempotency-keyed D1 jobs before calling external systems.
- Add conditional leases, bounded retry scheduling, dead-letter state, and explicit unknown-outcome handling.
- Propagate idempotency keys to HTTP connectors and make the reference refund tool replay-stable.
- Add workspace-scoped operator APIs for queue inspection and recovery draining.
- Separate pure tool contracts, built-in implementations, retry policy, and Cloudflare transport for safer extension and unit testing.
- Add operational queue metrics, a recovery/reconciliation runbook, a generated migration, and end-to-end approval replay coverage.

### Resumable agent runs

- Persist schema-versioned model context, pending tool cursors, trace sequences, and accumulated budgets in D1.
- Use stable per-run/turn provider idempotency keys and conditional execution leases.
- Add synchronous, deferred, named-resume, and bounded resume-drain workflows.
- Persist trace steps incrementally and finalize run/checkpoint/approval state together.
- Bound serialized UTF-8 context and individual tool results before returning data to a model.
- Add strict persisted tool-configuration validation and remove authentication coupling from tool transport.
- Add checkpoint health metrics, a generated migration, failure-mode unit tests, and end-to-end deferred-resume coverage.

## [0.2.0] - 2026-09-02

Relay 0.2.0 hardens agent tool execution, adds focused unit coverage, clarifies the runtime architecture, and publishes a comprehensive refactoring audit.

### SSRF and HTTP connector hardening

- Resolve A and AAAA records and reject private, loopback, link-local, reserved, and otherwise non-global destinations.
- Block decimal, octal, hexadecimal, IPv4-mapped IPv6, and cloud-metadata address representations.
- Disable automatic redirects and repeat URL/DNS validation before every redirect hop.
- Limit HTTP tool requests to a five-second total deadline, five redirects, and a 512 KiB streamed response.
- Add focused tests for IP encodings, IPv6, mixed DNS results, redirect pivots, timeouts, and oversized responses.

### Prompt-injection defense in depth

- Normalize common Unicode spacing tricks before inspecting user content.
- Inspect untrusted tool output before returning it to a model and withhold obvious indirect instructions.
- Withhold final model output that claims an allowlist bypass or resembles common secret leakage.
- Document that lexical matching is a weak tripwire rather than a semantic security guarantee.
- Add tests that both demonstrate current protection and record base64/indirect semantic gaps.

### Runtime safety and approvals

- Apply the same explicit tool-allowlist decision to deterministic and OpenAI provider paths.
- Expand PII redaction coverage to common complete and partially obfuscated phone formats.
- Extract a testable approval state machine.
- Atomically claim pending approvals before executing an approved tool, preventing duplicate concurrent decisions and rejected-action execution.
- Add focused tests for allowlists, redaction, approval transitions, and non-execution after rejection.

### Evaluation architecture

- Introduce a typed grader registry with synchronous and asynchronous grader support.
- Move contains and not-contains grading out of the route implementation.
- Return normalized grader scores and optional reasons without changing the evaluation-suite request shape.
- Demonstrate a future asynchronous model-rubric grader through tests without adding an LLM call or credentials.

### Architecture and developer experience

- Confirm Vinext and Vite as the authoritative build pipeline.
- Remove the unused `next.config.ts` and stale `.next` TypeScript include paths.
- Add a comprehensive architecture/refactoring audit with a scorecard, five prioritized bottlenecks, concrete code designs, and a testing roadmap.
- Add 39 unit tests across six focused suites while retaining the end-to-end smoke workflow.

### Licensing

- License Relay under Apache License 2.0, including the explicit contributor patent grant.
- Declare the SPDX-compatible license identifier in package metadata and document the license in the README.

### Verification

- 39 unit tests pass across six files.
- TypeScript validation and Oxlint pass.
- The production Vinext build succeeds.
- The end-to-end smoke suite passes with a 100 reference evaluation score.

### Known limitations

- Relay remains a single-agent operations MVP rather than a durable multi-agent relay engine.
- Model calls do not yet have a complete timeout/retry/backoff policy.
- Approved side effects still need a transactional outbox and downstream idempotency contract for crash-safe recovery.
- Conversation history, context compaction, and token/cost execution budgets are not yet implemented.
- Pattern-based prompt-injection detection cannot guarantee semantic attack detection.

## [0.1.0] - 2026-09-02

Relay's first public release provides a complete, production-shaped agent operations loop for a solo founder.

### Agent development

- Create agents with names, descriptions, system prompts, lifecycle state, provider/model selection, temperature, and explicit tool allowlists.
- Use a deterministic mock provider for credential-free local development and repeatable evaluations.
- Opt into real OpenAI Responses API execution with multi-turn function calling.
- Limit each run to four model turns and disable provider-side response storage.

### Tools and execution

- Execute seeded account lookup, policy search, and refund tools.
- Register custom public HTTPS tools using GET or POST.
- Reject loopback and common private-network HTTP targets.
- Persist run outcomes and ordered model, tool, guardrail, and approval traces.
- Track latency, token totals, estimated cost, and errors.

### Safety and governance

- Enforce per-agent tool allowlists.
- Block common prompt-injection attempts before model execution.
- Redact email addresses and phone numbers from protected output.
- Pause mutating tools for explicit human approval and resume or reject the exact captured arguments.
- Attribute administrative and operational actions in an audit log.
- Apply owner, builder, operator, and viewer workspace roles.

### Evaluations

- Create persistent evaluation suites with up to 100 cases.
- Run deterministic contains and not-contains graders.
- Persist evaluation results and expose a release-readiness score.
- Include a seeded three-case suite covering refund behavior, unknown orders, and prompt injection.

### Platform and deployment

- Store workspace, agent, tool, run, trace, approval, evaluation, and audit data in Cloudflare D1.
- Include a Drizzle schema, generated migrations, and idempotent bootstrap data.
- Build with React 19, TypeScript, Vinext, Tailwind CSS, Cloudflare Workers, and OpenAI Sites.
- Provide a private hosted demo using Sites-provided ChatGPT identity.
- Add full local setup, verification, production deployment, acceptance, rollback, and troubleshooting documentation.

### Verification

- Lint passes with Oxlint.
- TypeScript validation passes with no emitted output.
- The production Vinext build completes successfully.
- The end-to-end smoke suite covers initialization, tool calls, traces, prompt-injection blocking, approvals, and evaluations with a 100% reference score.

### Known boundaries

- The UI exposes one workspace, although operational tables carry workspace identifiers.
- HTTP tools do not yet store credentials or implement OAuth.
- Remote MCP transport is represented but not enabled.
- Evaluation graders are deterministic rather than model-scored.
- Non-Sites deployments must replace the ChatGPT identity adapter before public exposure.
- Additional production hardening is recommended for regulated or sensitive workloads.
