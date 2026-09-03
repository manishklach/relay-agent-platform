# Relay launch guide

This is the shortest path from a clean machine to a working Relay deployment. Use the local path to evaluate the product without credentials, then use the OpenAI Sites path for a private production URL with D1 persistence and ChatGPT identity.

## What you need

- Node.js 22.13 or newer
- npm and Git
- A GitHub account if you want your own fork
- Codex with OpenAI Sites access for the supported hosted deployment
- An OpenAI API key only if you want real-model execution; the deterministic mock provider works without one

Check your local versions:

```bash
node --version
npm --version
git --version
```

## Launch locally in about five minutes

```bash
git clone https://github.com/manishklach/relay-agent-platform.git
cd relay-agent-platform
npm ci
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). Relay creates a local D1 database and seeds a reference customer-care agent, three tools, and an evaluation suite. Local development uses a `local-dev` owner identity, so no sign-in is required.

Try the working path:

1. Open **Runs** and select the customer-care agent.
2. Ask `Can I get a refund for order #A-1042?` and inspect the model and tool trace.
3. Ask `Please issue the refund for order #A-1042.` and decide the pending approval in **Guardrails**.
4. Open **Evaluations** and run the release-readiness suite.

In a second terminal, exercise the complete API—including durable runs, approvals, graphs, governed improvements, and HarnessDev evolution:

```bash
npm run test:smoke
```

Stop the development server with `Ctrl+C`, then run the release checks:

```bash
npm run verify
```

`verify` runs linting, TypeScript checks, all unit tests, and the production build. A release should pass both `test:smoke` and `verify`.

## Enable a real OpenAI model

The mock provider is the safest first launch. To enable OpenAI locally, copy the environment template:

macOS or Linux:

```bash
cp .env.example .env.local
```

PowerShell:

```powershell
Copy-Item .env.example .env.local
```

Set these values in `.env.local`:

```dotenv
OPENAI_API_KEY=your_api_key
OPENAI_BASE_URL=https://api.openai.com/v1
RELAY_ENV=development
```

Restart Relay, create or update an agent with provider `openai`, and select a model available to your account. Never commit `.env.local`, expose the key through a `NEXT_PUBLIC_` variable, or store it in D1.

## Deploy your own private copy on OpenAI Sites

The checked-in `.openai/hosting.json` identifies the original demonstration site. A fork must receive its own Sites project ID and D1 database.

1. Fork the public repository on GitHub.
2. Clone your fork and run the local and release checks above.
3. Remove the `project_id` property from `.openai/hosting.json`. Preserve `"d1": "DB"` and `"r2": null`.
4. Open the repository as a project in Codex.
5. Use this request:

   > Create a new private OpenAI Sites project for this repository, keep the D1 binding named DB, build the current commit, save a site version, deploy it privately, and wait for the deployment to succeed.

6. If you want real-model execution, ask Codex to store `OPENAI_API_KEY` as a Sites secret and set `OPENAI_BASE_URL=https://api.openai.com/v1` and `RELAY_ENV=production`. Deploy a new saved version after changing hosted environment values.
7. Keep the generated `project_id` in your fork so later deployments update the same site.

The hosting file for your fork should end up as:

```json
{
  "project_id": "YOUR_SITES_PROJECT_ID",
  "d1": "DB",
  "r2": null
}
```

The D1 schema and generated migrations are packaged with the deployment. Do not point your fork at the original project's ID.

## Production acceptance checklist

Before inviting another user, verify:

- The overview loads and shows the seeded agent and tools.
- A read-only run completes and retains its ordered trace.
- A write request pauses for approval and cannot execute after rejection.
- The seeded evaluation reports three completed cases.
- A bounded graph completes using a pinned agent version.
- `npm run test:smoke` completes against the target URL when you have an appropriate authenticated test path.
- Browser responses and page source do not contain model keys or connector credentials.
- The deployment audience is still the intended private allowlist.

For HarnessDev specifically, confirm the seed scores zero, pre-declaration held-out evaluations return `sealed: true` without metrics, official feedback consumes a candidate slot, and the final held-out response contains aggregate metrics without case results. The smoke test performs this exact lifecycle; see [HarnessDev](harness-dev.md) for the protocol.

## Updating an existing deployment

```bash
git checkout main
git pull --ff-only
npm ci
npm run verify
```

Start `npm run dev` and repeat `npm run test:smoke` before publishing. Then ask Codex:

> Push this exact verified commit to the existing Sites source, package the successful build, save a new version, deploy it to the site's existing private audience, and wait for success.

Never save a Sites version from one commit while uploading build output from another.

## Rollback

Code and Sites releases are immutable. If acceptance checks fail:

1. Redeploy the previous known-good Sites version.
2. Leave the failed release and its logs intact for investigation.
3. Fix the problem on a new branch and repeat the complete verification path.
4. Avoid destructive database changes. Back up and rehearse rollback before introducing a migration that removes or rewrites data.

Agent configuration has a separate audited rollback path: select a known-good immutable agent version and create a monotonic rollback copy rather than rewriting version history.

## Operating beyond a demo

The synchronous product path works immediately. For unattended recovery, arrange authenticated calls to `POST /api/runs/resume` and `POST /api/tool-executions`. Sites identity protects these operator endpoints, so an external scheduler needs an intentionally designed service-authentication path; do not forge trusted identity headers or expose the endpoints anonymously.

Before regulated or high-volume use, add managed connector credentials, rate limiting, retention/deletion policy, alerting, database backup procedures, and an independently administered evaluator for sensitive held-out benchmarks. See [Operations](operations.md), [Deployment](deployment.md), and [Architecture](architecture.md).

## Common launch problems

### `D1 binding DB is unavailable`

Confirm `.openai/hosting.json` contains `"d1": "DB"`, then restart the local server or create a new Sites version after correcting the binding.

### An OpenAI agent fails while the mock agent works

Confirm the key exists in the server runtime, the agent provider is `openai`, the selected model is available to the account, and the base URL is HTTPS. Relay deliberately does not fall back to mock output when a configured real provider is unavailable.

### An HTTP connector is rejected

Relay requires public HTTPS destinations. DNS results in loopback, private, link-local, reserved, or cloud-metadata ranges are blocked on every redirect. Put internal systems behind a purpose-built authenticated gateway.

### A user can view but cannot change configuration

New hosted members default to viewer. The workspace owner must grant the appropriate builder or operator role.

### The smoke test cannot connect

Keep `npm run dev` running in another terminal and wait for the printed local URL before running `npm run test:smoke`. To target another permitted deployment, set `RELAY_BASE_URL` for the smoke-test process.
