import type { Json } from '../json';
import type { AgentAdapter, AgentHandle, AdapterCapabilities, ResumeState, RunContext, StopReason, UserMessage } from '../protocol/adapter';
import { EventChannel, Gate } from './util';

/**
 * The `api-loop` reference adapter (§6.4): AgentForge's own agent loop
 * against provider HTTP APIs — Anthropic or any OpenAI-compatible endpoint.
 * Small auditable toolset via sandbox exec; `allowed_commands` enforced
 * exactly; transcript-replay resume; native structured output for
 * decision nodes.
 */

// ---- neutral transcript ----------------------------------------------------

type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; toolUseId: string; content: string; isError?: boolean };

interface TranscriptMessage {
  role: 'user' | 'assistant';
  content: ContentBlock[];
}

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

interface ChatResponseBlock {
  type: 'text' | 'thinking' | 'tool_use';
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
}

interface ChatResponse {
  blocks: ChatResponseBlock[];
  usage: { tokensIn: number; tokensOut: number };
}

interface ChatArgs {
  model: string;
  system: string;
  messages: TranscriptMessage[];
  tools: ToolDef[];
  maxTokens: number;
  signal: AbortSignal;
}

interface ChatProvider {
  chat(args: ChatArgs): Promise<ChatResponse>;
}

// ---- providers -------------------------------------------------------------

class AnthropicProvider implements ChatProvider {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
  ) {}

  async chat(args: ChatArgs): Promise<ChatResponse> {
    const res = await fetch(`${this.baseUrl}/v1/messages`, {
      method: 'POST',
      signal: args.signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: args.model,
        max_tokens: args.maxTokens,
        system: args.system,
        tools: args.tools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.inputSchema,
        })),
        messages: args.messages.map((m) => ({
          role: m.role,
          content: m.content.map((block) => {
            switch (block.type) {
              case 'text':
                return { type: 'text', text: block.text };
              case 'tool_use':
                return { type: 'tool_use', id: block.id, name: block.name, input: block.input };
              case 'tool_result':
                return {
                  type: 'tool_result',
                  tool_use_id: block.toolUseId,
                  content: block.content,
                  is_error: block.isError ?? false,
                };
            }
          }),
        })),
      }),
    });
    if (!res.ok) {
      throw new Error(`anthropic api ${res.status}: ${(await res.text()).slice(0, 500)}`);
    }
    const body = (await res.json()) as {
      content: Array<{
        type: string;
        text?: string;
        thinking?: string;
        id?: string;
        name?: string;
        input?: Record<string, unknown>;
      }>;
      usage: { input_tokens: number; output_tokens: number };
    };
    return {
      blocks: body.content.map((block) =>
        block.type === 'thinking'
          ? { type: 'thinking', text: block.thinking ?? '' }
          : block.type === 'tool_use'
            ? { type: 'tool_use', id: block.id, name: block.name, input: block.input ?? {} }
            : { type: 'text', text: block.text ?? '' },
      ),
      usage: { tokensIn: body.usage.input_tokens, tokensOut: body.usage.output_tokens },
    };
  }
}

class OpenAiCompatibleProvider implements ChatProvider {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
  ) {}

  async chat(args: ChatArgs): Promise<ChatResponse> {
    const messages: Array<Record<string, unknown>> = [{ role: 'system', content: args.system }];
    for (const m of args.messages) {
      if (m.role === 'assistant') {
        const text = m.content
          .filter((b) => b.type === 'text')
          .map((b) => b.text)
          .join('\n');
        const toolCalls = m.content
          .filter((b) => b.type === 'tool_use')
          .map((b) => ({
            id: b.id,
            type: 'function',
            function: { name: b.name, arguments: JSON.stringify(b.input) },
          }));
        messages.push({
          role: 'assistant',
          content: text || null,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        });
      } else {
        for (const block of m.content) {
          if (block.type === 'tool_result') {
            messages.push({ role: 'tool', tool_call_id: block.toolUseId, content: block.content });
          } else if (block.type === 'text') {
            messages.push({ role: 'user', content: block.text });
          }
        }
      }
    }

    const res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      signal: args.signal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({
        model: args.model,
        max_tokens: args.maxTokens,
        messages,
        tools: args.tools.map((t) => ({
          type: 'function',
          function: { name: t.name, description: t.description, parameters: t.inputSchema },
        })),
      }),
    });
    if (!res.ok) {
      throw new Error(`openai api ${res.status}: ${(await res.text()).slice(0, 500)}`);
    }
    const body = (await res.json()) as {
      choices: Array<{
        message: {
          content: string | null;
          tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
        };
      }>;
      usage?: { prompt_tokens: number; completion_tokens: number };
    };
    const message = body.choices[0]?.message;
    const blocks: ChatResponseBlock[] = [];
    if (message?.content) blocks.push({ type: 'text', text: message.content });
    for (const call of message?.tool_calls ?? []) {
      let input: Record<string, unknown> = {};
      try {
        input = JSON.parse(call.function.arguments) as Record<string, unknown>;
      } catch {
        /* leave empty */
      }
      blocks.push({ type: 'tool_use', id: call.id, name: call.function.name, input });
    }
    return {
      blocks,
      usage: {
        tokensIn: body.usage?.prompt_tokens ?? 0,
        tokensOut: body.usage?.completion_tokens ?? 0,
      },
    };
  }
}

