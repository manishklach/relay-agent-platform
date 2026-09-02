# Deployment guide

This guide takes Relay from a clean clone to a verified private production deployment. OpenAI Sites is the supported target because Relay relies on its D1 binding and ChatGPT identity headers.

## 1. Preflight

Install Node.js 22.13 or newer, clone the repository, and install exact dependencies:

```bash
git clone https://github.com/manishklach/relay-agent-platform.git
cd relay-agent-platform
npm ci
```

Confirm the application works locally:

```bash
npm run dev
```

In a second terminal:

```bash
npm run lint
npx tsc --noEmit
npm run test:smoke
npm run build
```

Do not deploy if any command fails.

## 2. Create your Sites project

The checked-in `.openai/hosting.json` points at the original demo. A fork must use its own Sites project ID.

1. Open the clone as a project in Codex.
2. Remove the existing `project_id` value or ask Codex to replace it while creating your site.
3. Create one private Sites project.
4. Bind Cloudflare D1 using the exact binding name `DB`.
5. Keep R2 disabled unless you add a feature that needs object storage.

Your resulting file should have this shape:

```json
{
  "project_id": "YOUR_SITES_PROJECT_ID",
  "d1": "DB",
  "r2": null
}
```

The project ID is an identifier rather than an API secret, but it must correspond to your own Sites project.

## 3. Configure model access

Model credentials are optional. Without them, the deterministic mock provider supports the full product tour and test suite.

For real OpenAI execution, add these server-side environment values to the deployment:

```dotenv
OPENAI_API_KEY=your_api_key
OPENAI_BASE_URL=https://api.openai.com/v1
```

Never prefix the key with `NEXT_PUBLIC_`; doing so would make it eligible for browser delivery. Never commit a populated `.env.local` file.

## 4. Build and deploy

Ask Codex to perform the standard Sites release flow:

1. Build the current source.
2. Commit and push the exact source state.
3. Package the successful build output.
4. Save a Sites version using the pushed commit SHA.
5. Deploy that saved version privately.
6. Wait until deployment status is `succeeded`.

Every Sites deployment URL is a production URL. Keep the first deployment private until the acceptance checks below pass.

## 5. Production acceptance checks

Open the production URL and verify:

- the dashboard loads and shows the seeded customer-care agent;
- a read-only order/refund question completes and shows model/tool steps;
- a refund action pauses in `waiting_approval`;
- approving or rejecting the action updates the run and approval trace;
- the release-readiness evaluation completes with three cases;
- creating an agent or tool is restricted according to the active member role;
- no API key or secret appears in browser network responses or page source.

## 6. Updating an existing deployment

For each release:

1. Pull the current default branch and install with `npm ci`.
2. Apply and review the change.
3. Run lint, type checking, smoke tests, and the production build.
4. Commit and push the exact verified source.
5. Save a new Sites version from that commit.
6. Deploy the saved version and wait for success.
7. Repeat the production acceptance checks.

Do not save a version from one commit and upload build output produced from another.

## 7. Rollback

Sites versions are immutable. If a new deployment fails its acceptance checks, redeploy the last known-good saved version, then investigate on a new branch. Avoid rewriting Git history or modifying the database destructively during incident response.

Database schema initialization is idempotent, but future destructive migrations should use explicit backups and a rehearsed rollback plan.

## 8. Deploying outside Sites

Relay compiles to a Cloudflare Worker-compatible application, but a direct Cloudflare deployment is not turnkey because production authentication currently trusts Sites-provided ChatGPT identity headers.

Before deploying elsewhere:

- replace `app/chatgpt-auth.ts` with your identity provider;
- configure a real D1 database as binding `DB`;
- enforce trusted proxy/header boundaries;
- add rate limiting and managed secret storage;
- run the complete acceptance checklist in the target environment.

Do not expose a direct Worker deployment publicly while it still expects Sites authentication semantics.

## Troubleshooting

### `D1 binding DB is unavailable`

Confirm `.openai/hosting.json` sets `d1` to `DB` and that the Sites project has a D1 binding with the same name. Restart the local server after changing hosting configuration.

### Real model runs use mock output

Confirm `OPENAI_API_KEY` exists in the server runtime, restart or redeploy, and ensure the selected agent provider is `openai` rather than `mock`.

### An HTTP tool is rejected

Relay only permits public HTTPS URLs. Localhost, loopback, and common private-network targets are deliberately blocked. Put internal services behind an authenticated, purpose-built gateway before connecting them.

### A user cannot modify agents or tools

New hosted members default to viewer. An owner must promote the member to a role with the required privilege; builders manage configuration and operators handle operational approvals.

### The smoke test cannot connect

Run `npm run dev` in a separate terminal and wait for `http://localhost:3000` before starting `npm run test:smoke`.
