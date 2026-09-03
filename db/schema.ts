import {
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

export const workspaces = sqliteTable('workspaces', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  createdAt: integer('created_at').notNull(),
});

export const workspaceMembers = sqliteTable(
  'workspace_members',
  {
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    userId: text('user_id').notNull(),
    email: text('email').notNull(),
    role: text('role', {
      enum: ['owner', 'builder', 'operator', 'viewer'],
    }).notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.userId] }),
    index('idx_workspace_members_user').on(table.userId),
  ],
);

export const agents = sqliteTable(
  'agents',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    name: text('name').notNull(),
    description: text('description').notNull(),
    systemPrompt: text('system_prompt').notNull(),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    temperature: real('temperature').notNull().default(0.2),
    status: text('status', { enum: ['draft', 'live', 'paused'] })
      .notNull()
      .default('draft'),
    allowedTools: text('allowed_tools').notNull().default('[]'),
    guardrailConfig: text('guardrail_config').notNull().default('{}'),
    createdBy: text('created_by').notNull(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    index('idx_agents_workspace_status').on(table.workspaceId, table.status),
  ],
);

export const tools = sqliteTable(
  'tools',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    name: text('name').notNull(),
    displayName: text('display_name').notNull(),
    description: text('description').notNull(),
    kind: text('kind', { enum: ['builtin', 'http', 'mcp'] }).notNull(),
    configJson: text('config_json').notNull().default('{}'),
    approvalRequired: integer('approval_required', { mode: 'boolean' })
      .notNull()
      .default(false),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    index('idx_tools_workspace_enabled').on(table.workspaceId, table.enabled),
    uniqueIndex('idx_tools_workspace_name').on(table.workspaceId, table.name),
  ],
);

export const runs = sqliteTable(
  'runs',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id),
    status: text('status', {
      enum: ['running', 'succeeded', 'failed', 'waiting_approval'],
    }).notNull(),
    input: text('input').notNull(),
    output: text('output'),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    latencyMs: integer('latency_ms'),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    estimatedCostUsd: real('estimated_cost_usd').notNull().default(0),
    error: text('error'),
    createdBy: text('created_by').notNull(),
    createdAt: integer('created_at').notNull(),
    finishedAt: integer('finished_at'),
  },
  (table) => [
    index('idx_runs_workspace_created').on(table.workspaceId, table.createdAt),
    index('idx_runs_agent_created').on(table.agentId, table.createdAt),
  ],
);

export const runSteps = sqliteTable(
  'run_steps',
  {
    id: text('id').primaryKey(),
    runId: text('run_id')
      .notNull()
      .references(() => runs.id),
    sequence: integer('sequence').notNull(),
    kind: text('kind', {
      enum: ['model', 'tool', 'guardrail', 'approval'],
    }).notNull(),
    name: text('name').notNull(),
    status: text('status', {
      enum: ['succeeded', 'failed', 'blocked', 'pending'],
    }).notNull(),
    inputJson: text('input_json').notNull().default('{}'),
    outputJson: text('output_json').notNull().default('{}'),
    durationMs: integer('duration_ms').notNull().default(0),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    index('idx_run_steps_run_sequence').on(table.runId, table.sequence),
  ],
);

export const runCheckpoints = sqliteTable(
  'run_checkpoints',
  {
    runId: text('run_id')
      .primaryKey()
      .references(() => runs.id),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    status: text('status', {
      enum: ['ready', 'running', 'waiting_approval', 'completed', 'failed'],
    }).notNull(),
    stateJson: text('state_json').notNull(),
    version: integer('version').notNull().default(0),
    leaseOwner: text('lease_owner'),
    leaseExpiresAt: integer('lease_expires_at'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    index('idx_run_checkpoints_workspace_status').on(
      table.workspaceId,
      table.status,
      table.updatedAt,
    ),
    index('idx_run_checkpoints_lease').on(table.status, table.leaseExpiresAt),
  ],
);

export const approvals = sqliteTable(
  'approvals',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    runId: text('run_id')
      .notNull()
      .references(() => runs.id),
    toolName: text('tool_name').notNull(),
    argumentsJson: text('arguments_json').notNull(),
    status: text('status', {
      enum: ['pending', 'approved', 'rejected'],
    }).notNull(),
    requestedAt: integer('requested_at').notNull(),
    decidedAt: integer('decided_at'),
    decidedBy: text('decided_by'),
  },
  (table) => [
    index('idx_approvals_workspace_status').on(table.workspaceId, table.status),
  ],
);

