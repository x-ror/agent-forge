import {
  Accordion,
  AccordionItem,
  Button,
  CodeSnippet,
  ComboBox,
  Form,
  InlineLoading,
  InlineNotification,
  Modal,
  Select,
  SelectItem,
  Stack,
  StructuredListBody,
  StructuredListCell,
  StructuredListHead,
  StructuredListRow,
  StructuredListWrapper,
  Tab,
  TabList,
  TabPanel,
  TabPanels,
  Tabs,
  Tag,
  TextArea,
  TextInput,
} from '@carbon/react';
import { Edit, TrashCan, View } from '@carbon/icons-react';
import { useState } from 'react';
import type { AgentDto, ProjectDto, RepoAgentDto } from '@agentforge/core';
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
  useDeleteTaskSource,
  usePats,
  useProjects,
  usePutSecret,
  useRepoAgents,
  useRevokePat,
  useSecretKeys,
  useTaskSources,
  useUpdateAgent,
  useUpdateProject,
  useUsageSummary,
} from '../../api/hooks';
import { useAppState } from '../../state/app-state';

/** Prefilled model ids — the ComboBox also accepts any custom value. */
const MODEL_OPTIONS = ['claude-opus-5', 'claude-sonnet-5', 'claude-opus-4-8', 'claude-haiku-4-5'];

function ModelPicker({ id, value, onChange }: { id: string; value: string; onChange: (v: string) => void }) {
  return (
    <ComboBox
      id={id}
      titleText="Model (optional — pick or type a custom id)"
      items={MODEL_OPTIONS}
      allowCustomValue
      selectedItem={value || null}
      onChange={({ selectedItem }) => onChange(selectedItem ?? '')}
      onInputChange={(text) => onChange(text ?? '')}
    />
  );
}

/** claude-code permission levels — stored as --permission-mode in options.extraArgs. */
type PermissionLevel = '' | 'acceptEdits' | 'bypassPermissions';

function permissionLevelOf(optionsJson: string): PermissionLevel {
  try {
    const opts = optionsJson.trim() ? (JSON.parse(optionsJson) as { extraArgs?: unknown }) : {};
    const args = Array.isArray(opts.extraArgs) ? opts.extraArgs.map(String) : [];
    const i = args.indexOf('--permission-mode');
    const mode = i >= 0 ? args[i + 1] : undefined;
    return mode === 'acceptEdits' || mode === 'bypassPermissions' ? mode : '';
  } catch {
    return '';
  }
}

function withPermissionLevel(optionsJson: string, level: PermissionLevel): string {
  let opts: Record<string, unknown> = {};
  try {
    opts = optionsJson.trim() ? (JSON.parse(optionsJson) as Record<string, unknown>) : {};
  } catch {
    opts = {};
  }
  const args = (Array.isArray(opts.extraArgs) ? opts.extraArgs : []).map(String);
  const i = args.indexOf('--permission-mode');
  if (i >= 0) args.splice(i, 2);
  if (level) args.push('--permission-mode', level);
  if (args.length > 0) opts.extraArgs = args;
  else delete opts.extraArgs;
  return Object.keys(opts).length > 0 ? JSON.stringify(opts) : '';
}

function PermissionSelect({ id, optionsJson, onChange }: { id: string; optionsJson: string; onChange: (next: string) => void }) {
  return (
    <Select
      id={id}
      labelText="Permissions (claude-code)"
      helperText="What the agent may do headlessly — human checkpoints stay at workflow gates."
      value={permissionLevelOf(optionsJson)}
      onChange={(e) => onChange(withPermissionLevel(optionsJson, e.target.value as PermissionLevel))}
    >
      <SelectItem value="" text="Read-only — denies all writes (planners, analysts)" />
      <SelectItem value="acceptEdits" text="Edit files — recommended for implementers/fixers" />
      <SelectItem value="bypassPermissions" text="Full autonomy — trusted repos only" />
    </Select>
  );
}

