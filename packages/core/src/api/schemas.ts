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

// ---- Runs ------------------------------------------------------------------
export const runStatusSchema = z.enum([
  'queued',
  'provisioning',
  'running',
  'awaiting_input',
  'finalizing',
  'succeeded',
  'failed',
  'cancelled',
]);
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

// ---- Problem details (RFC 9457) -------------------------------------------
export const problemDetailsSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number().int(),
  detail: z.string().optional(),
  errors: z
    .array(z.object({ path: z.string(), message: z.string() }))
    .optional(),
});
export type ProblemDetails = z.infer<typeof problemDetailsSchema>;
