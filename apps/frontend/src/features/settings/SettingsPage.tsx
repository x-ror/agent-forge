import {
  Accordion,
  AccordionItem,
  Button,
  CodeSnippet,
  Form,
  InlineLoading,
  InlineNotification,
  Modal,
  Select,
  SelectItem,
  Stack,
  StructuredListBody,
  StructuredListCell,
  StructuredListRow,
  StructuredListWrapper,
  Tag,
  TextInput,
} from '@carbon/react';
import { TrashCan, View } from '@carbon/icons-react';
import { useState } from 'react';
import type { RepoAgentDto } from '@agentforge/core';
import { api } from '../../api/client';
import { formatDateTime } from '../../components/format';
import { MarkdownView } from '../../components/MarkdownView';
import {
  useAdapters,
  useAgents,
  useCreateAgent,
  useCreatePat,
  useCreateProject,
  useCreateTaskSource,
  useDeleteAgent,
  usePats,
  useProjects,
  useRepoAgents,
  useTaskSources,
} from '../../api/hooks';
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
  const { projectId } = useAppState();
  const repoAgents = useRepoAgents(projectId);
  const [name, setName] = useState('');
  const [adapter, setAdapter] = useState('api-loop');
  const [model, setModel] = useState('');
  const [optionsJson, setOptionsJson] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [importFrom, setImportFrom] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  const applyRepoImport = (repoName: string) => {
    setImportFrom(repoName);
    if (!repoName) {
      setSystemPrompt('');
      return;
    }
    const repo = (repoAgents.data ?? []).find((a) => a.name === repoName);
    if (!repo) return;
    setName(repo.name);
    setSystemPrompt(repo.description);
    // Decision-style roles need structured output → api-loop; implementers often use claude-code.
    if (repo.kind === 'specialist' || /review|triage|critic|gate|planner/i.test(repo.name)) {
      setAdapter('api-loop');
    } else if ((adapters.data ?? []).some((a) => a.id === 'claude-code')) {
      setAdapter('claude-code');
    }
  };

  return (
    <Stack gap={5}>
      <p>
        Runtime agents are what workflows bind to by <strong>name</strong>. Import a prompt from the project repo registry (below / Repo agents), or register manually.
      </p>
      <StructuredListWrapper>
        <StructuredListBody>
          {(agents.data ?? []).map((agent) => (
            <StructuredListRow key={agent.id}>
              <StructuredListCell>{agent.name}</StructuredListCell>
              <StructuredListCell>{agent.adapter}</StructuredListCell>
              <StructuredListCell>
                {typeof agent.config.systemPrompt === 'string' && agent.config.systemPrompt.length > 0 ? (
                  <Tag type="green">has system prompt</Tag>
                ) : (
                  <Tag type="gray">default prompt</Tag>
                )}
              </StructuredListCell>
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
          setFormError(null);
          let options: Record<string, unknown> | undefined;
          try {
            options = optionsJson ? (JSON.parse(optionsJson) as Record<string, unknown>) : undefined;
          } catch {
            setFormError('Adapter options must be valid JSON');
            return;
          }
          createAgent.mutate(
            {
              name,
              adapter: adapter as never,
              config: {
                ...(model ? { model } : {}),
                ...(systemPrompt.trim() ? { systemPrompt: systemPrompt.trim() } : {}),
                ...(importFrom ? { source: 'repo-registry', repoAgent: importFrom } : {}),
                ...(options ? { options } : {}),
              },
            },
            {
              onSuccess: () => {
                setName('');
                setSystemPrompt('');
                setImportFrom('');
                setOptionsJson('');
              },
              onError: (err) => setFormError(err instanceof Error ? err.message : 'Failed to register agent'),
            },
          );
        }}
      >
        <Stack gap={4}>
          {formError && <InlineNotification kind="error" lowContrast title="Could not register" subtitle={formError} onClose={() => setFormError(null)} />}
          {projectId && (
            <Select
              id="agent-import-repo"
              labelText="Import from repo registry (optional)"
              helperText="Prefills name + full system prompt from config/agents.json"
              value={importFrom}
              onChange={(e) => applyRepoImport(e.target.value)}
            >
              <SelectItem value="" text="— none —" />
              {(repoAgents.data ?? []).map((a) => (
                <SelectItem key={`${a.kind}:${a.name}`} value={a.name} text={`${a.name} (${a.kind})`} />
              ))}
            </Select>
          )}
          <TextInput id="agent-name" labelText="Agent name (referenced by workflows)" value={name} onChange={(e) => setName(e.target.value)} required />
          <Select id="agent-adapter" labelText="Adapter" value={adapter} onChange={(e) => setAdapter(e.target.value)}>
            {(adapters.data ?? []).map((item) => (
              <SelectItem key={item.id} value={item.id} text={item.id} />
            ))}
          </Select>
          <TextInput id="agent-model" labelText="Model (optional)" value={model} onChange={(e) => setModel(e.target.value)} />
          <TextInput
            id="agent-options"
            labelText='Adapter options JSON (optional, e.g. {"extraArgs":["--permission-mode","acceptEdits"]})'
            value={optionsJson}
            onChange={(e) => setOptionsJson(e.target.value)}
          />
          {systemPrompt ? (
            <p className="af-repo-agent__role">
              System prompt loaded ({systemPrompt.length.toLocaleString()} chars)
              {importFrom ? ` from repo agent “${importFrom}”` : ''}.
            </p>
          ) : null}
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

function RepoAgentsSection() {
  const { projectId } = useAppState();
  const catalog = useRepoAgents(projectId);
  const runtimeAgents = useAgents();
  const adapters = useAdapters();
  const createAgent = useCreateAgent();
  const [selected, setSelected] = useState<RepoAgentDto | null>(null);
  const [viewMode, setViewMode] = useState<'pretty' | 'raw'>('pretty');
  const [importAdapter, setImportAdapter] = useState('claude-code');
  const [importMsg, setImportMsg] = useState<string | null>(null);
  const [importErr, setImportErr] = useState<string | null>(null);

  if (!projectId) return <p>Select a project first.</p>;
  if (catalog.isLoading) return <InlineLoading description="Loading repo agents…" />;
  if (catalog.isError) {
    return (
      <InlineNotification
        kind="error"
        lowContrast
        title="Could not load repo agents"
        subtitle={catalog.error instanceof Error ? catalog.error.message : 'Check that the project has config/agents.json on its default branch.'}
        hideCloseButton
      />
    );
  }
  const agents = catalog.data ?? [];
  if (agents.length === 0) {
    return (
      <p className="af-empty-state">
        No agents in <code>config/agents.json</code> on this project&apos;s default branch.
      </p>
    );
  }

  const registeredNames = new Set((runtimeAgents.data ?? []).map((a) => a.name));

  const importAsRuntime = (agent: RepoAgentDto, adapterId: string) => {
    setImportMsg(null);
    setImportErr(null);
    if (registeredNames.has(agent.name)) {
      setImportErr(`Runtime agent “${agent.name}” already exists — delete it first or register under a different name in Agents.`);
      return;
    }
    createAgent.mutate(
      {
        name: agent.name,
        adapter: adapterId as never,
        config: {
          systemPrompt: agent.description,
          source: 'repo-registry',
          repoAgent: agent.name,
          role: agent.role,
          ...(adapterId === 'claude-code' ? { options: { extraArgs: ['--permission-mode', 'acceptEdits'] } } : {}),
        },
      },
      {
        onSuccess: () => setImportMsg(`Registered “${agent.name}” (${adapterId}). Pick it by name on the workflow canvas.`),
        onError: (err) => setImportErr(err instanceof Error ? err.message : 'Import failed'),
      },
    );
  };

  return (
    <Stack gap={5}>
      <p>
        Read-only catalog from the repository. <strong>Import as runtime agent</strong> to use a name on the workflow canvas; the full markdown prompt becomes the agent&apos;s
        system prompt.
      </p>
      {importMsg && <InlineNotification kind="success" lowContrast title="Imported" subtitle={importMsg} onClose={() => setImportMsg(null)} />}
      {importErr && <InlineNotification kind="error" lowContrast title="Import failed" subtitle={importErr} onClose={() => setImportErr(null)} />}
      <StructuredListWrapper>
        <StructuredListBody>
          {agents.map((agent) => (
            <StructuredListRow key={`${agent.kind}:${agent.name}`}>
              <StructuredListCell>
                <strong>{agent.name}</strong>
                <div className="af-repo-agent__role">{agent.role}</div>
              </StructuredListCell>
              <StructuredListCell>
                <Tag type={agent.kind === 'agent' ? 'blue' : 'purple'}>{agent.kind}</Tag>
                {registeredNames.has(agent.name) ? <Tag type="green">registered</Tag> : null}
              </StructuredListCell>
              <StructuredListCell className="af-cell--nowrap">{agent.provider ?? '—'}</StructuredListCell>
              <StructuredListCell>
                <Button
                  kind="ghost"
                  size="sm"
                  renderIcon={View}
                  onClick={() => {
                    setViewMode('pretty');
                    setImportAdapter(agent.kind === 'specialist' || /review|triage|critic|gate|planner/i.test(agent.name) ? 'api-loop' : 'claude-code');
                    setSelected(agent);
                  }}
                >
                  Show / import
                </Button>
              </StructuredListCell>
            </StructuredListRow>
          ))}
        </StructuredListBody>
      </StructuredListWrapper>
      {selected && (
        <Modal open size="lg" modalHeading={`${selected.name} — full description`} passiveModal onRequestClose={() => setSelected(null)}>
          <Stack gap={4}>
            <p>
              <Tag type={selected.kind === 'agent' ? 'blue' : 'purple'}>{selected.kind}</Tag> {selected.role}
              {selected.promptPath ? (
                <>
                  {' '}
                  · <code>{selected.promptPath}</code>
                </>
              ) : null}
            </p>
            {selected.tools && selected.tools.length > 0 && <p>Tools: {selected.tools.join(', ')}</p>}
            <div className="af-repo-agent__view-toggle">
              <Button kind={viewMode === 'pretty' ? 'primary' : 'tertiary'} size="sm" onClick={() => setViewMode('pretty')}>
                Pretty
              </Button>
              <Button kind={viewMode === 'raw' ? 'primary' : 'tertiary'} size="sm" onClick={() => setViewMode('raw')}>
                Raw
              </Button>
            </div>
            {viewMode === 'pretty' ? <MarkdownView source={selected.description} /> : <pre className="af-md-raw">{selected.description}</pre>}
            <Stack gap={3}>
              <Select id="import-adapter" labelText="Runtime adapter for import" value={importAdapter} onChange={(e) => setImportAdapter(e.target.value)}>
                {(adapters.data ?? []).map((item) => (
                  <SelectItem key={item.id} value={item.id} text={item.id} />
                ))}
              </Select>
              <Button size="sm" disabled={createAgent.isPending || registeredNames.has(selected.name)} onClick={() => importAsRuntime(selected, importAdapter)}>
                {registeredNames.has(selected.name) ? 'Already registered' : 'Import as runtime agent'}
              </Button>
            </Stack>
          </Stack>
        </Modal>
      )}
    </Stack>
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
        <AccordionItem title="Repo agents (from project registry)">
          <RepoAgentsSection />
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
