import { z } from 'zod';

/** Shared API DTO schemas — imported by both server (validation) and frontend (forms). */

// ---- Auth ------------------------------------------------------------------
export const registerRequestSchema = z.object({
  email: z.email(),
  password: z.string().min(8).max(128),
});
export type RegisterRequest = z.infer<typeof registerRequestSchema>;

export const loginRequestSchema = z.object({
  email: z.email(),
  password: z.string().min(1).max(128),
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;

export const userDtoSchema = z.object({
  id: z.uuid(),
  email: z.string(),
  createdAt: z.iso.datetime(),
});
export type UserDto = z.infer<typeof userDtoSchema>;

// ---- PATs ------------------------------------------------------------------
export const createPatRequestSchema = z.object({
  name: z.string().min(1).max(100),
});
export type CreatePatRequest = z.infer<typeof createPatRequestSchema>;

export const patDtoSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  createdAt: z.iso.datetime(),
  lastUsedAt: z.iso.datetime().nullable(),
  revokedAt: z.iso.datetime().nullable(),
});
export type PatDto = z.infer<typeof patDtoSchema>;

// ---- Projects --------------------------------------------------------------
export const projectSettingsSchema = z
  .object({
    allowedCommands: z.array(z.string()).optional(),
    networkPolicy: z.enum(['full', 'llm-only', 'none']).optional(),
    sandboxImage: z.string().optional(),
    defaultAgentId: z.uuid().optional(),
  })
  .loose();

export const createProjectRequestSchema = z.object({
  name: z.string().min(1).max(200),
  repoUrl: z.string().min(1).max(1000),
  defaultBranch: z.string().min(1).max(200).default('main'),
  settings: projectSettingsSchema.default({}),
});
export type CreateProjectRequest = z.infer<typeof createProjectRequestSchema>;

export const updateProjectRequestSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  repoUrl: z.string().min(1).max(1000).optional(),
  defaultBranch: z.string().min(1).max(200).optional(),
  settings: projectSettingsSchema.optional(),
});
export type UpdateProjectRequest = z.infer<typeof updateProjectRequestSchema>;

export const projectDtoSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  repoUrl: z.string(),
  defaultBranch: z.string(),
  settings: projectSettingsSchema,
  createdAt: z.iso.datetime(),
});
export type ProjectDto = z.infer<typeof projectDtoSchema>;

// ---- Secrets (write-only) --------------------------------------------------
export const putSecretRequestSchema = z.object({
  value: z.string().min(1).max(10_000),
});
export type PutSecretRequest = z.infer<typeof putSecretRequestSchema>;

export const secretKeyPattern = /^[A-Z][A-Z0-9_]{0,127}$/;

// ---- Agents ----------------------------------------------------------------
export const adapterIdSchema = z.enum(['claude-code', 'codex-cli', 'openhands', 'aider', 'api-loop']);

export const createAgentRequestSchema = z.object({
  name: z.string().min(1).max(100),
  adapter: adapterIdSchema,
  config: z.record(z.string(), z.unknown()).default({}),
});
export type CreateAgentRequest = z.infer<typeof createAgentRequestSchema>;

export const updateAgentRequestSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  adapter: adapterIdSchema.optional(),
  config: z.record(z.string(), z.unknown()).optional(),
});
export type UpdateAgentRequest = z.infer<typeof updateAgentRequestSchema>;

export const agentDtoSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  adapter: adapterIdSchema,
  config: z.record(z.string(), z.unknown()),
  createdAt: z.iso.datetime(),
});
export type AgentDto = z.infer<typeof agentDtoSchema>;

// ---- Tasking ---------------------------------------------------------------
export const taskStatusSchema = z.enum(['backlog', 'in_flow', 'done', 'failed', 'archived']);
export type TaskStatusDto = z.infer<typeof taskStatusSchema>;

export const taskSourceKindSchema = z.enum(['github_issues', 'jira', 'file', 'manual']);

export const createTaskSourceRequestSchema = z.object({
  projectId: z.uuid(),
  kind: taskSourceKindSchema,
  config: z.record(z.string(), z.unknown()).default({}),
  syncCron: z.string().max(100).nullable().optional(),
});
export type CreateTaskSourceRequest = z.infer<typeof createTaskSourceRequestSchema>;

export const taskSourceDtoSchema = z.object({
  id: z.uuid(),
  projectId: z.uuid(),
  kind: taskSourceKindSchema,
  config: z.record(z.string(), z.unknown()),
  syncCron: z.string().nullable(),
  lastSyncedAt: z.iso.datetime().nullable(),
});
export type TaskSourceDto = z.infer<typeof taskSourceDtoSchema>;

export const createTaskRequestSchema = z.object({
  projectId: z.uuid(),
  title: z.string().min(1).max(500),
  body: z.string().max(100_000).default(''),
});
export type CreateTaskRequest = z.infer<typeof createTaskRequestSchema>;

