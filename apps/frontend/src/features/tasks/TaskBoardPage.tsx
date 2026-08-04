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
  TextArea,
  TextInput,
  Tile,
} from '@carbon/react';
import { Add, Play, Renew } from '@carbon/icons-react';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import type { TaskDto } from '@agentforge/core';
import { useCreateTask, useStartFlow, useSyncTaskSource, useTaskBoard, useTaskSources, useWorkflows } from '../../api/hooks';
import { useSse } from '../../api/sse';
import { useAppState } from '../../state/app-state';
import { StatusTag } from '../../components/StatusTag';
import { formatDateTime } from '../../components/format';

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

  if (!projectId) {
    return (
      <Tile>
        <h3>No project selected</h3>
        <p>Pick a project in the header, or create one under Settings.</p>
      </Tile>
    );
  }

  const rows = (board.data?.tasks ?? []).map((task) => ({
    id: task.id,
    title: task.title,
    status: task.status,
    externalKey: task.externalKey ?? 'manual',
    updatedAt: formatDateTime(task.updatedAt),
  }));
  const byId = new Map((board.data?.tasks ?? []).map((t) => [t.id, t]));

  return (
    <>
      <DataTable rows={rows} headers={HEADERS}>
        {({ rows: renderRows, headers, getHeaderProps, getRowProps, getTableProps }) => (
          <TableContainer title="Task Board" description="Synced and manual tasks for this project">
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
                  const task = byId.get(row.id)!;
                  return (
                    <TableRow {...getRowProps({ row })} key={row.id}>
                      <TableCell>{task.title}</TableCell>
                      <TableCell>
                        <StatusTag status={task.status} />
                      </TableCell>
                      <TableCell>{task.externalKey ?? 'manual'}</TableCell>
                      <TableCell className="af-cell--nowrap">{formatDateTime(task.updatedAt)}</TableCell>
                      <TableCell>
                        {task.status === 'backlog' && (
                          <Button kind="tertiary" size="sm" renderIcon={Play} onClick={() => setStartFor(task)}>
                            Start workflow
                          </Button>
                        )}
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