function EditProjectModal({ project, onClose }: { project: ProjectDto; onClose: () => void }) {
  const updateProject = useUpdateProject();
  const [name, setName] = useState(project.name);
  const [repoUrl, setRepoUrl] = useState(project.repoUrl);
  const [defaultBranch, setDefaultBranch] = useState(project.defaultBranch);
  const [executionMode, setExecutionMode] = useState<'sandbox' | 'local'>(project.settings.executionMode === 'local' ? 'local' : 'sandbox');
  const [pushRemote, setPushRemote] = useState(project.settings.pushRemote ?? '');
  return (
    <Modal
      open
      modalHeading={`Edit project “${project.name}”`}
      primaryButtonText="Save"
      secondaryButtonText="Cancel"
      primaryButtonDisabled={!name || !repoUrl || !defaultBranch || updateProject.isPending}
      onRequestClose={onClose}
      onRequestSubmit={() =>
        updateProject.mutate(
          { id: project.id, body: { name, repoUrl, defaultBranch, settings: { ...project.settings, executionMode, pushRemote: pushRemote.trim() || undefined } } },
          { onSuccess: onClose },
        )
      }
    >
      <Stack gap={5}>
        <TextInput id="edit-project-name" labelText="Project name" value={name} onChange={(e) => setName(e.target.value)} />
        <TextInput id="edit-project-repo" labelText="Repository URL" value={repoUrl} onChange={(e) => setRepoUrl(e.target.value)} />
        <TextInput
          id="edit-project-branch"
          labelText="Default branch"
          helperText="Base for flow worktrees and PRs — must exist in the repo (main vs master)."
          value={defaultBranch}
          onChange={(e) => setDefaultBranch(e.target.value)}
        />
        <Select
          id="edit-project-mode"
          labelText="Execution mode"
          helperText="Local trusts this machine: claude uses its stored login and pushes/PRs use your gh CLI — no tokens in secrets. Sandbox keeps runs isolated with secrets only."
          value={executionMode}
          onChange={(e) => setExecutionMode(e.target.value as 'sandbox' | 'local')}
        >
          <SelectItem value="sandbox" text="Sandbox — isolated, credentials from project secrets" />
          <SelectItem value="local" text="Local — trusted: host claude + gh logins" />
        </Select>
        <TextInput
          id="edit-project-push-remote"
          labelText="Push remote (optional)"
          helperText="For non-GitHub repos (e.g. a local GitLab clone): the result branch is also pushed here and the run links to the forge's create-MR page."
          placeholder="git@gitlab.example.com:group/repo.git"
          value={pushRemote}
          onChange={(e) => setPushRemote(e.target.value)}
        />
      </Stack>
    </Modal>
  );
}

