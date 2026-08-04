import { Controller, Get } from '@nestjs/common';
import { z, type ZodType } from 'zod';
import {
  agentDtoSchema,
  createAgentRequestSchema,
  createPatRequestSchema,
  createProjectRequestSchema,
  loginRequestSchema,
  patDtoSchema,
  problemDetailsSchema,
  projectDtoSchema,
  putSecretRequestSchema,
  registerRequestSchema,
  updateProjectRequestSchema,
  userDtoSchema,
  workflowDefinitionSchema,
} from '@agentforge/core';
import { Public } from '../http/auth.decorators';

function schema(zodSchema: ZodType): unknown {
  return z.toJSONSchema(zodSchema, { io: 'output', target: 'draft-2020-12' });
}

function jsonBody(zodSchema: ZodType): unknown {
  return { required: true, content: { 'application/json': { schema: schema(zodSchema) } } };
}

function jsonResponse(description: string, zodSchema?: ZodType): unknown {
  return zodSchema ? { description, content: { 'application/json': { schema: schema(zodSchema) } } } : { description };
}

/** OpenAPI 3.1 generated from the shared Zod schemas (§9). Grows per phase. */
function buildDocument(): Record<string, unknown> {
  return {
    openapi: '3.1.0',
    info: { title: 'AgentForge API', version: '1' },
    servers: [{ url: '/api/v1' }],
    components: {
      schemas: {
        ProblemDetails: schema(problemDetailsSchema),
        User: schema(userDtoSchema),
        Project: schema(projectDtoSchema),
        Pat: schema(patDtoSchema),
        Agent: schema(agentDtoSchema),
        WorkflowDefinition: schema(workflowDefinitionSchema),
      },
      securitySchemes: {
        sessionCookie: { type: 'apiKey', in: 'cookie', name: 'agentforge_session' },
        pat: { type: 'http', scheme: 'bearer' },
      },
    },
    security: [{ sessionCookie: [] }, { pat: [] }],
    paths: {
      '/auth/register': {
        post: {
          requestBody: jsonBody(registerRequestSchema),
          responses: { '201': jsonResponse('registered', userDtoSchema) },
          security: [],
        },
      },
      '/auth/login': {
        post: {
          requestBody: jsonBody(loginRequestSchema),
          responses: { '200': jsonResponse('logged in', userDtoSchema) },
          security: [],
        },
      },
      '/auth/logout': { post: { responses: { '204': jsonResponse('logged out') } } },
      '/auth/me': { get: { responses: { '200': jsonResponse('current user') } } },
      '/pats': {
        get: { responses: { '200': jsonResponse('list PATs') } },
        post: {
          requestBody: jsonBody(createPatRequestSchema),
          responses: { '201': jsonResponse('created; token returned once') },
        },
      },
      '/pats/{id}': { delete: { responses: { '204': jsonResponse('revoked') } } },
      '/projects': {
        get: { responses: { '200': jsonResponse('list projects') } },
        post: {
          requestBody: jsonBody(createProjectRequestSchema),
          responses: { '201': jsonResponse('created', projectDtoSchema) },
        },
      },
      '/projects/{id}': {
        get: { responses: { '200': jsonResponse('project', projectDtoSchema) } },
        patch: {
          requestBody: jsonBody(updateProjectRequestSchema),
          responses: { '200': jsonResponse('updated', projectDtoSchema) },
        },
        delete: { responses: { '204': jsonResponse('deleted') } },
      },
      '/projects/{id}/secrets': {
        get: { responses: { '200': jsonResponse('secret keys (values are write-only)') } },
      },
      '/projects/{id}/secrets/{key}': {
        put: {
          requestBody: jsonBody(putSecretRequestSchema),
          responses: { '204': jsonResponse('stored') },
        },
        delete: { responses: { '204': jsonResponse('deleted') } },
      },
      '/agents': {
        get: { responses: { '200': jsonResponse('list agents') } },
        post: {
          requestBody: jsonBody(createAgentRequestSchema),
          responses: { '201': jsonResponse('created', agentDtoSchema) },
        },
      },
      '/health': { get: { responses: { '200': jsonResponse('health') }, security: [] } },
    },
  };
}

@Controller('openapi.json')
export class OpenApiController {
  private readonly document = buildDocument();

  @Public()
  @Get()
  document_(): Record<string, unknown> {
    return this.document;
  }
}
