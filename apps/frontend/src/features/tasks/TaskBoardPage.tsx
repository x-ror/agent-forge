import { Button, DataTable, Dropdown, Modal, Stack, Table, TableBody, TableCell, TableContainer, TableHead, TableHeader, TableRow, TextArea, TextInput, Tile } from '@carbon/react';
import { Add, Play, Renew } from '@carbon/icons-react';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import type { TaskDto } from '@agentforge/core';
import { useCreateTask, useStartFlow, useSyncTaskSource, useTaskBoard, useTaskSources, useWorkflows } from '../../api/hooks';
import { useSse } from '../../api/sse';
import { useAppState } from '../../state/app-state';
import { StatusTag } from '../../components/StatusTag';
import { formatDateTime, sourceKindLabel } from '../../components/format';

/** Source web page for the task (GitHub issue html_url); null for file/manual tasks. */
function taskUrl(task: TaskDto): string | null {
  const v = task.meta?.url;
  return typeof v === 'string' && /^https?:\/\//.test(v) ? v : null;
}

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

export function TaskBoardPage() {
  const { projectId } = useAppState();
  const board = useTaskBoard(projectId);
  const sources = useTaskSources(projectId);
  const syncSource = useSyncTaskSource();
  const qc = useQueryClient();
  const [startFor, setStartFor] = useState<TaskDto | null>(null);
  const [newTask, setNewTask] = useState(false);

  // Board wake-ups: task.synced / task.status_changed → refetch (§10.3).
  useSse(projectId ? `/api/v1/tasks/stream/${projectId}` : null, {
    onMessage: () => void qc.invalidateQueries({ queryKey: ['tasks', projectId] }),
    onConnect: () => void qc.invalidateQueries({ queryKey: ['tasks', projectId] }),
  });

  const tasks = board.data?.tasks ?? [];

  if (!projectId) {
    return (
      <Tile>
        <h3>No project selected</h3>
        <p>Pick a project in the header, or create one under Settings.</p>
      </Tile>
    );
  }

  const rows = tasks.map((task) => ({
    id: task.id,
    title: task.title,
    status: task.status,
    externalKey: task.externalKey ?? 'manual',
    updatedAt: formatDateTime(task.updatedAt),
  }));
  const taskById = new Map(tasks.map((t) => [t.id, t]));

  return (
    <>
      <DataTable rows={rows} headers={HEADERS}>
        {({ rows: renderRows, headers, getHeaderProps, getRowProps, getTableProps }) => (
          <TableContainer>
            <div className="af-page__header af-page__header--spread">
              <div>
                <h3 className="af-page__header-title">Task Board</h3>
                <p className="af-page__header-desc">Synced and manual tasks for this project</p>
              </div>
              <div className="af-page__header-actions">
                {(sources.data ?? []).map((source) => (
                  <Button key={source.id} kind="ghost" size="sm" renderIcon={Renew} onClick={() => syncSource.mutate(source.id)}>
                    Sync {sourceKindLabel(source.kind)}
                  </Button>
                ))}
                <Button kind="primary" size="sm" renderIcon={Add} onClick={() => setNewTask(true)}>
                  New task
                </Button>
              </div>
            </div>
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
                <h4>No tasks yet</h4>
                <p>Sync a task source or add a manual task to fill the board.</p>
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
