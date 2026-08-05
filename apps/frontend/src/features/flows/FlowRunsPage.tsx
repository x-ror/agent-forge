import { StructuredListBody, StructuredListCell, StructuredListHead, StructuredListRow, StructuredListWrapper, Tile } from '@carbon/react';
import { Link } from 'react-router';
import { useFlowRuns } from '../../api/hooks';
import { StatusTag } from '../../components/StatusTag';
import { formatDateTime } from '../../components/format';

function FlowRunsHeader() {
  return (
    <div className="af-page__header">
      <div>
        <h3 className="af-page__header-title">Flow Runs</h3>
        <p className="af-page__header-desc">Every workflow run across your projects, newest first</p>
      </div>
    </div>
  );
}

export function FlowRunsPage() {
  const flows = useFlowRuns();
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
      <StructuredListWrapper>
        <StructuredListHead>
          <StructuredListRow head>
            <StructuredListCell head>Flow</StructuredListCell>
            <StructuredListCell head>Status</StructuredListCell>
            <StructuredListCell head>Started</StructuredListCell>
            <StructuredListCell head>Finished</StructuredListCell>
          </StructuredListRow>
        </StructuredListHead>
        <StructuredListBody>
          {(flows.data ?? []).map((flow) => (
            <StructuredListRow key={flow.id}>
              <StructuredListCell>
                <Link to={`/flow-runs/${flow.id}`}>{flow.id.slice(-12)}</Link>
              </StructuredListCell>
              <StructuredListCell>
                <StatusTag status={flow.status} />
              </StructuredListCell>
              <StructuredListCell className="af-cell--nowrap">{formatDateTime(flow.startedAt)}</StructuredListCell>
              <StructuredListCell className="af-cell--nowrap">{flow.finishedAt ? formatDateTime(flow.finishedAt) : '—'}</StructuredListCell>
            </StructuredListRow>
          ))}
        </StructuredListBody>
      </StructuredListWrapper>
    </div>
  );
}
