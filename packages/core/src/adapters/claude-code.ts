import type { Json } from '../json';
import type { AgentAdapter, AgentHandle, AdapterCapabilities, ResumeState, RunContext, SandboxProcess, StopReason, UserMessage } from '../protocol/adapter';
import { EventChannel, lines } from './util';

/**
 * Claude Code CLI adapter (§6.3): drives the headless stream-json protocol
 * over stdio inside the sandbox. Permission gates map to control requests;
 * resume uses `--resume <sessionId>`; `--version` handshake fails loudly at
 * start, not mid-run.
 */

interface ClaudeCodeOptions {
  cliPath: string;
  extraArgs: string[];
}

function resolveOptions(ctx: RunContext): ClaudeCodeOptions {
  const options = (ctx.config.options ?? {}) as { cliPath?: string; extraArgs?: unknown };
  return {
    cliPath: options.cliPath ?? 'claude',
    extraArgs: Array.isArray(options.extraArgs) ? options.extraArgs.map(String) : [],
  };
}

interface StreamJsonEvent {
  type?: string;
  subtype?: string;
  session_id?: string;
  request_id?: string;
  request?: { subtype?: string; tool_name?: string; input?: Record<string, unknown> };
  message?: {
    content?: Array<{
      type?: string;
      text?: string;
      thinking?: string;
      id?: string;
      name?: string;
      input?: Record<string, unknown>;
      tool_use_id?: string;
      content?: unknown;
      is_error?: boolean;
    }>;
  };
  result?: string;
  is_error?: boolean;
  total_cost_usd?: number;
  usage?: { input_tokens?: number; output_tokens?: number };
}

/**
 * Adapter-agnostic decisions: parse a mandatory `DECISION: {...}` line out of
 * the final result text (last occurrence wins — earlier mentions may be the
 * agent quoting the instructions).
 */
export function parseDecisionLine(text: string): Json | null {
  const matches = [...text.matchAll(/DECISION:\s*(\{.*\})/g)];
  const last = matches.at(-1);
  if (!last) return null;
  try {
    const parsed: unknown = JSON.parse(last[1]!);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Json;
  } catch {
    // fall through — engine-side coercion still scans the summary text
  }
  return null;
}

class ClaudeCodeHandle implements AgentHandle {
  private readonly channel = new EventChannel();
  readonly events = this.channel.events;

  private sessionId: string | null;
  private readonly toolNames = new Map<string, string>();
  private readonly pendingPermissionInputs = new Map<string, Record<string, unknown>>();
  private stopped = false;

  constructor(
    private readonly proc: SandboxProcess,
    resumeSessionId: string | null,
    private readonly expectDecision: boolean,
  ) {
    this.sessionId = resumeSessionId;
    void this.readLoop();
  }

  getResumeState(): Json {
    return this.sessionId ? { sessionId: this.sessionId } : null;
  }

