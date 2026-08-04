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
  TableExpandedRow,
  TableExpandHeader,
  TableExpandRow,
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
import { Fragment, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import type { TaskDto } from '@agentforge/core';
import { useCreateTask, useStartFlow, useSyncTaskSource, useTaskBoard, useTaskSources, useWorkflows } from '../../api/hooks';
import { useSse } from '../../api/sse';
import { useAppState } from '../../state/app-state';
import { StatusTag } from '../../components/StatusTag';
import { formatDateTime } from '../../components/format';
import { buildTaskTree, epicProgress, type TaskTreeNode } from './task-tree';

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

function TaskTitleCell({ task, isEpic, childCount }: { task: TaskDto; isEpic?: boolean; childCount?: number }) {
  return (
    <span className={`af-task-title${isEpic ? ' af-task-title--epic' : ''}`}>
      {isEpic && (
        <Tag type="purple" size="sm" className="af-task-title__epic-tag">
          epic
        </Tag>
      )}
      <span className="af-task-title__text">{task.title}</span>
      {isEpic && childCount != null && childCount > 0 && (
        <span className="af-task-title__count">
          {childCount} task{childCount === 1 ? '' : 's'}
        </span>
      )}
    </span>
  );
}

/** Epic rows show completion instead of their own (meaningless) status. */
function TaskStatusCell({ node }: { node: TaskTreeNode }) {
  const progress = epicProgress(node);
  if (progress) {
    return (
      <span className="af-task-progress">
        {progress.done}/{progress.total} done
      </span>
    );
  }
  return <StatusTag status={node.task.status} />;
}

function TaskActions({ task, onStart }: { task: TaskDto; onStart: (t: TaskDto) => void }) {
  // Epics are containers — start workflows on leaf tasks.
  if (task.meta?.role === 'epic') return null;
  if (task.status !== 'backlog') return null;
  return (
    <Button kind="tertiary" size="sm" renderIcon={Play} onClick={() => onStart(task)}>
      Start workflow
    </Button>
  );
}

function NestedTasksTable({ tasks, onStart }: { tasks: TaskDto[]; onStart: (t: TaskDto) => void }) {
  return (
    <div className="af-task-nested">
      <table className="af-task-nested__table">
        <tbody>
          {tasks.map((child) => (
            <tr key={child.id} className="af-task-nested__row">
              <td className="af-task-nested__title">
                <span className="af-task-nested__indent" aria-hidden />
                {child.title}
              </td>
              <td>
                <StatusTag status={child.status} />
              </td>
              <td className="af-cell--nowrap">{child.externalKey ?? 'manual'}</td>
              <td className="af-cell--nowrap">{formatDateTime(child.updatedAt)}</td>
              <td className="af-task-nested__actions">
                <TaskActions task={child} onStart={onStart} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
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
  // Epics with children start expanded so nested work is visible without a click.
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [expandedSeeded, setExpandedSeeded] = useState(false);

  // Board wake-ups: task.synced / task.status_changed → refetch (§10.3).
  useSse(projectId ? `/api/v1/tasks/stream/${projectId}` : null, {
    onMessage: () => void qc.invalidateQueries({ queryKey: ['tasks', projectId] }),
    onConnect: () => void qc.invalidateQueries({ queryKey: ['tasks', projectId] }),
  });

  const tree = useMemo(() => buildTaskTree(board.data?.tasks ?? []), [board.data?.tasks]);

  // Seed expansion once we have nodes with children (later re-sync keeps user toggles).
  useEffect(() => {
    if (expandedSeeded) return;
    const withKids = tree.filter((n) => n.children.length > 0).map((n) => n.task.id);
    if (withKids.length === 0) return;
    setExpanded(new Set(withKids));
    setExpandedSeeded(true);
  }, [tree, expandedSeeded]);

  if (!projectId) {
    return (
      <Tile>
        <h3>No project selected</h3>
        <p>Pick a project in the header, or create one under Settings.</p>
      </Tile>
    );
  }

  const rows = tree.map((node) => ({
    id: node.task.id,
    title: node.task.title,
    status: node.task.status,
    externalKey: node.task.externalKey ?? 'manual',
    updatedAt: formatDateTime(node.task.updatedAt),
  }));
  const nodeById = new Map(tree.map((n) => [n.task.id, n]));
  const hasAnyEpic = tree.some((n) => n.isEpic);

  const toggleExpand = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <>
      <DataTable rows={rows} headers={HEADERS}>
        {({ rows: renderRows, headers, getHeaderProps, getRowProps, getTableProps }) => (
          <TableContainer title="Task Board" description="Synced and manual tasks for this project — epics expand to show nested work">
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
                  {hasAnyEpic && <TableExpandHeader enableToggle={false} />}
                  {headers.map((header) => (
                    <TableHeader {...getHeaderProps({ header })} key={header.key}>
                      {header.header}
                    </TableHeader>
                  ))}
                </TableRow>
              </TableHead>
              <TableBody>
                {renderRows.map((row) => {
                  const node = nodeById.get(row.id);
                  if (!node) return null;
                  const task = node.task;
                  const isOpen = expanded.has(task.id);
                  const canExpand = node.children.length > 0;
                  // Carbon's getRowProps is generic over the row shape; we only need the spread props.
                  const rowProps = getRowProps({ row });

                  if (canExpand) {
                    return (
                      <Fragment key={row.id}>
                        <TableExpandRow
                          {...rowProps}
                          aria-label={isOpen ? `Collapse ${task.title}` : `Expand ${task.title}`}
                          isExpanded={isOpen}
                          onExpand={() => toggleExpand(task.id)}
                          className="af-task-row--epic"
                        >
                          <TableCell>
                            <TaskTitleCell task={task} isEpic childCount={node.children.length} />
                          </TableCell>
                          <TableCell>
                            <TaskStatusCell node={node} />
                          </TableCell>
                          <TableCell>{task.externalKey ?? 'manual'}</TableCell>
                          <TableCell className="af-cell--nowrap">{formatDateTime(task.updatedAt)}</TableCell>
                          <TableCell>
                            <TaskActions task={task} onStart={setStartFor} />
                          </TableCell>
                        </TableExpandRow>
                        {isOpen && (
                          <TableExpandedRow colSpan={HEADERS.length + 1} className="af-task-expanded">
                            <NestedTasksTable tasks={node.children} onStart={setStartFor} />
                          </TableExpandedRow>
                        )}
                      </Fragment>
                    );
                  }

                  return (
                    <TableRow {...rowProps} key={row.id} className={node.isEpic ? 'af-task-row--epic' : undefined}>
                      {hasAnyEpic && <TableCell className="cds--table-expand" />}
                      <TableCell>
                        <TaskTitleCell task={task} isEpic={node.isEpic} />
                      </TableCell>
                      <TableCell>
                        <TaskStatusCell node={node} />
                      </TableCell>
                      <TableCell>{task.externalKey ?? 'manual'}</TableCell>
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
                <p>
                  Sync a task source or add a manual task to fill the board. Start a heading with <code>Epic:</code> in TASKS.md (or use GitHub sub-issues / epic labels) to group
                  work under an epic.
                </p>
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