export const updateTaskRequestSchema = z.object({
  status: taskStatusSchema.optional(),
  title: z.string().min(1).max(500).optional(),
  body: z.string().max(100_000).optional(),
});
export type UpdateTaskRequest = z.infer<typeof updateTaskRequestSchema>;

export const taskDtoSchema = z.object({
  id: z.uuid(),
  projectId: z.uuid(),
  sourceId: z.uuid().nullable(),
  externalKey: z.string().nullable(),
  title: z.string(),
  body: z.string(),
  status: taskStatusSchema,
  meta: z.record(z.string(), z.unknown()),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type TaskDto = z.infer<typeof taskDtoSchema>;

// ---- Runs ------------------------------------------------------------------
export const runStatusSchema = z.enum(['queued', 'provisioning', 'running', 'awaiting_input', 'finalizing', 'succeeded', 'failed', 'cancelled']);
export type RunStatusDto = z.infer<typeof runStatusSchema>;

export const createRunRequestSchema = z.object({
  projectId: z.uuid(),
  agentId: z.uuid(),
  prompt: z.string().min(1).max(100_000),
  baseRef: z.string().min(1).max(200).optional(),
});
export type CreateRunRequest = z.infer<typeof createRunRequestSchema>;

export const runDtoSchema = z.object({
  id: z.uuid(),
  projectId: z.uuid(),
  agentId: z.uuid(),
  status: runStatusSchema,
  taskPrompt: z.string(),
  baseRef: z.string(),
  branch: z.string().nullable(),
  usage: z.record(z.string(), z.unknown()),
  error: z.string().nullable(),
  createdAt: z.iso.datetime(),
  startedAt: z.iso.datetime().nullable(),
  finishedAt: z.iso.datetime().nullable(),
});
export type RunDto = z.infer<typeof runDtoSchema>;

export const runEventDtoSchema = z.object({
  runId: z.uuid(),
  seq: z.number().int(),
  ts: z.iso.datetime(),
  type: z.string(),
  payload: z.unknown(),
});
export type RunEventDto = z.infer<typeof runEventDtoSchema>;

export const runInputRequestSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('message'), text: z.string().min(1).max(20_000) }),
  z.object({
    kind: z.literal('approval'),
    permissionId: z.string().min(1),
    decision: z.enum(['allow', 'deny']),
    note: z.string().max(2000).optional(),
  }),
  z.object({ kind: z.literal('cancel'), reason: z.string().max(2000).optional() }),
]);
export type RunInputRequest = z.infer<typeof runInputRequestSchema>;

// ---- Workflows & flow runs -------------------------------------------------
export const createWorkflowRequestSchema = z.object({
  projectId: z.uuid(),
  name: z.string().min(1).max(200),
  definition: z.unknown(), // validated against workflowDefinitionSchema server-side
});
export type CreateWorkflowRequest = z.infer<typeof createWorkflowRequestSchema>;

export const newWorkflowVersionRequestSchema = z.object({
  definition: z.unknown(),
});
export type NewWorkflowVersionRequest = z.infer<typeof newWorkflowVersionRequestSchema>;

export const workflowDtoSchema = z.object({
  id: z.uuid(),
  projectId: z.uuid(),
  name: z.string(),
  version: z.number().int(),
  definition: z.unknown(),
  enabled: z.boolean(),
  createdAt: z.iso.datetime(),
});
export type WorkflowDto = z.infer<typeof workflowDtoSchema>;

export const startFlowRequestSchema = z.object({
  workflowId: z.uuid(),
  taskId: z.uuid(),
});
export type StartFlowRequest = z.infer<typeof startFlowRequestSchema>;

export const flowStatusSchema = z.enum(['running', 'awaiting_input', 'succeeded', 'failed', 'cancelled']);

export const flowStepDtoSchema = z.object({
  id: z.uuid(),
  nodeId: z.string(),
  kind: z.enum(['trigger', 'action', 'agent', 'decision', 'gate']),
  status: z.string(),
  runId: z.uuid().nullable(),
  decision: z.object({ route: z.string(), reasoning: z.string() }).nullable(),
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
});
export type FlowStepDto = z.infer<typeof flowStepDtoSchema>;

export const flowRunDtoSchema = z.object({
  id: z.uuid(),
  workflowId: z.uuid(),
  taskId: z.uuid(),
  status: flowStatusSchema,
  context: z.record(z.string(), z.unknown()),
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
  steps: z.array(flowStepDtoSchema).optional(),
});
export type FlowRunDto = z.infer<typeof flowRunDtoSchema>;

export const gateDecisionRequestSchema = z.object({
  approve: z.boolean(),
  note: z.string().max(2000).optional(),
});
export type GateDecisionRequest = z.infer<typeof gateDecisionRequestSchema>;

// ---- Problem details (RFC 9457) -------------------------------------------
export const problemDetailsSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number().int(),
  detail: z.string().optional(),
  errors: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
});
export type ProblemDetails = z.infer<typeof problemDetailsSchema>;