export const toolExecutions = sqliteTable(
  'tool_executions',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    runId: text('run_id')
      .notNull()
      .references(() => runs.id),
    approvalId: text('approval_id')
      .notNull()
      .references(() => approvals.id),
    toolName: text('tool_name').notNull(),
    argumentsJson: text('arguments_json').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    retrySafe: integer('retry_safe', { mode: 'boolean' })
      .notNull()
      .default(false),
    status: text('status', {
      enum: [
        'queued',
        'running',
        'retry_scheduled',
        'succeeded',
        'dead_letter',
        'unknown',
      ],
    }).notNull(),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(3),
    leaseOwner: text('lease_owner'),
    leaseExpiresAt: integer('lease_expires_at'),
    nextAttemptAt: integer('next_attempt_at').notNull(),
    resultJson: text('result_json'),
    error: text('error'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    finishedAt: integer('finished_at'),
  },
  (table) => [
    uniqueIndex('idx_tool_executions_approval').on(table.approvalId),
    uniqueIndex('idx_tool_executions_idempotency').on(
      table.workspaceId,
      table.idempotencyKey,
    ),
    index('idx_tool_executions_claim').on(table.status, table.nextAttemptAt),
    index('idx_tool_executions_run').on(table.runId, table.createdAt),
  ],
);

export const evaluationSuites = sqliteTable(
  'evaluation_suites',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id),
    name: text('name').notNull(),
    description: text('description').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [index('idx_eval_suites_agent').on(table.agentId)],
);

export const evaluationCases = sqliteTable(
  'evaluation_cases',
  {
    id: text('id').primaryKey(),
    suiteId: text('suite_id')
      .notNull()
      .references(() => evaluationSuites.id),
    name: text('name').notNull(),
    input: text('input').notNull(),
    expectedJson: text('expected_json').notNull(),
    graderType: text('grader_type', {
      enum: ['contains', 'not_contains', 'json'],
    }).notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [index('idx_eval_cases_suite').on(table.suiteId)],
);

export const evaluationRuns = sqliteTable(
  'evaluation_runs',
  {
    id: text('id').primaryKey(),
    suiteId: text('suite_id')
      .notNull()
      .references(() => evaluationSuites.id),
    status: text('status', {
      enum: ['running', 'completed', 'failed'],
    }).notNull(),
    passed: integer('passed').notNull().default(0),
    total: integer('total').notNull().default(0),
    score: real('score').notNull().default(0),
    detailsJson: text('details_json').notNull().default('[]'),
    createdBy: text('created_by').notNull(),
    createdAt: integer('created_at').notNull(),
    finishedAt: integer('finished_at'),
  },
  (table) => [
    index('idx_eval_runs_suite_created').on(table.suiteId, table.createdAt),
  ],
);

export const agentVersions = sqliteTable(
  'agent_versions',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id),
    version: integer('version').notNull(),
    configJson: text('config_json').notNull(),
    status: text('status', {
      enum: ['candidate', 'active', 'archived'],
    }).notNull(),
    source: text('source', {
      enum: ['manual', 'improvement', 'rollback'],
    }).notNull(),
    parentVersionId: text('parent_version_id'),
    createdBy: text('created_by').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    uniqueIndex('idx_agent_versions_number').on(table.agentId, table.version),
    index('idx_agent_versions_status').on(table.agentId, table.status),
  ],
);

