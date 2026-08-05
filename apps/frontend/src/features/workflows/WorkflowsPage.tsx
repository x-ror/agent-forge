import { Button, Table, TableBody, TableCell, TableContainer, TableHead, TableHeader, TableRow, Tag, Tile } from '@carbon/react';
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
        <div>
          <h3 className="af-page__header-title">Workflows</h3>
          <p className="af-page__header-desc">Versioned agent pipelines for this project — built on the canvas</p>
        </div>
        <Button size="sm" renderIcon={Add} onClick={() => navigate('/workflows/new')}>
          New workflow
        </Button>
      </div>
      {workflows.data && workflows.data.length === 0 ? (
        <Tile className="af-empty-state">
          <h4>No workflows yet</h4>
          <p>Create one on the canvas — the canonical Implement → Review → PR template is one click away.</p>
        </Tile>
      ) : (
        <TableContainer>
          <Table>
            <TableHead>
              <TableRow>
                <TableHeader>Name</TableHeader>
                <TableHeader>Version</TableHeader>
                <TableHeader>Enabled</TableHeader>
              </TableRow>
            </TableHead>
            <TableBody>
              {(workflows.data ?? []).map((workflow) => (
                <TableRow key={workflow.id}>
                  <TableCell>
                    <Link className="af-row-link" to={`/workflows/${workflow.id}`}>
                      {workflow.name}
                    </Link>
                  </TableCell>
                  <TableCell className="af-cell--nowrap">v{workflow.version}</TableCell>
                  <TableCell>
                    <Tag type={workflow.enabled ? 'green' : 'gray'}>{workflow.enabled ? 'enabled' : 'disabled'}</Tag>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}
    </div>
  );
}
