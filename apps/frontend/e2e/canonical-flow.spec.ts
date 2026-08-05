import { expect, test } from '@playwright/test';

/**
 * Phase 9 DoD: the canonical flow, fully driven from the UI —
 * register → project → agents → secret → file task source → sync → canvas
 * (gated template) → start flow → triage decision with reasoning → gate
 * approval → diff → PR branch → task done.
 */

const LLM = () => process.env.AGENTFORGE_E2E_LLM_URL!;
const REPO = () => process.env.AGENTFORGE_E2E_REPO_URL!;

async function pushTurn(blocks: unknown[]): Promise<void> {
  const res = await fetch(`${LLM()}/__push`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ blocks }),
  });
  if (res.status !== 204) throw new Error(`push failed: ${res.status}`);
}

test('canonical flow is fully drivable from the UI', async ({ page, request }) => {
  // ---- register ------------------------------------------------------------
  // Seed a first user via the API so the app deterministically shows the
  // login page — a fresh DB shows the first-boot wizard instead (the wizard
  // path is covered by the production-compose smoke journey, not this spec).
  // NB: the isolated `request` fixture, NOT page.request — page.request shares
  // the page's cookie jar and would leave the browser logged in as the seed.
  await request.post('/api/v1/auth/register', { data: { email: 'seed@agentforge.local', password: 'seed-password-1' } });
  await page.goto('/');
  await page.getByText('Create a new account').click();
  await page.getByLabel('Email').fill('e2e@agentforge.local');
  await page.getByLabel('Password').fill('password-123');
  await page.getByRole('button', { name: 'Register' }).click();
  await expect(page.getByText('Task Board', { exact: true }).first()).toBeVisible();

  // ---- project -------------------------------------------------------------
  await page.getByRole('link', { name: 'Settings' }).click();
  await page.getByLabel('Project name').fill('e2e-project');
  await page.getByLabel(/Repository URL/).fill(REPO());
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(page.getByText(REPO())).toBeVisible();

  // ---- agents (api-loop against the mock LLM) ------------------------------
  await page.getByRole('button', { name: 'Agents' }).click();
  const options = JSON.stringify({ provider: 'anthropic', baseUrl: LLM() });
  for (const name of ['Implementer', 'Review Triage', 'Reviewer']) {
    await page.getByLabel('Agent name (referenced by workflows)').fill(name);
    await page.getByLabel(/Adapter options JSON/).fill(options);
    await page.getByRole('button', { name: 'Register agent' }).click();
    await expect(page.getByText(name, { exact: true })).toBeVisible();
  }

  // ---- provider secret -----------------------------------------------------
  // Secrets live on the Project tab; the accordion is auto-expanded once a
  // project is selected, so don't click its header (that would collapse it).
  await page.getByRole('tab', { name: /^Project/ }).click();
  await page.getByLabel(/^Key/).fill('ANTHROPIC_API_KEY');
  await page.getByLabel('Value').fill('sk-e2e-mock');
  await page.getByRole('button', { name: 'Store secret' }).click();
  await expect(page.getByText('Secret ANTHROPIC_API_KEY stored')).toBeVisible();

  // ---- task source: tracked file in the repo -------------------------------
  await page.getByRole('button', { name: 'Task sources' }).click();
  await page.getByLabel('Source kind').selectOption('file');
  await page.getByRole('button', { name: 'Add source' }).click();
  await expect(page.getByText('never synced')).toBeVisible();

  // ---- sync the board ------------------------------------------------------
  await page.getByRole('link', { name: 'Task Board' }).click();
  await page.getByRole('button', { name: 'Sync tracked file' }).click();
  await expect(page.getByText('Add greeting feature')).toBeVisible({ timeout: 30_000 });

  // ---- build the workflow on the canvas ------------------------------------
  await page.getByRole('link', { name: 'Workflows' }).click();
  await page.getByRole('button', { name: 'New workflow' }).click();
  await page.getByTestId('load-gated-template').click();
  await expect(page.getByTestId('canvas-node-triage')).toBeVisible();
  await expect(page.getByTestId('canvas-node-gate')).toBeVisible();
  await page.getByTestId('save-workflow').click();
  await expect(page.getByText('Implement → Review → Gate → PR')).toBeVisible();

  // ---- script the agents, then start the flow ------------------------------
  await pushTurn([
    { type: 'text', text: 'implementing the greeting' },
    { type: 'tool_use', id: 't1', name: 'write_file', input: { path: 'greeting.txt', content: 'hello from the e2e agent\n' } },
  ]);
  await pushTurn([{ type: 'text', text: 'implemented the greeting feature' }]);
  await pushTurn([{ type: 'tool_use', id: 'd1', name: 'decide', input: { route: 'deep', reasoning: 'new file touches user-facing text — deep review' } }]);
  await pushTurn([{ type: 'text', text: 'deep review complete, changes look good' }]);

  await page.getByRole('link', { name: 'Task Board' }).click();
  await page.getByRole('button', { name: 'Start workflow' }).click();
  await page.getByText('Choose a workflow').click();
  await page.getByText('Implement → Review → Gate → PR (v1)').click();
  await page.getByRole('button', { name: 'Start', exact: true }).click();

  // ---- watch the timeline --------------------------------------------------
  await expect(page.getByTestId('step-implement')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('step-triage')).toBeVisible({ timeout: 30_000 });
  // Decision with visible reasoning (route badge on the timeline title).
  await expect(page.getByText('route: deep')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('step-triage').click(); // expand the step
  await page.getByRole('button', { name: 'Why?' }).click();
  await expect(page.getByTestId('decision-reasoning')).toContainText('deep review');
  // The taken route runs; the other never appears.
  await expect(page.getByTestId('step-deep')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('step-light')).toHaveCount(0);

  // ---- approve the gate ----------------------------------------------------
  await expect(page.getByTestId('open-gate')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('open-gate').click();
  await page.getByLabel('Note (stored as reasoning)').fill('ship it');
  await page.getByRole('button', { name: 'Approve' }).click();

  // ---- flow succeeds; PR branch recorded -----------------------------------
  await expect(page.locator('.af-page__header [data-status="succeeded"]')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('step-pr')).toBeVisible();
  await expect(page.getByTestId('pr-branch')).toContainText('agentforge/');

  // ---- see the diff --------------------------------------------------------
  await page.getByRole('tab', { name: 'Diff' }).click();
  await expect(page.getByText('greeting.txt').first()).toBeVisible({ timeout: 15_000 });

  // ---- task followed the flow to done --------------------------------------
  await page.getByRole('link', { name: 'Task Board' }).click();
  await expect(page.locator('[data-status="done"]')).toBeVisible({ timeout: 15_000 });
});
