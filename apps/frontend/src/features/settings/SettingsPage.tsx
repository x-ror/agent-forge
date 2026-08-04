import {
  Accordion,
  AccordionItem,
  Button,
  CodeSnippet,
  Form,
  InlineNotification,
  Select,
  SelectItem,
  Stack,
  StructuredListBody,
  StructuredListCell,
  StructuredListRow,
  StructuredListWrapper,
  TextInput,
} from '@carbon/react';
import { TrashCan } from '@carbon/icons-react';
import { useState } from 'react';
import { api } from '../../api/client';
import { formatDateTime } from '../../components/format';
import { useAdapters, useAgents, useCreateAgent, useCreatePat, useCreateProject, useCreateTaskSource, useDeleteAgent, usePats, useProjects, useTaskSources } from '../../api/hooks';
import { useAppState } from '../../state/app-state';

function ProjectsSection() {
  const projects = useProjects();
  const createProject = useCreateProject();
  const { setProjectId } = useAppState();
  const [name, setName] = useState('');
  const [repoUrl, setRepoUrl] = useState('');
  return (
    <Stack gap={5}>
      <StructuredListWrapper>
        <StructuredListBody>
          {(projects.data ?? []).map((project) => (
            <StructuredListRow key={project.id}>
              <StructuredListCell>{project.name}</StructuredListCell>
              <StructuredListCell>{project.repoUrl}</StructuredListCell>
            </StructuredListRow>
          ))}
        </StructuredListBody>
      </StructuredListWrapper>
      <Form
        aria-label="new project"
        onSubmit={(e) => {
          e.preventDefault();
          createProject.mutate(
            { name, repoUrl, settings: {} },
            {
              onSuccess: (project) => {
                setProjectId(project.id);
                setName('');
                setRepoUrl('');
              },
            },
          );
        }}
      >
        <Stack gap={4}>
          <TextInput id="project-name" labelText="Project name" value={name} onChange={(e) => setName(e.target.value)} required />
          <TextInput id="project-repo" labelText="Repository URL (https, ssh, or file:// for local)" value={repoUrl} onChange={(e) => setRepoUrl(e.target.value)} required />
          <Button type="submit" size="sm" disabled={createProject.isPending}>
            Create project
          </Button>
        </Stack>
      </Form>
    </Stack>
  );
}

function AgentsSection() {
  const agents = useAgents();
  const adapters = useAdapters();
  const createAgent = useCreateAgent();
  const deleteAgent = useDeleteAgent();
  const [name, setName] = useState('');
  const [adapter, setAdapter] = useState('api-loop');
  const [model, setModel] = useState('');
  const [optionsJson, setOptionsJson] = useState('');
  return (
    <Stack gap={5}>
      <StructuredListWrapper>
        <StructuredListBody>
          {(agents.data ?? []).map((agent) => (
            <StructuredListRow key={agent.id}>
              <StructuredListCell>{agent.name}</StructuredListCell>
              <StructuredListCell>{agent.adapter}</StructuredListCell>
              <StructuredListCell>
                <Button kind="danger--ghost" size="sm" renderIcon={TrashCan} iconDescription="Delete" hasIconOnly onClick={() => deleteAgent.mutate(agent.id)} />
              </StructuredListCell>
            </StructuredListRow>
          ))}
        </StructuredListBody>
      </StructuredListWrapper>
      <Form
        aria-label="new agent"
        onSubmit={(e) => {
          e.preventDefault();
          let options: Record<string, unknown> | undefined;
          try {
            options = optionsJson ? (JSON.parse(optionsJson) as Record<string, unknown>) : undefined;
          } catch {
            options = undefined;
          }
          createAgent.mutate({ name, adapter: adapter as never, config: { ...(model ? { model } : {}), ...(options ? { options } : {}) } }, { onSuccess: () => setName('') });
        }}
      >
        <Stack gap={4}>
          <TextInput id="agent-name" labelText="Agent name (referenced by workflows)" value={name} onChange={(e) => setName(e.target.value)} required />
          <Select id="agent-adapter" labelText="Adapter" value={adapter} onChange={(e) => setAdapter(e.target.value)}>
            {(adapters.data ?? []).map((item) => (
              <SelectItem key={item.id} value={item.id} text={item.id} />
            ))}
          </Select>
          <TextInput id="agent-model" labelText="Model (optional)" value={model} onChange={(e) => setModel(e.target.value)} />
          <TextInput
            id="agent-options"
            labelText='Adapter options JSON (optional, e.g. {"provider":"anthropic","baseUrl":"…"})'
            value={optionsJson}
            onChange={(e) => setOptionsJson(e.target.value)}
          />
          <Button type="submit" size="sm" disabled={createAgent.isPending}>
            Register agent
          </Button>
        </Stack>
      </Form>
    </Stack>
  );
}