// ---- tools -----------------------------------------------------------------

const STRING = { type: 'string' } as const;

function toolDefs(structuredRoutes: string[] | undefined): ToolDef[] {
  const tools: ToolDef[] = [
    {
      name: 'run_command',
      description: 'Run a shell command in the workspace. Returns exit code, stdout and stderr.',
      inputSchema: {
        type: 'object',
        properties: { command: { ...STRING, description: 'shell command' } },
        required: ['command'],
      },
    },
    {
      name: 'read_file',
      description: 'Read a file (path relative to the workspace root).',
      inputSchema: { type: 'object', properties: { path: STRING }, required: ['path'] },
    },
    {
      name: 'write_file',
      description: 'Create or overwrite a file with the given content.',
      inputSchema: {
        type: 'object',
        properties: { path: STRING, content: STRING },
        required: ['path', 'content'],
      },
    },
    {
      name: 'apply_patch',
      description: 'Apply a unified diff to the workspace (git apply).',
      inputSchema: { type: 'object', properties: { patch: STRING }, required: ['patch'] },
    },
    {
      name: 'search',
      description: 'Search file contents with a regex (grep -rn). Returns up to 100 matches.',
      inputSchema: { type: 'object', properties: { pattern: STRING }, required: ['pattern'] },
    },
  ];
  if (structuredRoutes) {
    tools.push({
      name: 'decide',
      description: 'Record your final decision. You MUST call this exactly once when you have decided.',
      inputSchema: {
        type: 'object',
        properties: {
          route: { type: 'string', enum: structuredRoutes },
          reasoning: { ...STRING, description: 'why you chose this route' },
        },
        required: ['route', 'reasoning'],
      },
    });
  }
  return tools;
}

function commandAllowed(command: string, allowed: string[] | undefined): boolean {
  if (!allowed) return true; // no policy configured → unrestricted
  const trimmed = command.trim();
  return allowed.some((prefix) => prefix === '*' || trimmed.startsWith(prefix));
}

function truncate(text: string, max = 20_000): string {
  return text.length > max ? `${text.slice(0, max)}\n…[truncated]` : text;
}

// ---- the loop --------------------------------------------------------------

interface ApiLoopOptions {
  provider: 'anthropic' | 'openai';
  baseUrl: string;
  apiKey: string;
  maxTurns: number;
  maxTokens: number;
}

interface ApiLoopResumeData {
  transcript: TranscriptMessage[];
}

class ApiLoopHandle implements AgentHandle {
  private readonly channel = new EventChannel();
  readonly events = this.channel.events;

  private transcript: TranscriptMessage[];
  private readonly pendingUserMessages: string[] = [];
  private readonly permissionGates = new Map<string, Gate<'allow' | 'deny'>>();
  private readonly abort = new AbortController();
  private stopped = false;
  private permissionCounter = 0;

  constructor(
    private readonly ctx: RunContext,
    private readonly options: ApiLoopOptions,
    resume?: ApiLoopResumeData,
  ) {
    this.transcript = resume?.transcript ?? [{ role: 'user', content: [{ type: 'text', text: ctx.prompt }] }];
    void this.run();
  }

  getResumeState(): Json {
    return { transcript: this.transcript } as unknown as Json;
  }

  async send(input: UserMessage): Promise<void> {
    this.pendingUserMessages.push(input.text);
  }

