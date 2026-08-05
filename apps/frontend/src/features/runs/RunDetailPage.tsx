import { ActionableNotification, Button, InlineLoading, InlineNotification, Tab, TabList, TabPanel, TabPanels, Tabs, TextInput, Tile } from '@carbon/react';
import { Send, StopFilled } from '@carbon/icons-react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router';
import type { RunEventDto } from '@agentforge/core';
import { api } from '../../api/client';
import { useRun, useRunDiff, useRunInput } from '../../api/hooks';
import { useSse } from '../../api/sse';
import { StatusTag } from '../../components/StatusTag';
import { formatDateTime, formatDuration } from '../../components/format';
import { DiffView } from '../diff/DiffView';

function EventRow({ event }: { event: RunEventDto }) {
  const payload = event.payload as Record<string, unknown>;
  const label = (
    <span className="af-event-row__label">
      #{event.seq} {event.type}
    </span>
  );
  let body: React.ReactNode = null;
  switch (event.type) {
    case 'agent.message':
    case 'agent.thinking':
    case 'user.message':
      body = <span className={event.type === 'agent.thinking' ? 'af-event-row__thinking' : undefined}>{String(payload.text ?? '')}</span>;
      break;
    case 'tool.start': {
      const detail = (payload.detail ?? {}) as Record<string, unknown>;
      // Show the one thing a human scans for, not the whole JSON blob.
      const gist =
        typeof detail.file_path === 'string'
          ? detail.file_path
          : typeof detail.command === 'string'
            ? detail.command
            : typeof detail.pattern === 'string'
              ? detail.pattern
              : JSON.stringify(detail).slice(0, 200);
      body = (
        <span className="af-event-row__mono">
          <strong>{String(payload.tool)}</strong> {gist}
        </span>
      );
      break;
    }
    case 'tool.end':
      body = (
        <span className="af-event-row__mono">
          {String(payload.tool)} {payload.ok ? '\u2713' : '\u2717'} {String(payload.output ?? '').slice(0, 400)}
        </span>
      );
      break;
    case 'file.change':
      body = <span className="af-event-row__mono">changed {String(payload.path)}</span>;
      break;
    case 'usage':
      body = (
        <span className="af-event-row__mono">
          in {String(payload.tokensIn)} / out {String(payload.tokensOut)}
          {payload.costUsd !== undefined && payload.costUsd !== null ? ` / $${Number(payload.costUsd).toFixed(4)}` : ''}
        </span>
      );
      break;
    case 'result':
      body = (
        <strong>
          {String(payload.outcome)}: {String(payload.summary ?? '')}
        </strong>
      );
      break;
    default:
      body = <span className="af-event-row__mono">{JSON.stringify(payload).slice(0, 400)}</span>;
  }
  const outcome = event.type === 'result' ? String(payload.outcome ?? '') : undefined;
  return (
    <div className="af-event-row" data-event-type={event.type} data-outcome={outcome}>
      {label}
      {body}
    </div>
  );
}