function SourcesSection() {
  const { projectId } = useAppState();
  const sources = useTaskSources(projectId);
  const createSource = useCreateTaskSource();
  const [kind, setKind] = useState('github_issues');
  if (!projectId) return <p>Select a project first.</p>;
  return (
    <Stack gap={5}>
      <StructuredListWrapper>
        <StructuredListBody>
          {(sources.data ?? []).map((source) => (
            <StructuredListRow key={source.id}>
              <StructuredListCell>{source.kind}</StructuredListCell>
              <StructuredListCell className="af-cell--nowrap">{source.lastSyncedAt ? `synced ${formatDateTime(source.lastSyncedAt)}` : 'never synced'}</StructuredListCell>
            </StructuredListRow>
          ))}
        </StructuredListBody>
      </StructuredListWrapper>
      <Form
        aria-label="new source"
        onSubmit={(e) => {
          e.preventDefault();
          createSource.mutate({ projectId, kind: kind as never, config: {} });
        }}
      >
        <Stack gap={4}>
          <Select id="source-kind" labelText="Source kind" value={kind} onChange={(e) => setKind(e.target.value)}>
            <SelectItem value="github_issues" text="GitHub Issues" />
            <SelectItem value="file" text="Tracked file (TASKS.md)" />
            <SelectItem value="jira" text="Jira (stub)" />
          </Select>
          <Button type="submit" size="sm" disabled={createSource.isPending}>
            Add source
          </Button>
        </Stack>
      </Form>
    </Stack>
  );
}

function SecretsSection() {
  const { projectId } = useAppState();
  const [key, setKey] = useState('');
  const [value, setValue] = useState('');
  const [saved, setSaved] = useState<string | null>(null);
  if (!projectId) return <p>Select a project first.</p>;
  return (
    <Form
      aria-label="put secret"
      onSubmit={(e) => {
        e.preventDefault();
        void api.put(`/projects/${projectId}/secrets/${key}`, { value }).then(() => {
          setSaved(key);
          setKey('');
          setValue('');
        });
      }}
    >
      <Stack gap={4}>
        {saved && <InlineNotification kind="success" lowContrast title={`Secret ${saved} stored`} subtitle="Values are write-only." onClose={() => setSaved(null)} />}
        <TextInput id="secret-key" labelText="Key (UPPER_SNAKE_CASE, e.g. GITHUB_TOKEN)" value={key} onChange={(e) => setKey(e.target.value)} required />
        <TextInput id="secret-value" labelText="Value" type="password" value={value} onChange={(e) => setValue(e.target.value)} required />
        <Button type="submit" size="sm">
          Store secret
        </Button>
      </Stack>
    </Form>
  );
}

function PatsSection() {
  const pats = usePats();
  const createPat = useCreatePat();
  const [name, setName] = useState('');
  const [token, setToken] = useState<string | null>(null);
  return (
    <Stack gap={5}>
      {token && (
        <InlineNotification kind="info" lowContrast title="Copy your token now — it is shown once">
          <CodeSnippet type="single">{token}</CodeSnippet>
        </InlineNotification>
      )}
      <StructuredListWrapper>
        <StructuredListBody>
          {(pats.data ?? []).map((pat) => (
            <StructuredListRow key={pat.id}>
              <StructuredListCell>{pat.name}</StructuredListCell>
              <StructuredListCell>{pat.revokedAt ? 'revoked' : 'active'}</StructuredListCell>
            </StructuredListRow>
          ))}
        </StructuredListBody>
      </StructuredListWrapper>
      <Form
        aria-label="new pat"
        onSubmit={(e) => {
          e.preventDefault();
          createPat.mutate(name, {
            onSuccess: (pat) => {
              setToken(pat.token);
              setName('');
            },
          });
        }}
      >
        <Stack gap={4}>
          <TextInput id="pat-name" labelText="Token name" value={name} onChange={(e) => setName(e.target.value)} required />
          <Button type="submit" size="sm" disabled={createPat.isPending}>
            Create PAT
          </Button>
        </Stack>
      </Form>
    </Stack>
  );
}

export function SettingsPage() {
  return (
    <div>
      <h3>Settings</h3>
      <Accordion align="start">
        <AccordionItem title="Projects" open>
          <ProjectsSection />
        </AccordionItem>
        <AccordionItem title="Agents">
          <AgentsSection />
        </AccordionItem>
        <AccordionItem title="Task sources">
          <SourcesSection />
        </AccordionItem>
        <AccordionItem title="Secrets (write-only)">
          <SecretsSection />
        </AccordionItem>
        <AccordionItem title="Personal access tokens">
          <PatsSection />
        </AccordionItem>
      </Accordion>
    </div>
  );
}
