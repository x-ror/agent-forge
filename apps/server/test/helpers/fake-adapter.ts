import type {
  AgentAdapter,
  AgentEvent,
  AgentHandle,
  Json,
  ResumeState,
  RunContext,
  StopReason,
  UserMessage,
} from '@agentforge/core';

export type ScriptItem =
  | AgentEvent
  | { delayMs: number }
  | { waitForever: true };

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

  constructor(
    private readonly script: ScriptItem[],
    private readonly startIndex = 0,
  ) {
    this.events = this.generate();
  }

  private async *generate(): AsyncGenerator<AgentEvent> {
    for (let i = this.startIndex; i < this.script.length; i++) {
      if (this.stopped) return;
      const item = this.script[i]!;
      if ('delayMs' in item) {
        await Promise.race([sleep(item.delayMs), this.stopPromise]);
        continue;
      }
      if ('waitForever' in item) {
        await this.stopPromise;
        return;
      }
      if (item.type === 'permission.request') {
        const decision = new Promise<'allow' | 'deny'>((resolve) =>
          this.permissionResolvers.set(item.id, resolve),
        );
        yield item;
        const result = await Promise.race([decision, this.stopPromise]);
        if (result === 'stopped') return;
        yield {
          type: 'tool.end',
          tool: item.action,
          ok: result === 'allow',
          output: `permission ${result}`,
        };
        continue;
      }
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
      this.resume = async (_ctx: RunContext, state: ResumeState) => {
        const startIndex =
          typeof state.data === 'object' && state.data !== null && 'index' in state.data
            ? Number((state.data as { index: Json }).index)
            : 0;
        const handle = new FakeHandle(this.script, startIndex);
        this.handles.push(handle);
        return handle;
      };
    }
  }

  resume?: (ctx: RunContext, state: ResumeState) => Promise<AgentHandle>;

  async start(_ctx: RunContext): Promise<AgentHandle> {
    const handle = new FakeHandle(this.script);
    this.handles.push(handle);
    return handle;
  }
}