export const runAgentVersions = sqliteTable('run_agent_versions', {
  runId: text('run_id')
    .primaryKey()
    .references(() => runs.id),
  agentVersionId: text('agent_version_id')
    .notNull()
    .references(() => agentVersions.id),
});

export const graphs = sqliteTable(
  'graphs',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    name: text('name').notNull(),
    description: text('description').notNull(),
    status: text('status', { enum: ['draft', 'live', 'paused'] }).notNull(),
    createdBy: text('created_by').notNull(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    index('idx_graphs_workspace_status').on(table.workspaceId, table.status),
  ],
);

export const graphVersions = sqliteTable(
  'graph_versions',
  {
    id: text('id').primaryKey(),
    graphId: text('graph_id')
      .notNull()
      .references(() => graphs.id),
    version: integer('version').notNull(),
    definitionJson: text('definition_json').notNull(),
    status: text('status', {
      enum: ['candidate', 'active', 'archived'],
    }).notNull(),
    createdBy: text('created_by').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    uniqueIndex('idx_graph_versions_number').on(table.graphId, table.version),
    index('idx_graph_versions_status').on(table.graphId, table.status),
  ],
);

export const graphRuns = sqliteTable(
  'graph_runs',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    graphId: text('graph_id')
      .notNull()
      .references(() => graphs.id),
    graphVersionId: text('graph_version_id')
      .notNull()
      .references(() => graphVersions.id),
    status: text('status', {
      enum: ['ready', 'running', 'waiting_approval', 'completed', 'failed'],
    }).notNull(),
    checkpointJson: text('checkpoint_json').notNull(),
    version: integer('version').notNull().default(0),
    leaseOwner: text('lease_owner'),
    leaseExpiresAt: integer('lease_expires_at'),
    createdBy: text('created_by').notNull(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    finishedAt: integer('finished_at'),
  },
  (table) => [
    index('idx_graph_runs_workspace_status').on(
      table.workspaceId,
      table.status,
      table.updatedAt,
    ),
    index('idx_graph_runs_lease').on(table.status, table.leaseExpiresAt),
  ],
);

export const improvementProposals = sqliteTable(
  'improvement_proposals',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id),
    baseVersionId: text('base_version_id')
      .notNull()
      .references(() => agentVersions.id),
    candidateVersionId: text('candidate_version_id')
      .notNull()
      .references(() => agentVersions.id),
    evaluationSuiteId: text('evaluation_suite_id')
      .notNull()
      .references(() => evaluationSuites.id),
    evaluationRunId: text('evaluation_run_id').references(
      () => evaluationRuns.id,
    ),
    minimumScore: real('minimum_score').notNull(),
    score: real('score'),
    status: text('status', {
      enum: [
        'pending_evaluation',
        'awaiting_approval',
        'approved',
        'rejected',
        'activated',
      ],
    }).notNull(),
    rationale: text('rationale').notNull(),
    proposedBy: text('proposed_by').notNull(),
    reviewedBy: text('reviewed_by'),
    createdAt: integer('created_at').notNull(),
    reviewedAt: integer('reviewed_at'),
    activatedAt: integer('activated_at'),
  },
  (table) => [
    index('idx_improvements_workspace_status').on(
      table.workspaceId,
      table.status,
      table.createdAt,
    ),
    index('idx_improvements_agent').on(table.agentId, table.createdAt),
  ],
);

export const auditLogs = sqliteTable(
  'audit_logs',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    actorId: text('actor_id').notNull(),
    action: text('action').notNull(),
    targetType: text('target_type').notNull(),
    targetId: text('target_id').notNull(),
    metadataJson: text('metadata_json').notNull().default('{}'),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    index('idx_audit_workspace_created').on(table.workspaceId, table.createdAt),
  ],
);