  async respondToPermission(id: string, decision: 'allow' | 'deny'): Promise<void> {
    this.permissionGates.get(id)?.resolve(decision);
    this.permissionGates.delete(id);
  }

  async stop(_reason: StopReason): Promise<void> {
    this.stopped = true;
    this.abort.abort();
    for (const gate of this.permissionGates.values()) gate.resolve('deny');
    this.permissionGates.clear();
    this.channel.end();
  }

  private system(): string {
    const allowed = this.ctx.config.allowedCommands;
    return [
      `You are an autonomous coding agent working in a sandboxed workspace.`,
      `Use the provided tools to inspect and modify the code.`,
      allowed ? `Commands matching these prefixes run without approval: ${allowed.join(', ') || '(none)'}. Other commands require user approval.` : ``,
      this.ctx.structured
        ? `You are making a routing decision. Call the \`decide\` tool exactly once with one of: ${this.ctx.structured.routes.join(', ')}.`
        : `When you are completely done, reply with a plain text summary of what you did (no tool calls).`,
    ]
      .filter(Boolean)
      .join('\n');
  }

  private provider(): ChatProvider {
    return this.options.provider === 'openai'
      ? new OpenAiCompatibleProvider(this.options.baseUrl, this.options.apiKey)
      : new AnthropicProvider(this.options.baseUrl, this.options.apiKey);
  }

  private async run(): Promise<void> {
    const provider = this.provider();
    const tools = toolDefs(this.ctx.structured?.routes);
    try {
      let lastText = '';
      for (let turn = 0; turn < this.options.maxTurns; turn++) {
        if (this.stopped) return;
        if (this.pendingUserMessages.length > 0) {
          this.transcript.push({
            role: 'user',
            content: this.pendingUserMessages.splice(0).map((text) => ({ type: 'text', text })),
          });
        }

        const response = await provider.chat({
          model: this.ctx.config.model ?? 'claude-sonnet-5',
          system: this.system(),
          messages: this.transcript,
          tools,
          maxTokens: this.options.maxTokens,
          signal: this.abort.signal,
        });
        if (this.stopped) return;

        this.channel.push({
          type: 'usage',
          tokensIn: response.usage.tokensIn,
          tokensOut: response.usage.tokensOut,
        });

        const assistantContent: ContentBlock[] = [];
        const toolUses: Array<{ id: string; name: string; input: Record<string, unknown> }> = [];
        for (const block of response.blocks) {
          if (block.type === 'thinking') {
            this.channel.push({ type: 'agent.thinking', text: block.text ?? '' });
          } else if (block.type === 'text') {
            lastText = block.text ?? '';
            if (lastText.trim()) this.channel.push({ type: 'agent.message', text: lastText });
            assistantContent.push({ type: 'text', text: block.text ?? '' });
          } else if (block.type === 'tool_use') {
            const use = {
              id: block.id ?? `tool-${turn}-${toolUses.length}`,
              name: block.name ?? 'unknown',
              input: block.input ?? {},
            };
            toolUses.push(use);
            assistantContent.push({ type: 'tool_use', ...use });
          }
        }
        this.transcript.push({ role: 'assistant', content: assistantContent });

        if (toolUses.length === 0) {
          this.channel.push({
            type: 'result',
            outcome: 'success',
            summary: lastText || 'done',
          });
          return;
        }

        const results: ContentBlock[] = [];
        for (const use of toolUses) {
          if (this.stopped) return;
          if (use.name === 'decide' && this.ctx.structured) {
            const route = String(use.input.route ?? '');
            const reasoning = String(use.input.reasoning ?? '');
            this.channel.push({
              type: 'result',
              outcome: 'success',
              summary: reasoning,
              structured: { route, reasoning },
            });
            return;
          }
          this.channel.push({
            type: 'tool.start',
            tool: use.name,
            detail: use.input as unknown as Json,
          });
          const { output, ok } = await this.executeTool(use.name, use.input);
          this.channel.push({ type: 'tool.end', tool: use.name, ok, output: truncate(output) });
          results.push({
            type: 'tool_result',
            toolUseId: use.id,
            content: truncate(output),
            isError: !ok,
          });
        }
        this.transcript.push({ role: 'user', content: results });
      }
      this.channel.push({ type: 'fatal', error: 'max turns exceeded without a result' });
    } catch (error) {
      if (!this.stopped) {
        this.channel.push({ type: 'fatal', error: String(error) });
      }
    } finally {
      this.channel.end();
    }
  }

