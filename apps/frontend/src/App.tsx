import { Content, Dropdown, Header, HeaderGlobalAction, HeaderGlobalBar, HeaderName, InlineLoading, SideNav, SideNavItems, SideNavLink, Theme } from '@carbon/react';
import { Asleep, Light, Logout } from '@carbon/icons-react';
import { Link, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './api/client';
import { useMe, useLogout, useProjects } from './api/hooks';
import { useAppState } from './state/app-state';
import { LoginPage } from './features/auth/LoginPage';
import { SetupWizard } from './features/setup/SetupWizard';
import { TaskBoardPage } from './features/tasks/TaskBoardPage';
import { WorkflowsPage } from './features/workflows/WorkflowsPage';
import { WorkflowCanvasPage } from './features/workflows/WorkflowCanvasPage';
import { FlowRunsPage } from './features/flows/FlowRunsPage';
import { FlowRunPage } from './features/flows/FlowRunPage';
import { RunDetailPage } from './features/runs/RunDetailPage';
import { SettingsPage } from './features/settings/SettingsPage';

function ProjectPicker() {
  const { projectId, setProjectId } = useAppState();
  const projects = useProjects();
  const items = projects.data ?? [];
  const selected = items.find((p) => p.id === projectId) ?? null;
  return (
    <div className="af-shell__project-picker">
      <Dropdown
        id="project-picker"
        size="sm"
        label="Select project"
        titleText=""
        items={items}
        itemToString={(p) => p?.name ?? ''}
        selectedItem={selected}
        onChange={({ selectedItem }) => setProjectId(selectedItem?.id ?? null)}
      />
    </div>
  );
}

export default function App() {
  const { theme, toggleTheme } = useAppState();
  const me = useMe();
  const logout = useLogout();
  const navigate = useNavigate();
  const location = useLocation();
  const qc = useQueryClient();
  const bootstrap = useQuery({
    queryKey: ['bootstrap'],
    enabled: me.isError,
    queryFn: () => api.get<{ needsSetup: boolean }>('/auth/bootstrap'),
  });

  if (me.isLoading) {
    return (
      <Theme theme={theme}>
        <Content>
          <InlineLoading description="Loading AgentForge…" />
        </Content>
      </Theme>
    );
  }

  if (me.isError) {
    return <Theme theme={theme}>{bootstrap.data?.needsSetup ? <SetupWizard onDone={() => void qc.invalidateQueries()} /> : <LoginPage />}</Theme>;
  }

  const nav = [
    { to: '/', label: 'Task Board' },
    { to: '/workflows', label: 'Workflows' },
    { to: '/flow-runs', label: 'Flow Runs' },
    { to: '/settings', label: 'Settings' },
  ];

  return (
    <Theme theme={theme}>
      <Header aria-label="AgentForge">
        <HeaderName as={Link} to="/" prefix="">
          AgentForge
        </HeaderName>
        <HeaderGlobalBar>
          <ProjectPicker />
          <HeaderGlobalAction aria-label="Toggle theme" onClick={toggleTheme}>
            {theme === 'g100' ? <Light size={20} /> : <Asleep size={20} />}
          </HeaderGlobalAction>
          <HeaderGlobalAction aria-label="Log out" onClick={() => logout.mutate(undefined, { onSuccess: () => navigate('/') })}>
            <Logout size={20} />
          </HeaderGlobalAction>
        </HeaderGlobalBar>
      </Header>
      <SideNav aria-label="Side navigation" expanded isPersistent isChildOfHeader>
        <SideNavItems>
          {nav.map((item) => (
            <SideNavLink key={item.to} as={Link} to={item.to} isActive={location.pathname === item.to}>
              {item.label}
            </SideNavLink>
          ))}
        </SideNavItems>
      </SideNav>
      <Content className="af-shell__content">
        <Routes>
          <Route path="/" element={<TaskBoardPage />} />
          <Route path="/workflows" element={<WorkflowsPage />} />
          <Route path="/workflows/new" element={<WorkflowCanvasPage />} />
          <Route path="/workflows/:id" element={<WorkflowCanvasPage />} />
          <Route path="/flow-runs" element={<FlowRunsPage />} />
          <Route path="/flow-runs/:id" element={<FlowRunPage />} />
          <Route path="/runs/:id" element={<RunDetailPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Content>
    </Theme>
  );
}
