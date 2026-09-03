# HarnessDev: self-evolving execution harnesses

Relay implements the two-stage protocol described in [HarnessDev (arXiv:2609.01437)](https://arxiv.org/abs/2609.01437). The object being optimized is not an answer or a mutable prompt. It is an immutable, executable harness: a versioned policy for how agents, tools, context, state, lifecycle limits, and verification work together.

This is governed optimization, not autonomous production mutation. A harness can generate candidates and collect feedback, but it cannot alter a frozen version, inspect held-out cases, bypass its tool allowlist, or promote itself without completing the declared evaluation protocol.

## Artifact contract

Every harness artifact has six executable control surfaces:

| Module       | Relay representation                                 | Enforced behavior                                    |
| ------------ | ---------------------------------------------------- | ---------------------------------------------------- |
| Execution    | Bounded, versioned agent graph                       | Deterministic transitions and pinned agent versions  |
| Tools        | Deny-by-default allowlist and call budget            | Runtime intersection with each agent's own allowlist |
| Context      | Full, sliding-window, or compression-marker policy   | UTF-8 byte bound before execution                    |
| State        | Per-step checkpoints and retained trajectory         | Uses the durable graph/runtime trace path            |
| Lifecycle    | Step, retry, tool, and deadline limits               | Fails closed when a budget is exhausted              |
| Verification | Suite IDs, artifact type, and trajectory requirement | Native grader score and executor-token accounting    |

Artifacts declare `providerNeutral: true`. During evaluation, Relay replaces node-level provider/model selection with either the creator executor (`self`) or a fixed comparison executor (`unified`). This makes executor transfer measurable without rewriting the harness.

## Creation protocol

1. Create a project with one to three visible `development` cases, one or more `feedback` cases, and one or more `heldout` cases.
2. Relay emits version zero: a weak but runnable seed with a stable interface, full audit envelope, and no solving policy.
3. Submit a `creation` artifact descended from the seed. Relay validates the schema, version pins, tool boundary, and embedded case evidence, then freezes or rejects it.
4. Run development evaluations. A controller may also run a sealed Creation held-out evaluation; neither aggregate metrics nor case results are returned while the project is active.
5. Select one compliant frozen Creation version as `H0` and start evolution.

The seed intentionally receives a zero capability score. It exists to prove the interface and accounting path, not to provide a hidden reference solution.

## Evolution protocol

Evolution candidates must descend from `H0` or another evolution version. Each version is immutable and carries its creator-version lineage and constraint audit.

- `probe` evaluations are limited to the project's configured allowance, at most two per version and benchmark.
- The first official feedback evaluation reserves one candidate slot atomically. A project can reserve at most ten.
- A final candidate must complete every feedback benchmark using the same executor mode and exact executor configuration.
- Capability and executor-token cost remain separate metrics. Relay does not collapse them into a single score.
- Final declaration is an explicit operator action. Only then can aggregate held-out metrics be read.

A failed or abandoned official submission still consumes its candidate slot. This conservative rule prevents unlimited partial submissions from becoming a side channel around the official budget.

## Held-out isolation

The general project and version APIs never return held-out inputs, expected values, or per-case results. Before final declaration, a held-out run must be marked `sealed`; its response and evaluation listing omit metrics. After declaration, only the baseline and final versions are eligible, and the API returns aggregate metrics without per-case results.

This is an application-layer boundary suitable for one controlled deployment. Operators with direct D1 access remain trusted. Stronger benchmark confidentiality requires a separate evaluator service, separate credentials/database, and an API that accepts only frozen artifact digests.

## Constraint audit and limitations

Relay rejects malformed artifacts, unpinned or missing agent versions, agent tool configurations outside the harness boundary, and artifacts containing project case IDs or sufficiently long expected-answer strings. It also forces the runtime provider through the selected executor.

This lexical evidence scan is defense in depth, not proof that a candidate contains no instance-specific logic. Obfuscated answers, semantic equivalents, or information memorized by a creator model may evade it. High-stakes evaluation should combine static inspection, isolated execution, artifact signing, canary cases, and an independently administered held-out evaluator.

## API sequence

```text
POST /api/harnesses                    create project + weak seed
POST /api/harnesses/versions           freeze Creation candidate
POST /api/harnesses/evaluate           development/unified or sealed held-out run
POST /api/harnesses/evolve {start}     select H0 and open evolution
POST /api/harnesses/versions           freeze evolution candidate
POST /api/harnesses/evaluate           probe or official feedback legs
POST /api/harnesses/evolve {declare_final}
POST /api/harnesses/evaluate           aggregate final held-out evaluation
GET  /api/harnesses/evaluate           inspect redacted evaluation history
```

## What is operational today

The control-plane protocol, persistence, graph execution, deterministic graders, self/unified executor selection, token accounting, budget gates, lineage, audit logs, and sealed result behavior run end to end. The platform does not yet ask an LLM to author artifact JSON automatically; a builder, CI job, or external creator agent submits candidates through the same API. The grader registry is asynchronous and pluggable, but Relay deliberately does not ship an LLM judge.

The paper reports that evolution gains can be unstable and executor-dependent. Treat improvements as hypotheses: compare `H0` and the final version on held-out data, repeat across executors, retain trajectories, and roll back rather than assuming recursive improvement is monotonic.
