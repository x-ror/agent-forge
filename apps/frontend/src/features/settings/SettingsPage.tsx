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
  Tab,
  TabList,
  TabPanel,
  TabPanels,
  Tabs,
  Tag,
  TextInput,
} from '@carbon/react';
import { TrashCan, View } from '@carbon/icons-react';
import { useState } from 'react';
import type { RepoAgentDto } from '@agentforge/core';
import { formatDateTime, sourceKindLabel } from '../../components/format';
import { MarkdownView } from '../../components/MarkdownView';
import {
  useAdapters,
  useAgents,
  useCreateAgent,
  useCreatePat,
  useCreateProject,
  useCreateTaskSource,
  useDeleteAgent,
  useDeleteProject,
  useDeleteSecret,
  usePats,
  useProjects,
  usePutSecret,
  useRepoAgents,
  useSecretKeys,
  useTaskSources,
} from '../../api/hooks';
import { useAppState } from '../../state/app-state';

function ProjectsSection() {
  const projects = useProjects();
  const createProject = useCreateProject();
  const deleteProject = useDeleteProject();
  const { projectId, setProjectId } = useAppState();
  const [name, setName] = useState('');
  const [repoUrl, setRepoUrl] = useState('');
  const [pendingDelete, setPendingDelete] = useState<{ id: string; name: string } | null>(null);
  return (
    <Stack gap={5}>
      <StructuredListWrapper>
        <StructuredListBody>
          {(projects.data ?? []).map((project) => (
            <StructuredListRow key={project.id}>
              <StructuredListCell>
                <span className="af-settings__name-with-tag">
                  <span className="af-settings__entity-name">{project.name}</span>
                  {project.id === projectId ? (
                    <Tag type="blue" size="sm">
                      selected
                    </Tag>
                  ) : null}
                </span>
              </StructuredListCell>
              <StructuredListCell>{project.repoUrl}</StructuredListCell>
              <StructuredListCell>
                <Button
                  kind="danger--ghost"
                  size="sm"
                  renderIcon={TrashCan}
                  iconDescription="Delete project"
                  hasIconOnly
                  disabled={deleteProject.isPending}
                  onClick={() => setPendingDelete({ id: project.id, name: project.name })}
                />
              </StructuredListCell>
            </StructuredListRow>
          ))}
        </StructuredListBody>
      </StructuredListWrapper>
      {pendingDelete && (
        <Modal
          open
          danger
          modalHeading={`Delete project “${pendingDelete.name}”?`}
          primaryButtonText="Delete"
          secondaryButtonText="Cancel"
          primaryButtonDisabled={deleteProject.isPending}
          onRequestClose={() => setPendingDelete(null)}
          onRequestSubmit={() => {
            const id = pendingDelete.id;
            deleteProject.mutate(id, {
              onSuccess: () => {
                if (projectId === id) setProjectId(null);
                setPendingDelete(null);
              },
            });
          }}
        >
          <p>
            This removes the project record and its secrets/task sources from the database. Workflows and tasks that reference it may fail or be cascade-deleted depending on
            schema. Mirrors on disk are not cleaned automatically.
          </p>
        </Modal>
      )}
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

  // Headless claude-code denies every Edit/write-Bash without this — a run
  // that can only read is the trap, so prefill (visibly, still editable).
  const CLAUDE_CODE_DEFAULT_OPTIONS = JSON.stringify({ extraArgs: ['--permission-mode', 'acceptEdits'] });

  const chooseAdapter = (adapterId: string) => {
    setAdapter(adapterId);
    if (adapterId === 'claude-code' && !optionsJson.trim()) {
      setOptionsJson(CLAUDE_CODE_DEFAULT_OPTIONS);
    } else if (adapterId !== 'claude-code' && optionsJson === CLAUDE_CODE_DEFAULT_OPTIONS) {
      setOptionsJson('');
    }
  };

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
      chooseAdapter('api-loop');
    } else if ((adapters.data ?? []).some((a) => a.id === 'claude-code')) {
      chooseAdapter('claude-code');
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
          <Select id="agent-adapter" labelText="Adapter" value={adapter} onChange={(e) => chooseAdapter(e.target.value)}>
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
              <StructuredListCell>{sourceKindLabel(source.kind)}</StructuredListCell>
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
  const secretKeys = useSecretKeys(projectId);
  const putSecret = usePutSecret(projectId);
  const deleteSecret = useDeleteSecret(projectId);
  const [key, setKey] = useState('');
  const [value, setValue] = useState('');
  const [saved, setSaved] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  if (!projectId) return <p>Select a project first.</p>;
  const keys = secretKeys.data?.keys ?? [];
  return (
    <Stack gap={5}>
      <p className="af-settings__tab-desc">Values are write-only: they are passed to agent runs but can never be read back here. Storing an existing key overwrites it.</p>
      {secretKeys.isLoading ? (
        <InlineLoading description="Loading secrets…" />
      ) : keys.length === 0 ? (
        <p className="af-empty-state">No secrets stored for this project.</p>
      ) : (
        <StructuredListWrapper>
          <StructuredListBody>
            {keys.map((k) => (
              <StructuredListRow key={k}>
                <StructuredListCell>
                  <code>{k}</code>
                </StructuredListCell>
                <StructuredListCell>••••••••</StructuredListCell>
                <StructuredListCell>
                  <Button
                    kind="danger--ghost"
                    size="sm"
                    renderIcon={TrashCan}
                    iconDescription={`Delete ${k}`}
                    hasIconOnly
                    disabled={deleteSecret.isPending}
                    onClick={() => setPendingDelete(k)}
                  />
                </StructuredListCell>
              </StructuredListRow>
            ))}
          </StructuredListBody>
        </StructuredListWrapper>
      )}
      {pendingDelete && (
        <Modal
          open
          danger
          modalHeading={`Delete secret ${pendingDelete}?`}
          primaryButtonText="Delete"
          secondaryButtonText="Cancel"
          primaryButtonDisabled={deleteSecret.isPending}
          onRequestClose={() => setPendingDelete(null)}
          onRequestSubmit={() => {
            deleteSecret.mutate(pendingDelete, { onSuccess: () => setPendingDelete(null) });
          }}
        >
          <p>Agent runs on this project will no longer receive {pendingDelete} in their environment.</p>
        </Modal>
      )}
      <Form
        aria-label="put secret"
        onSubmit={(e) => {
          e.preventDefault();
          const storedKey = key;
          putSecret.mutate(
            { key, value },
            {
              onSuccess: () => {
                setSaved(storedKey);
                setKey('');
                setValue('');
              },
            },
          );
        }}
      >
        <Stack gap={4}>
          {saved && <InlineNotification kind="success" lowContrast title={`Secret ${saved} stored`} subtitle="Values are write-only." onClose={() => setSaved(null)} />}
          <TextInput id="secret-key" labelText="Key (UPPER_SNAKE_CASE, e.g. GITHUB_TOKEN)" value={key} onChange={(e) => setKey(e.target.value)} required />
          <TextInput id="secret-value" labelText="Value" type="password" value={value} onChange={(e) => setValue(e.target.value)} required />
          <Button type="submit" size="sm" disabled={putSecret.isPending}>
            Store secret
          </Button>
        </Stack>
      </Form>
    </Stack>
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
                <span className="af-settings__tag-row">
                  <Tag type={agent.kind === 'agent' ? 'blue' : 'purple'} size="sm">
                    {agent.kind}
                  </Tag>
                  {registeredNames.has(agent.name) ? (
                    <Tag type="green" size="sm">
                      registered
                    </Tag>
                  ) : null}
                </span>
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
  const { projectId } = useAppState();
  const projects = useProjects();
  const selectedName = (projects.data ?? []).find((p) => p.id === projectId)?.name;

  return (
    <div className="af-settings">
      <h3 className="af-settings__page-title">Settings</h3>
      <p className="af-settings__lede">
        <strong>Account</strong> is global for your user. <strong>Project</strong> applies only to the project selected in the header
        {selectedName ? (
          <>
            {' '}
            (<strong>{selectedName}</strong>)
          </>
        ) : null}
        .
      </p>

      <Tabs>
        <TabList aria-label="Settings scope">
          <Tab>Account (global)</Tab>
          <Tab>Project{selectedName ? `: ${selectedName}` : ''}</Tab>
        </TabList>
        <TabPanels>
          <TabPanel>
            <p className="af-settings__tab-desc">Shared across all projects: project list, runtime agents, and PATs.</p>
            <Accordion align="start">
              <AccordionItem title="Projects" open>
                <ProjectsSection />
              </AccordionItem>
              <AccordionItem title="Runtime agents">
                <AgentsSection />
              </AccordionItem>
              <AccordionItem title="Personal access tokens">
                <PatsSection />
              </AccordionItem>
            </Accordion>
          </TabPanel>
          <TabPanel>
            <p className="af-settings__tab-desc">Secrets, task sources, and the in-repo agent catalog for the currently selected project.</p>
            {!projectId ? (
              <InlineNotification
                kind="info"
                lowContrast
                hideCloseButton
                title="Select a project"
                subtitle="Use the project picker in the top bar, or create one under Account → Projects."
              />
            ) : null}
            <Accordion align="start">
              <AccordionItem title="Secrets" open={!!projectId}>
                <SecretsSection />
              </AccordionItem>
              <AccordionItem title="Task sources">
                <SourcesSection />
              </AccordionItem>
              <AccordionItem title="Repo agents (from registry)">
                <RepoAgentsSection />
              </AccordionItem>
            </Accordion>
          </TabPanel>
        </TabPanels>
      </Tabs>
    </div>
  );
}
