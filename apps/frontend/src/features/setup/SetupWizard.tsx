import { Button, Column, Form, Grid, InlineNotification, ProgressIndicator, ProgressStep, Stack, TextInput, Tile } from '@carbon/react';
import { useState } from 'react';
import { canonicalWorkflowTemplate, gatedWorkflowTemplate } from '@agentforge/core';
import { api } from '../../api/client';
import { useAppState } from '../../state/app-state';

const DEFAULT_AGENTS = ['Implementer', 'Review Triage', 'Reviewer'];

/** First-boot wizard (§11.1): account → project → agents → workflow templates. */
export function SetupWizard({ onDone }: { onDone: () => void }) {
  const { setProjectId } = useAppState();
  const [step, setStep] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [projectName, setProjectName] = useState('my-project');
  const [repoUrl, setRepoUrl] = useState('');
  const [model, setModel] = useState('claude-sonnet-5');
  const [apiKey, setApiKey] = useState('');
  const [projectId, setLocalProjectId] = useState<string | null>(null);

  async function guarded(fn: () => Promise<void>): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Grid className="af-login">
      <Column sm={4} md={6} lg={{ span: 8, offset: 4 }}>
        <Tile className="af-login__tile">
          <Stack gap={6}>
            <h2>Welcome to AgentForge</h2>
            <ProgressIndicator currentIndex={step} spaceEqually>
              <ProgressStep label="Account" />
              <ProgressStep label="Project" />
              <ProgressStep label="Agents" />
              <ProgressStep label="Workflows" />
            </ProgressIndicator>
            {error && <InlineNotification kind="error" lowContrast title="Step failed" subtitle={error} onClose={() => setError(null)} />}

            {step === 0 && (
              <Form
                aria-label="setup account"
                onSubmit={(e) => {
                  e.preventDefault();
                  void guarded(async () => {
                    await api.post('/auth/register', { email, password });
                    setStep(1);
                  });
                }}
              >
                <Stack gap={4}>
                  <p>Create the first (admin) account. Everything stays on this machine.</p>
                  <TextInput id="setup-email" labelText="Email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
                  <TextInput id="setup-password" labelText="Password (min 8 chars)" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
                  <Button type="submit" disabled={busy}>
                    Create account
                  </Button>
                </Stack>
              </Form>
            )}

            {step === 1 && (
              <Form
                aria-label="setup project"
                onSubmit={(e) => {
                  e.preventDefault();
                  void guarded(async () => {
                    const project = await api.post<{ id: string }>('/projects', {
                      name: projectName,
                      repoUrl,
                      settings: {},
                    });
                    setLocalProjectId(project.id);
                    setProjectId(project.id);
                    setStep(2);
                  });
                }}
              >
                <Stack gap={4}>
                  <p>Connect a repository (https, ssh, or a local file:// path).</p>
                  <TextInput id="setup-project-name" labelText="Project name" value={projectName} onChange={(e) => setProjectName(e.target.value)} required />
                  <TextInput id="setup-repo" labelText="Repository URL" value={repoUrl} onChange={(e) => setRepoUrl(e.target.value)} required />
                  <Button type="submit" disabled={busy}>
                    Create project
                  </Button>
                </Stack>
              </Form>
            )}

            {step === 2 && (
              <Form
                aria-label="setup agents"
                onSubmit={(e) => {
                  e.preventDefault();
                  void guarded(async () => {
                    for (const name of DEFAULT_AGENTS) {
                      await api.post('/agents', { name, adapter: 'api-loop', config: { model } });
                    }
                    if (apiKey && projectId) {
                      await api.put(`/projects/${projectId}/secrets/ANTHROPIC_API_KEY`, { value: apiKey });
                    }
                    setStep(3);
                  });
                }}
              >
                <Stack gap={4}>
                  <p>Registers Implementer, Review Triage and Reviewer on the built-in api-loop adapter.</p>
                  <TextInput id="setup-model" labelText="Model" value={model} onChange={(e) => setModel(e.target.value)} />
                  <TextInput
                    id="setup-key"
                    labelText="Anthropic API key (stored encrypted, write-only)"
                    type="password"
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                  />
                  <Button type="submit" disabled={busy}>
                    Register agents
                  </Button>
                </Stack>
              </Form>
            )}

            {step === 3 && (
              <Stack gap={4}>
                <p>Seed the workflow templates — you can edit them on the canvas any time.</p>
                <Button
                  disabled={busy}
                  onClick={() =>
                    void guarded(async () => {
                      for (const template of [canonicalWorkflowTemplate, gatedWorkflowTemplate()]) {
                        await api.post('/workflows', {
                          projectId,
                          name: template.name,
                          definition: template.definition,
                        });
                      }
                      onDone();
                    })
                  }
                >
                  Seed templates & finish
                </Button>
                <Button kind="ghost" disabled={busy} onClick={onDone}>
                  Skip templates
                </Button>
              </Stack>
            )}
          </Stack>
        </Tile>
      </Column>
    </Grid>
  );
}