  sendInitialPrompt(prompt: string): void {
    this.writeLine({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: prompt }] },
    });
  }

  async send(input: UserMessage): Promise<void> {
    this.writeLine({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: input.text }] },
    });
  }

  async respondToPermission(id: string, decision: 'allow' | 'deny', note?: string): Promise<void> {
    const input = this.pendingPermissionInputs.get(id);
    this.pendingPermissionInputs.delete(id);
    this.writeLine({
      type: 'control_response',
      response: {
        request_id: id,
        subtype: 'success',
        response: decision === 'allow' ? { behavior: 'allow', updatedInput: input ?? {} } : { behavior: 'deny', message: note ?? 'denied by user' },
      },
    });
  }

  async stop(_reason: StopReason): Promise<void> {
    this.stopped = true;
    this.proc.kill('TERM');
    const graceful = new Promise<void>((resolve) => setTimeout(resolve, 5000));
    await Promise.race([this.proc.wait().then(() => undefined), graceful]);
    this.proc.kill('KILL');
    this.channel.end();
  }

  private writeLine(value: unknown): void {
    try {
      this.proc.writeStdin(`${JSON.stringify(value)}\n`);
    } catch {
      // process gone — readLoop will close the channel
    }
  }

  private async readLoop(): Promise<void> {
    try {
      for await (const line of lines(this.proc.stdout)) {
        if (this.stopped) break;
        let event: StreamJsonEvent;
        try {
          event = JSON.parse(line) as StreamJsonEvent;
        } catch {
          continue;
        }
        this.handle(event);
      }
    } catch {
      if (!this.stopped) this.channel.push({ type: 'fatal', error: 'claude stream broke' });
    } finally {
      this.channel.end();
    }
  }

  private handle(event: StreamJsonEvent): void {
    switch (event.type) {
      case 'system':
        if (event.subtype === 'init' && event.session_id) this.sessionId = event.session_id;
        return;

      case 'assistant':
        for (const block of event.message?.content ?? []) {
          if (block.type === 'text' && block.text?.trim()) {
            this.channel.push({ type: 'agent.message', text: block.text });
          } else if (block.type === 'thinking' && block.thinking) {
            this.channel.push({ type: 'agent.thinking', text: block.thinking });
          } else if (block.type === 'tool_use') {
            const name = block.name ?? 'unknown';
            if (block.id) this.toolNames.set(block.id, name);
            this.channel.push({
              type: 'tool.start',
              tool: name,
              detail: (block.input ?? {}) as unknown as Json,
            });
            const filePath = block.input?.file_path;
            if (typeof filePath === 'string' && ['Write', 'Edit', 'MultiEdit'].includes(name)) {
              this.channel.push({ type: 'file.change', path: filePath, diff: '' });
            }
          }
        }
        return;

      case 'user':
        for (const block of event.message?.content ?? []) {
          if (block.type === 'tool_result' && block.tool_use_id) {
            const tool = this.toolNames.get(block.tool_use_id) ?? 'unknown';
            const output = typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? '');
            this.channel.push({
              type: 'tool.end',
              tool,
              ok: !(block.is_error ?? false),
              output,
            });
          }
        }
        return;

      case 'control_request': {
        if (event.request?.subtype === 'can_use_tool' && event.request_id) {
          this.pendingPermissionInputs.set(event.request_id, event.request.input ?? {});
          this.channel.push({
            type: 'permission.request',
            id: event.request_id,
            action: event.request.tool_name ?? 'unknown',
            detail: (event.request.input ?? {}) as unknown as Json,
          });
        }
        return;
      }

      case 'result': {
        if (event.usage) {
          this.channel.push({
            type: 'usage',
            tokensIn: event.usage.input_tokens ?? 0,
            tokensOut: event.usage.output_tokens ?? 0,
            costUsd: event.total_cost_usd,
          });
        }
        const failed = (event.is_error ?? false) || event.subtype !== 'success';
        const structured = this.expectDecision && !failed ? parseDecisionLine(event.result ?? '') : null;
        this.channel.push({
          type: 'result',
          outcome: failed ? 'failure' : 'success',
          summary: event.result ?? '',
          ...(structured !== null ? { structured } : {}),
        });
        // One run = one CLI turn. In stream-json input mode the CLI waits on
        // stdin for the next user message and never exits by itself — close
        // stdin so it terminates and the event channel drains; a later step
        // continues the session via --resume. Keep a kill fallback in case
        // the CLI ignores EOF.
        try {
          this.proc.endStdin();
        } catch {
          // process already gone
        }
        const grace = setTimeout(() => this.proc.kill('TERM'), 15_000);
        void this.proc.wait().then(() => clearTimeout(grace));
        return;
      }

      default:
        return; // unmapped stream events are dropped; the transcript is in Claude's session
    }
  }
}

export class ClaudeCodeAdapter implements AgentAdapter {
  readonly id = 'claude-code';
  readonly capabilities: AdapterCapabilities = {
    steering: true,
    permissionGates: true,
    resume: true,
    costReporting: true,
    // Via prompt contract: decision runs demand a final `DECISION: {...}`
    // line, parsed from the result text.
    structuredOutput: true,
  };

  async start(ctx: RunContext): Promise<AgentHandle> {
    return this.launch(ctx, null);
  }

  async resume(ctx: RunContext, state: ResumeState): Promise<AgentHandle> {
    const sessionId = typeof state.data === 'object' && state.data !== null && 'sessionId' in state.data ? String((state.data as { sessionId: unknown }).sessionId) : null;
    return this.launch(ctx, sessionId);
  }

  private async launch(ctx: RunContext, resumeSessionId: string | null): Promise<AgentHandle> {
    const options = resolveOptions(ctx);

    // --version handshake: incompatible/missing CLI fails at start (§6.3).
    const version = await ctx.sandbox.exec([options.cliPath, '--version'], { timeoutMs: 30_000 });
    if (version.exitCode !== 0) {
      throw new Error(`claude-code: '${options.cliPath} --version' failed (exit ${version.exitCode}): ${version.stderr}`);
    }

    const args = [
      options.cliPath,
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      ...(ctx.config.model ? ['--model', ctx.config.model] : []),
      ...(resumeSessionId ? ['--resume', resumeSessionId] : []),
      ...options.extraArgs,
    ];
    const proc = await ctx.sandbox.spawn(args, { env: ctx.env });
    const handle = new ClaudeCodeHandle(proc, resumeSessionId, Boolean(ctx.structured));
    // Repo-imported agents store their full markdown brief in config.systemPrompt.
    const systemPrompt = typeof ctx.config.systemPrompt === 'string' && ctx.config.systemPrompt.trim().length > 0 ? ctx.config.systemPrompt.trim() : null;
    let prompt = systemPrompt ? `# Agent instructions\n\n${systemPrompt}\n\n---\n\n# Task\n\n${ctx.prompt}` : ctx.prompt;
    if (ctx.structured) {
      prompt += `\n\n---\n\n# Answer format (mandatory)\n\nThis is a decision task. After your analysis, end your final reply with exactly one line:\n\nDECISION: {"route": "<one of: ${ctx.structured.routes.join(
        ', ',
      )}>", "reasoning": "<one concise sentence>"}\n\nThe route value must be exactly one of: ${ctx.structured.routes.join(', ')}.`;
    }
    handle.sendInitialPrompt(prompt);
    return handle;
  }
}