function ProjectsSection() {
  const projects = useProjects();
  const createProject = useCreateProject();
  const deleteProject = useDeleteProject();
  const { projectId, setProjectId } = useAppState();
  const [name, setName] = useState('');
  const [repoUrl, setRepoUrl] = useState('');
  const [pendingDelete, setPendingDelete] = useState<{ id: string; name: string } | null>(null);
  const [editing, setEditing] = useState<ProjectDto | null>(null);
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
                  {project.settings.executionMode === 'local' ? (
                    <Tag type="teal" size="sm">
                      local
                    </Tag>
                  ) : null}
                </span>
              </StructuredListCell>
              <StructuredListCell>
                {project.repoUrl} <span className="af-settings__muted">({project.defaultBranch})</span>
              </StructuredListCell>
              <StructuredListCell className="af-cell--nowrap">
                <Button kind="ghost" size="sm" renderIcon={Edit} iconDescription="Edit project" hasIconOnly onClick={() => setEditing(project)} />
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
      {editing && <EditProjectModal project={editing} onClose={() => setEditing(null)} />}
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

function EditAgentModal({ agent, onClose }: { agent: AgentDto; onClose: () => void }) {
  const adapters = useAdapters();
  const updateAgent = useUpdateAgent();
  const [adapter, setAdapter] = useState<string>(agent.adapter);
  const [model, setModel] = useState(typeof agent.config.model === 'string' ? agent.config.model : '');
  const [systemPrompt, setSystemPrompt] = useState(typeof agent.config.systemPrompt === 'string' ? agent.config.systemPrompt : '');
  const [optionsJson, setOptionsJson] = useState(agent.config.options ? JSON.stringify(agent.config.options) : '');
  const [error, setError] = useState<string | null>(null);
  const specialists = Array.isArray(agent.config.specialists) ? (agent.config.specialists as string[]) : [];

  const save = () => {
    setError(null);
    let options: Record<string, unknown> | undefined;
    try {
      options = optionsJson.trim() ? (JSON.parse(optionsJson) as Record<string, unknown>) : undefined;
    } catch {
      setError('Adapter options must be valid JSON');
      return;
    }
    const config: Record<string, unknown> = { ...agent.config };
    if (model.trim()) config.model = model.trim();
    else delete config.model;
    if (systemPrompt.trim()) config.systemPrompt = systemPrompt;
    else delete config.systemPrompt;
    if (options) config.options = options;
    else delete config.options;
    updateAgent.mutate(
      { id: agent.id, body: { adapter: adapter as never, config } },
      { onSuccess: onClose, onError: (e) => setError(e instanceof Error ? e.message : 'Update failed') },
    );
  };

  return (
    <Modal
      open
      size="lg"
      modalHeading={`Edit agent “${agent.name}”`}
      primaryButtonText="Save"
      secondaryButtonText="Cancel"
      primaryButtonDisabled={updateAgent.isPending}
      onRequestClose={onClose}
      onRequestSubmit={save}
    >
      <Stack gap={5}>
        {error && <InlineNotification kind="error" lowContrast title="Could not save" subtitle={error} onClose={() => setError(null)} />}
        <Select id="edit-agent-adapter" labelText="Adapter" value={adapter} onChange={(e) => setAdapter(e.target.value)}>
          {(adapters.data ?? []).map((item) => (
            <SelectItem key={item.id} value={item.id} text={item.id} />
          ))}
        </Select>
        {adapter === 'claude-code' && <PermissionSelect id="edit-agent-permissions" optionsJson={optionsJson} onChange={setOptionsJson} />}
        <ModelPicker id="edit-agent-model" value={model} onChange={setModel} />
        <TextInput id="edit-agent-options" labelText="Adapter options JSON (optional)" value={optionsJson} onChange={(e) => setOptionsJson(e.target.value)} />
        {specialists.length > 0 && <p className="af-settings__tab-desc">Attached specialists: {specialists.join(', ')} — their briefs live inside the system prompt below.</p>}
        <TextArea id="edit-agent-prompt" labelText="System prompt" rows={12} value={systemPrompt} onChange={(e) => setSystemPrompt(e.target.value)} />
      </Stack>
    </Modal>
  );
}

function AgentsSection() {
  const agents = useAgents();
  const adapters = useAdapters();
  const createAgent = useCreateAgent();
  const deleteAgent = useDeleteAgent();
  const [editing, setEditing] = useState<AgentDto | null>(null);
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
              <StructuredListCell className="af-cell--nowrap">
                {agent.adapter}
                {typeof agent.config.model === 'string' ? <span className="af-settings__muted"> · {agent.config.model}</span> : null}
              </StructuredListCell>
              <StructuredListCell>
                <span className="af-settings__tag-row">
                  {typeof agent.config.systemPrompt === 'string' && agent.config.systemPrompt.length > 0 ? (
                    <Tag type="green">has system prompt</Tag>
                  ) : (
                    <Tag type="gray">default prompt</Tag>
                  )}
                  {Array.isArray(agent.config.specialists) && agent.config.specialists.length > 0 ? (
                    <Tag type="purple">
                      {agent.config.specialists.length} specialist{agent.config.specialists.length === 1 ? '' : 's'}
                    </Tag>
                  ) : null}
                </span>
              </StructuredListCell>
              <StructuredListCell className="af-cell--nowrap">
                <Button kind="ghost" size="sm" renderIcon={Edit} iconDescription="Edit agent" hasIconOnly onClick={() => setEditing(agent)} />
                <Button kind="danger--ghost" size="sm" renderIcon={TrashCan} iconDescription="Delete" hasIconOnly onClick={() => deleteAgent.mutate(agent.id)} />
              </StructuredListCell>
            </StructuredListRow>
          ))}
        </StructuredListBody>
      </StructuredListWrapper>
      {editing && <EditAgentModal agent={editing} onClose={() => setEditing(null)} />}
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
              {(repoAgents.data ?? [])
                .filter((a) => a.kind === 'agent')
                .map((a) => (
                  <SelectItem key={`${a.kind}:${a.name}`} value={a.name} text={a.name} />
                ))}
            </Select>
          )}
          <TextInput id="agent-name" labelText="Agent name (referenced by workflows)" value={name} onChange={(e) => setName(e.target.value)} required />
          <Select id="agent-adapter" labelText="Adapter" value={adapter} onChange={(e) => chooseAdapter(e.target.value)}>
            {(adapters.data ?? []).map((item) => (
              <SelectItem key={item.id} value={item.id} text={item.id} />
            ))}
          </Select>
          {adapter === 'claude-code' && <PermissionSelect id="agent-permissions" optionsJson={optionsJson} onChange={setOptionsJson} />}
          <ModelPicker id="agent-model" value={model} onChange={setModel} />
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
  const deleteSource = useDeleteTaskSource();
  const [kind, setKind] = useState('github_issues');
  const [jiraProject, setJiraProject] = useState('');
  const [jiraJql, setJiraJql] = useState('');
  const [filePath, setFilePath] = useState('');
  const [ghLabels, setGhLabels] = useState('');
  if (!projectId) return <p>Select a project first.</p>;

  const buildConfig = (): Record<string, unknown> => {
    if (kind === 'jira') {
      if (jiraJql.trim()) return { jql: jiraJql.trim() };
      if (jiraProject.trim()) return { project: jiraProject.trim() };
      return {};
    }
    if (kind === 'file') return filePath.trim() ? { path: filePath.trim() } : {};
    if (kind === 'github_issues' && ghLabels.trim()) {
      return {
        labels: ghLabels
          .split(',')
          .map((l) => l.trim())
          .filter(Boolean),
      };
    }
    return {};
  };
  return (
    <Stack gap={5}>
      <StructuredListWrapper>
        <StructuredListBody>
          {(sources.data ?? []).map((source) => (
            <StructuredListRow key={source.id}>
              <StructuredListCell>
                {sourceKindLabel(source.kind)}
                {Object.keys(source.config).length > 0 && <span className="af-settings__muted"> · {JSON.stringify(source.config)}</span>}
              </StructuredListCell>
              <StructuredListCell className="af-cell--nowrap">{source.lastSyncedAt ? `synced ${formatDateTime(source.lastSyncedAt)}` : 'never synced'}</StructuredListCell>
              <StructuredListCell className="af-cell--nowrap">
                <Button
                  kind="danger--ghost"
                  size="sm"
                  renderIcon={TrashCan}
                  iconDescription="Delete source"
                  hasIconOnly
                  disabled={deleteSource.isPending}
                  onClick={() => deleteSource.mutate(source.id)}
                />
              </StructuredListCell>
            </StructuredListRow>
          ))}
        </StructuredListBody>
      </StructuredListWrapper>
      <Form
        aria-label="new source"
        onSubmit={(e) => {
          e.preventDefault();
          createSource.mutate({ projectId, kind: kind as never, config: buildConfig() });
        }}
      >
        <Stack gap={4}>
          <Select id="source-kind" labelText="Source kind" value={kind} onChange={(e) => setKind(e.target.value)}>
            <SelectItem value="github_issues" text="GitHub Issues" />
            <SelectItem value="file" text="Tracked file (TASKS.md)" />
            <SelectItem value="jira" text="Jira" />
          </Select>
          {kind === 'jira' && (
            <>
              <p className="af-settings__tab-desc">
                Credentials come from project secrets: <code>JIRA_BASE_URL</code>, <code>JIRA_API_TOKEN</code> (+ <code>JIRA_EMAIL</code> for Jira Cloud). Below only scopes{' '}
                <em>which</em> issues sync.
              </p>
              <TextInput
                id="source-jira-project"
                labelText="Jira project key (optional)"
                helperText="e.g. ABC — syncs the project's open issues"
                value={jiraProject}
                onChange={(e) => setJiraProject(e.target.value)}
              />
              <TextInput
                id="source-jira-jql"
                labelText="JQL (optional — overrides project key)"
                helperText="e.g. assignee = currentUser() AND sprint in openSprints()"
                value={jiraJql}
                onChange={(e) => setJiraJql(e.target.value)}
              />
            </>
          )}
          {kind === 'file' && <TextInput id="source-file-path" labelText="File path (default TASKS.md)" value={filePath} onChange={(e) => setFilePath(e.target.value)} />}
          {kind === 'github_issues' && (
            <TextInput
              id="source-gh-labels"
              labelText="Labels filter (comma-separated, optional)"
              helperText="Sync only issues carrying all of these labels"
              value={ghLabels}
              onChange={(e) => setGhLabels(e.target.value)}
            />
          )}
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

function UsageSection() {
  const { projectId } = useAppState();
  const usage = useUsageSummary(projectId);
  if (!projectId) return <p>Select a project first.</p>;
  if (usage.isLoading) return <InlineLoading description="Loading usage…" />;
  const rows = usage.data?.days ?? [];
  if (rows.length === 0) return <p className="af-empty-state">No agent runs in the last 30 days.</p>;
  const total = rows.reduce(
    (acc, d) => ({ runs: acc.runs + d.runs, tokensIn: acc.tokensIn + d.tokensIn, tokensOut: acc.tokensOut + d.tokensOut, costUsd: acc.costUsd + d.costUsd }),
    {
      runs: 0,
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 0,
    },
  );
  return (
    <StructuredListWrapper>
      <StructuredListHead>
        <StructuredListRow head>
          <StructuredListCell head>Day</StructuredListCell>
          <StructuredListCell head>Runs</StructuredListCell>
          <StructuredListCell head>Tokens in / out</StructuredListCell>
          <StructuredListCell head>Cost</StructuredListCell>
        </StructuredListRow>
      </StructuredListHead>
      <StructuredListBody>
        {rows.map((d) => (
          <StructuredListRow key={d.day}>
            <StructuredListCell className="af-cell--nowrap">{d.day}</StructuredListCell>
            <StructuredListCell>{d.runs}</StructuredListCell>
            <StructuredListCell className="af-cell--nowrap">
              {d.tokensIn.toLocaleString()} / {d.tokensOut.toLocaleString()}
            </StructuredListCell>
            <StructuredListCell className="af-cell--nowrap">${d.costUsd.toFixed(2)}</StructuredListCell>
          </StructuredListRow>
        ))}
        <StructuredListRow>
          <StructuredListCell>
            <strong>Total (30 days)</strong>
          </StructuredListCell>
          <StructuredListCell>
            <strong>{total.runs}</strong>
          </StructuredListCell>
          <StructuredListCell className="af-cell--nowrap">
            <strong>
              {total.tokensIn.toLocaleString()} / {total.tokensOut.toLocaleString()}
            </strong>
          </StructuredListCell>
          <StructuredListCell className="af-cell--nowrap">
            <strong>${total.costUsd.toFixed(2)}</strong>
          </StructuredListCell>
        </StructuredListRow>
      </StructuredListBody>
    </StructuredListWrapper>
  );
}

function RepoAgentsSection() {
  const { projectId } = useAppState();
  const catalog = useRepoAgents(projectId);
  const runtimeAgents = useAgents();
  const adapters = useAdapters();
  const createAgent = useCreateAgent();
  const updateAgent = useUpdateAgent();
  const [selected, setSelected] = useState<RepoAgentDto | null>(null);
  const [viewMode, setViewMode] = useState<'pretty' | 'raw'>('pretty');
  const [importAdapter, setImportAdapter] = useState('claude-code');
  const [attachTo, setAttachTo] = useState('');
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

  // Specialists don't stand alone on the canvas — their brief joins a runtime
  // agent's system prompt, recorded in config.specialists.
  const attachSpecialist = (specialist: RepoAgentDto, agentName: string) => {
    setImportMsg(null);
    setImportErr(null);
    const target = (runtimeAgents.data ?? []).find((a) => a.name === agentName);
    if (!target) {
      setImportErr('Pick a runtime agent to attach to.');
      return;
    }
    const existing = Array.isArray(target.config.specialists) ? (target.config.specialists as string[]) : [];
    if (existing.includes(specialist.name)) {
      setImportErr(`“${specialist.name}” is already attached to ${target.name}.`);
      return;
    }
    const basePrompt = typeof target.config.systemPrompt === 'string' ? target.config.systemPrompt : '';
    updateAgent.mutate(
      {
        id: target.id,
        body: {
          config: {
            ...target.config,
            systemPrompt: `${basePrompt}\n\n---\n\n# Specialist: ${specialist.name}\n\n${specialist.description}`.trim(),
            specialists: [...existing, specialist.name],
          },
        },
      },
      {
        onSuccess: () => setImportMsg(`Attached specialist “${specialist.name}” to ${target.name} — its brief is now part of that agent's system prompt.`),
        onError: (err) => setImportErr(err instanceof Error ? err.message : 'Attach failed'),
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
            {selected.kind === 'specialist' ? (
              <Stack gap={3}>
                <Select
                  id="attach-agent"
                  labelText="Attach to runtime agent"
                  helperText="Specialists don't appear on the canvas — their brief becomes part of an agent's system prompt."
                  value={attachTo}
                  onChange={(e) => setAttachTo(e.target.value)}
                >
                  <SelectItem value="" text="— pick an agent —" />
                  {(runtimeAgents.data ?? []).map((a) => (
                    <SelectItem key={a.id} value={a.name} text={`${a.name} (${a.adapter})`} />
                  ))}
                </Select>
                <Button size="sm" disabled={updateAgent.isPending || !attachTo} onClick={() => attachSpecialist(selected, attachTo)}>
                  Attach specialist
                </Button>
              </Stack>
            ) : (
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
            )}
          </Stack>
        </Modal>
      )}
    </Stack>
  );
}

function PatsSection() {
  const pats = usePats();
  const createPat = useCreatePat();
  const revokePat = useRevokePat();
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
              <StructuredListCell className="af-cell--nowrap">
                {!pat.revokedAt && (
                  <Button kind="danger--ghost" size="sm" disabled={revokePat.isPending} onClick={() => revokePat.mutate(pat.id)}>
                    Revoke
                  </Button>
                )}
              </StructuredListCell>
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
              <AccordionItem title="Usage & cost">
                <UsageSection />
              </AccordionItem>
            </Accordion>
          </TabPanel>
        </TabPanels>
      </Tabs>
    </div>
  );
}
