import { StructuredListBody, StructuredListCell, StructuredListHead, StructuredListRow, StructuredListWrapper } from '@carbon/react';
import { Link } from 'react-router';
import { useFlowRuns } from '../../api/hooks';
import { StatusTag } from '../../components/StatusTag';

export function FlowRunsPage() {
  const flows = useFlowRuns();
  return (
    <div>
      <h3>Flow Runs</h3>
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
              <StructuredListCell>{new Date(flow.startedAt).toLocaleString()}</StructuredListCell>
              <StructuredListCell>{flow.finishedAt ? new Date(flow.finishedAt).toLocaleString() : '—'}</StructuredListCell>
            </StructuredListRow>
          ))}
        </StructuredListBody>
      </StructuredListWrapper>
    </div>
  );
}