  private async executeTool(name: string, input: Record<string, unknown>): Promise<{ output: string; ok: boolean }> {
    const sandbox = this.ctx.sandbox;
    try {
      switch (name) {
        case 'run_command': {
          const command = String(input.command ?? '');
          if (!commandAllowed(command, this.ctx.config.allowedCommands)) {
            const id = `perm-${++this.permissionCounter}`;
            const gate = new Gate<'allow' | 'deny'>();
            this.permissionGates.set(id, gate);
            this.channel.push({
              type: 'permission.request',
              id,
              action: 'run_command',
              detail: { command },
            });
            const decision = await gate.promise;
            if (decision === 'deny') {
              return { output: 'command denied by user', ok: false };
            }
          }
          const result = await sandbox.exec(['sh', '-c', command], { timeoutMs: 120_000 });
          const output = `exit=${result.exitCode}\n${result.stdout}${result.stderr ? `\nstderr:\n${result.stderr}` : ''}`;
          return { output, ok: result.exitCode === 0 && !result.timedOut };
        }
        case 'read_file':
          return { output: await sandbox.readFile(String(input.path ?? '')), ok: true };
        case 'write_file': {
          const path = String(input.path ?? '');
          const content = String(input.content ?? '');
          await sandbox.writeFile(path, content);
          this.channel.push({
            type: 'file.change',
            path,
            diff: `--- a/${path}\n+++ b/${path}\n@@ (file written, ${content.split('\n').length} lines) @@`,
          });
          return { output: `wrote ${path}`, ok: true };
        }
        case 'apply_patch': {
          const patch = String(input.patch ?? '');
          const result = await sandbox.exec(['git', 'apply', '--whitespace=nowarn', '-'], {
            stdin: patch,
            timeoutMs: 30_000,
          });
          if (result.exitCode === 0) {
            for (const line of patch.split('\n')) {
              const match = /^\+\+\+ b\/(.+)$/.exec(line);
              if (match) this.channel.push({ type: 'file.change', path: match[1]!, diff: patch });
            }
            return { output: 'patch applied', ok: true };
          }
          return { output: `git apply failed: ${result.stderr}`, ok: false };
        }
        case 'search': {
          const pattern = String(input.pattern ?? '');
          const result = await sandbox.exec(['sh', '-c', `grep -rn -e ${JSON.stringify(pattern)} . | head -100`], { timeoutMs: 30_000 });
          return { output: result.stdout || '(no matches)', ok: true };
        }
        default:
          return { output: `unknown tool: ${name}`, ok: false };
      }
    } catch (error) {
      return { output: String(error), ok: false };
    }
  }
}

export class ApiLoopAdapter implements AgentAdapter {
  readonly id = 'api-loop';
  readonly capabilities: AdapterCapabilities = {
    steering: true,
    permissionGates: true,
    resume: true,
    costReporting: true,
    structuredOutput: true,
  };

  async start(ctx: RunContext): Promise<AgentHandle> {
    return new ApiLoopHandle(ctx, resolveOptions(ctx));
  }

  async resume(ctx: RunContext, state: ResumeState): Promise<AgentHandle> {
    const data = state.data as unknown as ApiLoopResumeData | null;
    return new ApiLoopHandle(ctx, resolveOptions(ctx), data ?? undefined);
  }
}

function resolveOptions(ctx: RunContext): ApiLoopOptions {
  const options = (ctx.config.options ?? {}) as {
    provider?: string;
    baseUrl?: string;
    apiKeyEnv?: string;
    maxTurns?: number;
    maxTokens?: number;
  };
  const provider = options.provider === 'openai' ? 'openai' : 'anthropic';
  const apiKeyEnv = options.apiKeyEnv ?? (provider === 'openai' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY');
  const apiKey = ctx.env[apiKeyEnv];
  if (!apiKey) {
    throw new Error(`api-loop: missing API key (env ${apiKeyEnv} not provisioned)`);
  }
  return {
    provider,
    baseUrl: (options.baseUrl ?? (provider === 'openai' ? 'https://api.openai.com' : 'https://api.anthropic.com')).replace(/\/$/, ''),
    apiKey,
    maxTurns: options.maxTurns ?? 40,
    maxTokens: options.maxTokens ?? 8192,
  };
}
