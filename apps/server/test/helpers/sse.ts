export interface SseEvent {
  id: number;
  data: unknown;
}

/**
 * Minimal SSE client over fetch. Collects events until `until` returns true
 * or the connection is aborted; returns collected events.
 */
export async function collectSse(
  url: string,
  options: {
    cookie?: string;
    lastEventId?: number;
    until: (events: SseEvent[]) => boolean;
    timeoutMs?: number;
    onEvent?: (event: SseEvent) => void;
  },
): Promise<SseEvent[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 30_000);
  const headers: Record<string, string> = { accept: 'text/event-stream' };
  if (options.cookie) headers.cookie = options.cookie;
  if (options.lastEventId !== undefined) headers['last-event-id'] = String(options.lastEventId);

  const events: SseEvent[] = [];
  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    if (!res.ok || !res.body) throw new Error(`SSE connect failed: ${res.status}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sep: number;
      while ((sep = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        let id: number | undefined;
        let data: string | undefined;
        for (const line of block.split('\n')) {
          if (line.startsWith('id: ')) id = Number(line.slice(4));
          if (line.startsWith('data: ')) data = line.slice(6);
        }
        if (id !== undefined && data !== undefined) {
          const event = { id, data: JSON.parse(data) };
          events.push(event);
          options.onEvent?.(event);
        }
      }
      if (options.until(events)) {
        controller.abort();
        break;
      }
    }
  } catch (error) {
    if ((error as Error).name !== 'AbortError') throw error;
  } finally {
    clearTimeout(timeout);
  }
  return events;
}
