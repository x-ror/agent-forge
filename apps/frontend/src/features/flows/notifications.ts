import { useEffect, useRef } from 'react';
import { useFlowRuns } from '../../api/hooks';

/**
 * Human-gate awareness: the flow-runs poll (5s) already carries every status —
 * watch transitions and surface them instead of relying on the user staring
 * at the list. Tab title carries an awaiting-approval badge; transitions to
 * awaiting_input/failed fire a browser notification (permission requested
 * once, silently degraded when denied).
 */
export function useFlowNotifications(): void {
  const flows = useFlowRuns();
  const prior = useRef<Map<string, string>>(new Map());
  const seeded = useRef(false);

  useEffect(() => {
    if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
      void Notification.requestPermission();
    }
  }, []);

  useEffect(() => {
    const runs = flows.data ?? [];
    if (runs.length === 0 && !seeded.current) return;

    const awaiting = runs.filter((f) => f.status === 'awaiting_input').length;
    const base = 'AgentForge';
    document.title = awaiting > 0 ? `(${awaiting}) ${base}` : base;

    // First page load seeds silently — notify on *transitions* only.
    if (!seeded.current) {
      for (const f of runs) prior.current.set(f.id, f.status);
      seeded.current = true;
      return;
    }

    for (const f of runs) {
      const before = prior.current.get(f.id);
      prior.current.set(f.id, f.status);
      if (before === f.status) continue;
      const label = f.taskTitle ?? `flow ${f.id.slice(-8)}`;
      if (f.status === 'awaiting_input') notify('Gate awaiting your approval', label, f.id);
      else if (f.status === 'failed' && before !== undefined) notify('Flow failed', label, f.id);
    }
  }, [flows.data]);
}

function notify(title: string, body: string, flowRunId: string): void {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  const n = new Notification(`AgentForge — ${title}`, { body, tag: `agentforge-${flowRunId}` });
  n.onclick = () => {
    window.focus();
    window.location.assign(`/flow-runs/${flowRunId}`);
  };
}