export function RunDetailPage() {
  const { id } = useParams<{ id: string }>();
  const runId = id ?? null;
  const run = useRun(runId);
  const qc = useQueryClient();
  const [events, setEvents] = useState<RunEventDto[]>([]);
  const cursorRef = useRef(0);
  const [message, setMessage] = useState('');
  const runInput = useRunInput(runId ?? '');
  const terminal = run.data && ['succeeded', 'failed', 'cancelled'].includes(run.data.status);
  const diff = useRunDiff(runId, Boolean(terminal));

  const fetchAfterCursor = useCallback(async () => {
    if (!runId) return;
    const fresh = await api.get<RunEventDto[]>(`/runs/${runId}/events?after_seq=${cursorRef.current}`);
    if (fresh.length > 0) {
      setEvents((current) => {
        const known = new Set(current.map((e) => e.seq));
        const merged = [...current, ...fresh.filter((e) => !known.has(e.seq))];
        cursorRef.current = merged.at(-1)?.seq ?? cursorRef.current;
        return merged;
      });
      void qc.invalidateQueries({ queryKey: ['run', runId] });
    }
  }, [runId, qc]);

  // Live stream; the cursor refetch on (re)connect guarantees losslessness (§10.3).
  useSse(runId ? `/api/v1/runs/${runId}/events/stream?after_seq=${cursorRef.current}` : null, {
    onConnect: () => void fetchAfterCursor(),
    onMessage: (data) => {
      const event = data as RunEventDto;
      if (typeof event?.seq !== 'number') return;
      setEvents((current) => {
        if (current.some((e) => e.seq === event.seq)) return current;
        const merged = [...current, event].sort((a, b) => a.seq - b.seq);
        cursorRef.current = merged.at(-1)?.seq ?? cursorRef.current;
        return merged;
      });
      if (event.type === 'result' || event.type.startsWith('orchestrator.')) {
        void qc.invalidateQueries({ queryKey: ['run', runId] });
      }
    },
  });

  useEffect(() => {
    void fetchAfterCursor();
  }, [fetchAfterCursor]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: events.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 34,
    overscan: 20,
  });
  useEffect(() => {
    if (events.length > 0) virtualizer.scrollToIndex(events.length - 1);
  }, [events.length, virtualizer]);

  const pendingPermission = [...events]
    .reverse()
    .find(
      (e) =>
        e.type === 'permission.request' &&
        !events.some((a) => a.type === 'user.approval' && (a.payload as { permissionId?: string }).permissionId === (e.payload as { id?: string }).id),
    );

  if (!run.data) return <InlineLoading description="Loading run…" />;

  const usage = run.data.usage as { tokensIn?: number; tokensOut?: number; costUsd?: number };
  const duration = formatDuration(run.data.startedAt ?? run.data.createdAt, run.data.finishedAt);

  return (
    <div className="af-run-page">
      <div className="af-page__header">
        <div>
          <div className="af-page__title-row">
            <h3 className="af-page__header-title">Run {run.data.id.slice(-8)}</h3>
            <StatusTag status={run.data.status} />
            {run.data.branch && <code className="af-branch-chip">{run.data.branch}</code>}
            {!terminal && (
              <Button kind="danger--ghost" size="sm" renderIcon={StopFilled} onClick={() => runInput.mutate({ kind: 'cancel' })}>
                Cancel run
              </Button>
            )}
          </div>
          <p className="af-page__header-desc">
            {formatDateTime(run.data.startedAt ?? run.data.createdAt)}
            {duration && <> · {duration}</>}
            {typeof usage.costUsd === 'number' && usage.costUsd > 0 && <> · ${usage.costUsd.toFixed(2)}</>}
          </p>
        </div>
      </div>

      {run.data.error && <InlineNotification kind="error" lowContrast hideCloseButton title="Run failed" subtitle={run.data.error} />}

      {pendingPermission && !terminal && (
        <ActionableNotification
          kind="warning"
          lowContrast
          title={`Permission requested: ${String((pendingPermission.payload as { action?: string }).action)}`}
          subtitle={JSON.stringify((pendingPermission.payload as { detail?: unknown }).detail ?? {})}
          actionButtonLabel="Allow"
          onActionButtonClick={() =>
            runInput.mutate({
              kind: 'approval',
              permissionId: String((pendingPermission.payload as { id?: string }).id),
              decision: 'allow',
            })
          }
          onClose={() =>
            runInput.mutate({
              kind: 'approval',
              permissionId: String((pendingPermission.payload as { id?: string }).id),
              decision: 'deny',
            })
          }
        />
      )}

      <Tabs>
        <TabList aria-label="Run views">
          <Tab>Events</Tab>
          <Tab disabled={!terminal}>Diff</Tab>
        </TabList>
        <TabPanels>
          <TabPanel>
            <Tile className="af-run-feed">
              <div ref={scrollRef} className="af-run-feed__scroll" data-testid="event-feed">
                <div className="af-run-feed__spacer" style={{ height: virtualizer.getTotalSize() }}>
                  {virtualizer.getVirtualItems().map((item) => (
                    <div
                      key={item.key}
                      ref={virtualizer.measureElement}
                      data-index={item.index}
                      className="af-run-feed__row-wrapper"
                      style={{ transform: `translateY(${item.start}px)` }}
                    >
                      <EventRow event={events[item.index]!} />
                    </div>
                  ))}
                </div>
              </div>
            </Tile>
            {!terminal && (
              <div className="af-run-detail__steer">
                <TextInput
                  id="steer"
                  labelText="Steer the agent"
                  hideLabel
                  placeholder="Send guidance to the agent…"
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && message.trim()) {
                      runInput.mutate({ kind: 'message', text: message.trim() });
                      setMessage('');
                    }
                  }}
                />
                <Button
                  kind="secondary"
                  size="md"
                  renderIcon={Send}
                  disabled={!message.trim()}
                  onClick={() => {
                    runInput.mutate({ kind: 'message', text: message.trim() });
                    setMessage('');
                  }}
                >
                  Send
                </Button>
              </div>
            )}
          </TabPanel>
          <TabPanel>{diff.data ? <DiffView diff={diff.data.diff} /> : <p>No diff captured.</p>}</TabPanel>
        </TabPanels>
      </Tabs>
    </div>
  );
}
