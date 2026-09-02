# Changelog

All notable changes to Relay are documented here.

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
