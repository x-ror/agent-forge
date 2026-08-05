import {
  Button,
  DataTable,
  Dropdown,
  Modal,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableHeader,
  TableRow,
  TableToolbar,
  TableToolbarContent,
  Tag,
  TextArea,
  TextInput,
  Tile,
} from '@carbon/react';
import { Add, Play, Renew } from '@carbon/icons-react';
import { useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import type { TaskDto } from '@agentforge/core';
import { useCreateTask, useStartFlow, useSyncTaskSource, useTaskBoard, useTaskSources, useWorkflows } from '../../api/hooks';
import { useSse } from '../../api/sse';
import { useAppState } from '../../state/app-state';
import { StatusTag } from '../../components/StatusTag';
import { formatDateTime } from '../../components/format';
import { buildEpicFilters, leafTasks, taskUrl, type EpicFilter } from './task-epics';

const HEADERS = [
  { key: 'title', header: 'Task' },
  { key: 'status', header: 'Status' },
  { key: 'externalKey', header: 'Source' },
  { key: 'updatedAt', header: 'Updated' },
  { key: 'actions', header: '' },
];

function StartFlowModal({ task, onClose }: { task: TaskDto; onClose: () => void }) {
  const { projectId } = useAppState();
  const workflows = useWorkflows(projectId);
  const startFlow = useStartFlow();
  const navigate = useNavigate();
  const [workflowId, setWorkflowId] = useState<string | null>(null);
  const items = (workflows.data ?? []).filter((w) => w.enabled);

  return (
    <Modal
      open
      modalHeading={`Start workflow for “${task.title}”`}
      primaryButtonText="Start"
      secondaryButtonText="Cancel"
      primaryButtonDisabled={!workflowId || startFlow.isPending}
      onRequestClose={onClose}
      onRequestSubmit={() => {
        if (!workflowId) return;
        startFlow.mutate({ workflowId, taskId: task.id }, { onSuccess: (flow) => navigate(`/flow-runs/${flow.id}`) });
      }}
    >
      <Dropdown
        id="workflow-select"
        titleText="Workflow"
        label="Choose a workflow"
        items={items}
        itemToString={(w) => (w ? `${w.name} (v${w.version})` : '')}
        onChange={({ selectedItem }) => setWorkflowId(selectedItem?.id ?? null)}
      />
    </Modal>
  );
}

function NewTaskModal({ onClose }: { onClose: () => void }) {
  const { projectId } = useAppState();
  const createTask = useCreateTask();
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  return (
    <Modal
      open
      modalHeading="New task"
      primaryButtonText="Create"
      secondaryButtonText="Cancel"
      primaryButtonDisabled={!title || createTask.isPending}
      onRequestClose={onClose}
      onRequestSubmit={() => createTask.mutate({ projectId: projectId!, title, body }, { onSuccess: onClose })}
    >
      <Stack gap={5}>
        <TextInput id="task-title" labelText="Title" value={title} onChange={(e) => setTitle(e.target.value)} />
        <TextArea id="task-body" labelText="Description" value={body} onChange={(e) => setBody(e.target.value)} />
      </Stack>
    </Modal>
  );
}

/** Title text, linked to the source page (GitHub issue) when one exists. */
function TaskTitleText({ task }: { task: TaskDto }) {
  const url = taskUrl(task);
  if (!url) return <span className="af-task-title__text">{task.title}</span>;
  return (
    <a className="af-task-title__text af-task-title__link" href={url} target="_blank" rel="noreferrer">
      {task.title}
    </a>
  );
}

function TaskTitleCell({ task }: { task: TaskDto }) {
  return (
    <span className="af-task-title">
      <TaskTitleText task={task} />
    </span>
  );
}

function TaskActions({ task, onStart }: { task: TaskDto; onStart: (t: TaskDto) => void }) {
  if (task.status !== 'backlog') return null;
  return (
    <Button kind="tertiary" size="sm" renderIcon={Play} onClick={() => onStart(task)}>
      Start workflow
    </Button>
  );
}

/** Epic filter chips: `title · done/total` — click to filter, click again to clear. */
function EpicChips({ filters, selected, onSelect }: { filters: EpicFilter[]; selected: string | null; onSelect: (key: string | null) => void }) {
  if (filters.length === 0) return null;
  return (
    <div className="af-epic-chips" role="group" aria-label="Filter by epic">
      <Button size="sm" kind={selected === null ? 'primary' : 'tertiary'} onClick={() => onSelect(null)}>
        All tasks
      </Button>
      {filters.map((f) => {
        const key = f.task.externalKey!;
        return (
          <Button key={key} size="sm" kind={selected === key ? 'primary' : 'tertiary'} className="af-epic-chip" onClick={() => onSelect(selected === key ? null : key)}>
            <span className="af-epic-chip__title">{f.task.title}</span>
            <span className="af-epic-chip__progress">
              {f.done}/{f.total}
            </span>
          </Button>
        );
      })}
    </div>
  );
}

/** Context line for the active epic: progress, board membership, source link. */
function EpicContext({ filter }: { filter: EpicFilter }) {
  const url = taskUrl(filter.task);
  return (
    <p className="af-epic-context">
      <Tag type="purple" size="sm">
        epic
      </Tag>
      <strong>{filter.task.title}</strong> — {filter.done}/{filter.total} done, {filter.memberCount} open on this board
      {url && (
        <>
          {' · '}
          <a href={url} target="_blank" rel="noreferrer">
            open source issue
          </a>
        </>
      )}
    </p>
  );
}

export function TaskBoardPage() {
  const { projectId } = useAppState();
  const board = useTaskBoard(projectId);
  const sources = useTaskSources(projectId);
  const syncSource = useSyncTaskSource();
  const qc = useQueryClient();
  const [startFor, setStartFor] = useState<TaskDto | null>(null);
  const [newTask, setNewTask] = useState(false);
  const [epicKey, setEpicKey] = useState<string | null>(null);

  // Board wake-ups: task.synced / task.status_changed → refetch (§10.3).
  useSse(projectId ? `/api/v1/tasks/stream/${projectId}` : null, {
    onMessage: () => void qc.invalidateQueries({ queryKey: ['tasks', projectId] }),
    onConnect: () => void qc.invalidateQueries({ queryKey: ['tasks', projectId] }),
  });

  const tasks = board.data?.tasks ?? [];
  const epicFilters = useMemo(() => buildEpicFilters(tasks), [tasks]);
  const leaves = useMemo(() => leafTasks(tasks, epicKey), [tasks, epicKey]);
  const activeEpic = epicKey ? epicFilters.find((f) => f.task.externalKey === epicKey) : undefined;

  if (!projectId) {
    return (
      <Tile>
        <h3>No project selected</h3>
        <p>Pick a project in the header, or create one under Settings.</p>
      </Tile>
    );
  }

  const rows = leaves.map((task) => ({
    id: task.id,
    title: task.title,
    status: task.status,
    externalKey: task.externalKey ?? 'manual',
    updatedAt: formatDateTime(task.updatedAt),
  }));
  const taskById = new Map(leaves.map((t) => [t.id, t]));

  return (
    <>
      <DataTable rows={rows} headers={HEADERS}>
        {({ rows: renderRows, headers, getHeaderProps, getRowProps, getTableProps }) => (
          <TableContainer title="Task Board" description="Synced and manual tasks for this project — pick an epic chip to focus its work">
            <TableToolbar>
              <TableToolbarContent>
                {(sources.data ?? []).map((source) => (
                  <Button key={source.id} kind="ghost" size="sm" renderIcon={Renew} onClick={() => syncSource.mutate(source.id)}>
                    Sync {source.kind}
                  </Button>
                ))}
                <Button kind="primary" size="sm" renderIcon={Add} onClick={() => setNewTask(true)}>
                  New task
                </Button>
              </TableToolbarContent>
            </TableToolbar>
            <EpicChips filters={epicFilters} selected={epicKey} onSelect={setEpicKey} />
            {activeEpic && <EpicContext filter={activeEpic} />}
            <Table {...getTableProps()}>
              <TableHead>
                <TableRow>
                  {headers.map((header) => (
                    <TableHeader {...getHeaderProps({ header })} key={header.key}>
                      {header.header}
                    </TableHeader>
                  ))}
                </TableRow>
              </TableHead>
              <TableBody>
                {renderRows.map((row) => {
                  const task = taskById.get(row.id);
                  if (!task) return null;
                  return (
                    <TableRow {...getRowProps({ row })} key={row.id}>
                      <TableCell>
                        <TaskTitleCell task={task} />
                      </TableCell>
                      <TableCell>
                        <StatusTag status={task.status} />
                      </TableCell>
                      <TableCell className="af-cell--nowrap">{task.externalKey ?? 'manual'}</TableCell>
                      <TableCell className="af-cell--nowrap">{formatDateTime(task.updatedAt)}</TableCell>
                      <TableCell>
                        <TaskActions task={task} onStart={setStartFor} />
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
            {renderRows.length === 0 && (
              <Tile className="af-empty-state">
                {activeEpic ? (
                  <>
                    <h4>No open tasks in this epic</h4>
                    <p>Everything referenced by this epic is either done or not synced (closed issues are not fetched).</p>
                  </>
                ) : (
                  <>
                    <h4>No tasks yet</h4>
                    <p>
                      Sync a task source or add a manual task to fill the board. Start a heading with <code>Epic:</code> in TASKS.md (or use GitHub sub-issues / epic labels) to
                      group work into epic filters.
                    </p>
                  </>
                )}
              </Tile>
            )}
          </TableContainer>
        )}
      </DataTable>
      {startFor && <StartFlowModal task={startFor} onClose={() => setStartFor(null)} />}
      {newTask && <NewTaskModal onClose={() => setNewTask(false)} />}
    </>
  );
}
