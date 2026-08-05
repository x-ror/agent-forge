import { Table, TableBody, TableCell, TableContainer, TableHead, TableHeader, TableRow, Tile } from '@carbon/react';
import { Link } from 'react-router';
import { useFlowRuns } from '../../api/hooks';
import { useAppState } from '../../state/app-state';
import { StatusTag } from '../../components/StatusTag';
import { formatDateTime } from '../../components/format';

function FlowRunsHeader() {
  return (
    <div className="af-page__header">
      <div>
        <h3 className="af-page__header-title">Flow Runs</h3>
        <p className="af-page__header-desc">Every workflow run in the active project, newest first</p>
      </div>
    </div>
  );
}

export function FlowRunsPage() {
  const { projectId } = useAppState();
  const flows = useFlowRuns(projectId);
  if (flows.data && flows.data.length === 0) {
    return (
      <div>
        <FlowRunsHeader />
        <Tile className="af-empty-state">
          <h4>No flow runs yet</h4>
          <p>Start a workflow from the Task Board — every run shows up here with its full timeline.</p>
        </Tile>
      </div>
    );
  }
  return (
    <div>
      <FlowRunsHeader />
      <TableContainer>
        <Table>
          <TableHead>
            <TableRow>
              <TableHeader>Task</TableHeader>
              <TableHeader>Workflow</TableHeader>
              <TableHeader>Status</TableHeader>
              <TableHeader>Started</TableHeader>
              <TableHeader>Finished</TableHeader>
            </TableRow>
          </TableHead>
          <TableBody>
            {(flows.data ?? []).map((flow) => (
              <TableRow key={flow.id}>
                <TableCell>
                  <Link className="af-row-link" to={`/flow-runs/${flow.id}`}>
                    {flow.taskTitle ?? flow.id.slice(-12)}
                  </Link>
                </TableCell>
                <TableCell className="af-cell--nowrap">
                  {flow.workflowName ?? '—'}
                  {flow.projectName ? <span className="af-settings__muted"> · {flow.projectName}</span> : null}
                </TableCell>
                <TableCell>
                  <StatusTag status={flow.status} />
                </TableCell>
                <TableCell className="af-cell--nowrap">{formatDateTime(flow.startedAt)}</TableCell>
                <TableCell className="af-cell--nowrap">{flow.finishedAt ? formatDateTime(flow.finishedAt) : '—'}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
    </div>
  );
}
