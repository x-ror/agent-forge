import type { AgentAdapter, AgentEvent, AgentHandle, Json, ResumeState, RunContext, SandboxHandle, StopReason, UserMessage } from '@agentforge/core';

export type ScriptItem =
  | AgentEvent
  | { delayMs: number }
  | { waitForever: true }
  /** Actually write into the sandbox (so later steps can see the change). */
  | { writeFile: { path: string; content: string } }
  /** Read from the sandbox and emit the content as an agent.message. */
  | { readFile: { path: string } };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class FakeHandle implements AgentHandle {
  readonly received: UserMessage[] = [];
  readonly stops: StopReason[] = [];
  events: AsyncIterable<AgentEvent>;

  private stopped = false;
  private stopSignal!: () => void;
  private readonly stopPromise = new Promise<'stopped'>((resolve) => {
    this.stopSignal = () => resolve('stopped');
  });
  private readonly permissionResolvers = new Map<string, (d: 'allow' | 'deny') => void>();
  /** Index of the next unprocessed script item — the resume checkpoint. */
  private lastIndex: number;

  constructor(
    private readonly script: ScriptItem[],
    private readonly sandbox: SandboxHandle | null,
    private readonly startIndex = 0,
  ) {
    this.lastIndex = startIndex;
    this.events = this.generate();
  }

  getResumeState(): Json {
    return { index: this.lastIndex };
  }

  private async *generate(): AsyncGenerator<AgentEvent> {
    for (let i = this.startIndex; i < this.script.length; i++) {
      if (this.stopped) return;
      const item = this.script[i]!;
      if ('delayMs' in item) {
        await Promise.race([sleep(item.delayMs), this.stopPromise]);
        this.lastIndex = i + 1;
        continue;
      }
      if ('waitForever' in item) {
        // A resumed handle skips the hang — models a transient stall that
        // does not recur after crash recovery.
        if (this.startIndex > 0) {
          this.lastIndex = i + 1;
          continue;
        }
        await this.stopPromise;
        return;
      }
      if ('writeFile' in item) {
        await this.sandbox?.writeFile(item.writeFile.path, item.writeFile.content);
        this.lastIndex = i + 1;
        yield { type: 'file.change', path: item.writeFile.path, diff: `+++ ${item.writeFile.path}` };
        continue;
      }
      if ('readFile' in item) {
        let content = '(missing)';
        try {
          content = (await this.sandbox?.readFile(item.readFile.path)) ?? '(no sandbox)';
        } catch {
          content = '(missing)';
        }
        this.lastIndex = i + 1;
        yield { type: 'agent.message', text: `reviewed ${item.readFile.path}: ${content}` };
        continue;
      }
      if (item.type === 'permission.request') {
        const decision = new Promise<'allow' | 'deny'>((resolve) => this.permissionResolvers.set(item.id, resolve));
        yield item;
        const result = await Promise.race([decision, this.stopPromise]);
        if (result === 'stopped') return;
        this.lastIndex = i + 1;
        yield {
          type: 'tool.end',
          tool: item.action,
          ok: result === 'allow',
          output: `permission ${result}`,
        };
        continue;
      }
      this.lastIndex = i + 1;
      yield item;
    }
  }

  async send(input: UserMessage): Promise<void> {
    this.received.push(input);
  }

  async respondToPermission(id: string, decision: 'allow' | 'deny'): Promise<void> {
    this.permissionResolvers.get(id)?.(decision);
    this.permissionResolvers.delete(id);
  }

  async stop(reason: StopReason): Promise<void> {
    this.stops.push(reason);
    this.stopped = true;
    this.stopSignal();
  }
}

export class FakeAdapter implements AgentAdapter {
  readonly id: string;
  readonly capabilities;
  readonly handles: FakeHandle[] = [];

  constructor(
    private readonly script: ScriptItem[],
    opts: { id?: string; resume?: boolean } = {},
  ) {
    this.id = opts.id ?? 'fake';
    this.capabilities = {
      steering: true,
      permissionGates: true,
      resume: opts.resume ?? false,
      costReporting: true,
      structuredOutput: true,
    };
    if (opts.resume) {
      this.resume = async (ctx: RunContext, state: ResumeState) => {
        const startIndex = typeof state.data === 'object' && state.data !== null && 'index' in state.data ? Number((state.data as { index: Json }).index) : 0;
        const handle = new FakeHandle(this.script, ctx.sandbox, Math.max(startIndex, 1));
        this.handles.push(handle);
        return handle;
      };
    }
  }

  resume?: (ctx: RunContext, state: ResumeState) => Promise<AgentHandle>;

  async start(ctx: RunContext): Promise<AgentHandle> {
    const handle = new FakeHandle(this.script, ctx.sandbox);
    this.handles.push(handle);
    return handle;
  }
}
