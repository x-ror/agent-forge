import { useEffect, useRef } from 'react';

/**
 * SSE subscription per §10.3: messages patch/invalidate query caches; on
 * (re)connect the caller refetches from its durable cursor, so a missed
 * message is never assumed. EventSource reconnects automatically and
 * replays Last-Event-ID for run streams.
 */
export function useSse(
  url: string | null,
  handlers: {
    onMessage?: (data: unknown, lastEventId: string | null) => void;
    /** Fired on every (re)connect — do the cursor refetch here. */
    onConnect?: () => void;
  },
): void {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    if (!url) return;
    const source = new EventSource(url);
    source.onopen = () => handlersRef.current.onConnect?.();
    source.onmessage = (event) => {
      let data: unknown = event.data;
      try {
        data = JSON.parse(event.data as string);
      } catch {
        /* keep raw */
      }
      handlersRef.current.onMessage?.(data, event.lastEventId || null);
    };
    return () => source.close();
  }, [url]);
}
