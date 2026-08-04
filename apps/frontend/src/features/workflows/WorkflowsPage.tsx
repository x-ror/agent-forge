import { Button, StructuredListBody, StructuredListCell, StructuredListHead, StructuredListRow, StructuredListWrapper, Tag, Tile } from '@carbon/react';
import { Add } from '@carbon/icons-react';
import { Link, useNavigate } from 'react-router';
import { useWorkflows } from '../../api/hooks';
import { useAppState } from '../../state/app-state';

export function WorkflowsPage() {
  const { projectId } = useAppState();
  const workflows = useWorkflows(projectId);
  const navigate = useNavigate();

  if (!projectId) {
    return (
      <Tile>
        <h3>No project selected</h3>
        <p>Pick a project in the header first.</p>
      </Tile>
    );
  }

  return (
    <div>
      <div className="af-page__header af-page__header--spread">
        <h3>Workflows</h3>
        <Button renderIcon={Add} onClick={() => navigate('/workflows/new')}>
          New workflow
        </Button>
      </div>
      {workflows.data && workflows.data.length === 0 ? (
        <Tile className="af-empty-state">
          <h4>No workflows yet</h4>
          <p>Create one on the canvas — the canonical Implement → Review → PR template is one click away.</p>
        </Tile>
      ) : (
        <StructuredListWrapper>
          <StructuredListHead>
            <StructuredListRow head>
              <StructuredListCell head>Name</StructuredListCell>
              <StructuredListCell head>Version</StructuredListCell>
              <StructuredListCell head>Enabled</StructuredListCell>
            </StructuredListRow>
          </StructuredListHead>
          <StructuredListBody>
            {(workflows.data ?? []).map((workflow) => (
              <StructuredListRow key={workflow.id}>
                <StructuredListCell>
                  <Link to={`/workflows/${workflow.id}`}>{workflow.name}</Link>
                </StructuredListCell>
                <StructuredListCell>v{workflow.version}</StructuredListCell>
                <StructuredListCell>
                  <Tag type={workflow.enabled ? 'green' : 'gray'}>{workflow.enabled ? 'enabled' : 'disabled'}</Tag>
                </StructuredListCell>
              </StructuredListRow>
            ))}
          </StructuredListBody>
        </StructuredListWrapper>
      )}
    </div>
  );
}
