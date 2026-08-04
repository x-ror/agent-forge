import { z } from 'zod';
import { jsonSchema } from '../json';

/**
 * The normalized agent event protocol (design doc §6.2).
 * This 9-event union is the ONLY way agent activity reaches core.
 * Zod-validated at the adapter boundary; unmappable native events are
 * preserved under `payload.raw` by the orchestrator, never here.
 */
export const agentEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('agent.message'), text: z.string() }),
  z.object({ type: z.literal('agent.thinking'), text: z.string() }),
  z.object({ type: z.literal('tool.start'), tool: z.string(), detail: jsonSchema }),
  z.object({ type: z.literal('tool.end'), tool: z.string(), ok: z.boolean(), output: z.string() }),
  z.object({ type: z.literal('file.change'), path: z.string(), diff: z.string() }),
  z.object({
    type: z.literal('permission.request'),
    id: z.string(),
    action: z.string(),
    detail: jsonSchema,
  }),
  z.object({
    type: z.literal('usage'),
    tokensIn: z.number().int().nonnegative(),
    tokensOut: z.number().int().nonnegative(),
    costUsd: z.number().nonnegative().optional(),
  }),
  z.object({
    type: z.literal('result'),
    outcome: z.enum(['success', 'failure']),
    summary: z.string(),
    structured: jsonSchema.optional(),
  }),
  z.object({ type: z.literal('fatal'), error: z.string() }),
]);

export type AgentEvent = z.infer<typeof agentEventSchema>;
export type AgentEventType = AgentEvent['type'];

export const AGENT_EVENT_TYPES = [
  'agent.message',
  'agent.thinking',
  'tool.start',
  'tool.end',
  'file.change',
  'permission.request',
  'usage',
  'result',
  'fatal',
] as const satisfies readonly AgentEventType[];
