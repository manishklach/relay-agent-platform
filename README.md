# Relay

Relay is an end-to-end agent operations platform for a solo founder: configure an agent, connect tools, execute it, inspect traces, gate risky actions, and run regression evaluations from one control plane.

## Included

- Agent configuration with model-provider abstraction and explicit tool allowlists
- Deterministic local provider plus optional OpenAI-compatible execution
- Built-in and public-HTTPS tools
- Persistent runs, ordered model/tool/guardrail traces, latency, token, and cost fields
- Prompt-injection blocking, PII redaction, and approval gates for state-changing tools
- Operator approval queue with resume/reject behavior
- Persisted evaluation suites and release scores
- Workspace roles and attributed audit records
- D1 schema, generated migrations, idempotent bootstrap data, and Sites deployment configuration

## Run locally

Requirements: Node.js 22.13 or newer.

```bash
npm install
npm run dev
```

Open `http://localhost:3000`. No model credentials are required for the reference customer-care agent.

To use an OpenAI-compatible provider, copy `.env.example` to `.env.local`, set `OPENAI_API_KEY`, configure an agent with provider `openai`, and choose the model name supported by the endpoint.

## Verify

With the development server running:

```bash
npm run lint
npx tsc --noEmit
npm run test:smoke
npm run build
```

The smoke test verifies persistent seeding, tool execution, stored traces, prompt-injection blocking, approval gating and decisions, and the complete evaluation loop.

## API surface

- `GET/POST /api/agents`
- `GET/POST /api/tools`
- `GET/POST /api/runs`
- `GET/POST /api/approvals`
- `POST /api/evaluations/run`
- `GET /api/overview`

See [docs/architecture.md](docs/architecture.md) for the runtime, security boundaries, data model, and known first-release limits.
