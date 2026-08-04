import type { AgentEvent } from '../protocol/agent-events';

/**
 * Push/pull bridge between adapter internals (push) and the orchestrator's
 * `for await` consumption (pull). `end()` completes the stream.
 */
export class EventChannel {
  private buffer: AgentEvent[] = [];
  private waiters: Array<(result: IteratorResult<AgentEvent>) => void> = [];
  private ended = false;

  push(event: AgentEvent): void {
    if (this.ended) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: event, done: false });
    else this.buffer.push(event);
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter({ value: undefined as never, done: true });
    }
  }

  get events(): AsyncIterable<AgentEvent> {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const channel = this;
    return {
      [Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
        return {
          next(): Promise<IteratorResult<AgentEvent>> {
            const buffered = channel.buffer.shift();
            if (buffered !== undefined) {
              return Promise.resolve({ value: buffered, done: false });
            }
            if (channel.ended) {
              return Promise.resolve({ value: undefined as never, done: true });
            }
            return new Promise((resolve) => channel.waiters.push(resolve));
          },
        };
      },
    };
  }
}

/** Deferred decision used for permission gates. */
export class Gate<T> {
  private resolver!: (value: T) => void;
  readonly promise = new Promise<T>((resolve) => {
    this.resolver = resolve;
  });
  resolve(value: T): void {
    this.resolver(value);
  }
}

/** Splits a chunked text stream into lines. */
export async function* lines(chunks: AsyncIterable<string>): AsyncGenerator<string> {
  let buffer = '';
  for await (const chunk of chunks) {
    buffer += chunk;
    let index: number;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).replace(/\r$/, '');
      buffer = buffer.slice(index + 1);
      if (line.length > 0) yield line;
    }
  }
  if (buffer.trim().length > 0) yield buffer;
}
