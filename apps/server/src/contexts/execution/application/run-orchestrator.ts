import path from 'node:path';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { agentEventSchema, type AgentAdapter, type AgentHandle, type AgentEvent, type Json, type RunContext } from '@agentforge/core';
import { APP_ENV, type AppEnv } from '../../../config/env';
import { EventTypes, type IntegrationEvent } from '../../../shared/outbox/integration-event';
import { AdapterRegistry } from '../../agent-registry/application/adapter-registry';
import { ScmService } from '../../scm/application/scm.service';
import { AGENT_REPOSITORY, type AgentRepository } from '../../agent-registry/domain/agent';
import { PROJECT_REPOSITORY, type ProjectRepository } from '../../projects/domain/repositories';
import { SecretProvisioningService } from '../../projects/application/projects.service';
import { Run } from '../domain/run';
import { RUN_INPUT_REPOSITORY, RUN_REPOSITORY, type RunInputRepository, type RunRepository } from '../domain/repositories';
import { SANDBOX_DRIVER, type Sandbox, type SandboxDriver } from '../domain/sandbox';
import { RUN_TX, type RunTxPort } from '../domain/ports';

const LEASE_STALE_MS = 90_000;
const HEARTBEAT_MS = 15_000;
const INPUT_POLL_MS = 700;
const DEFAULT_RUN_TIMEOUT_MS = 2 * 3600_000;

function runStructured(run: Run): { routes: string[] } | undefined {
  const value = run.structured;
  if (value !== null && typeof value === 'object' && 'routes' in value && Array.isArray((value as { routes: unknown }).routes)) {
    return { routes: (value as { routes: unknown[] }).routes.map(String) };
  }
  return undefined;
}

interface PumpOutcome {
  cancelled: boolean;
  fatalError: string | null;
  result: { outcome: 'success' | 'failure'; summary: string; structured?: Json } | null;
}

/**
 * Owns one run end-to-end inside a single run.execute job (§5.2): sandbox
 * provisioning, adapter lifecycle, normalized event ingestion, steering
 * inputs, lease heartbeat, terminal transition. Progress checkpoints to
 * Postgres continuously, so recovery is resume-shaped.
 */
@Injectable()
export class RunOrchestrator {
  private readonly logger = new Logger(RunOrchestrator.name);

  constructor(
    @Inject(RUN_REPOSITORY) private readonly runs: RunRepository,
    @Inject(RUN_INPUT_REPOSITORY) private readonly inputs: RunInputRepository,
    @Inject(AGENT_REPOSITORY) private readonly agents: AgentRepository,
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepository,
    @Inject(SANDBOX_DRIVER) private readonly sandboxDriver: SandboxDriver,
    @Inject(APP_ENV) private readonly env: AppEnv,
    private readonly registry: AdapterRegistry,
    private readonly secrets: SecretProvisioningService,
    private readonly scm: ScmService,
    @Inject(RUN_TX) private readonly tx: RunTxPort,
  ) {}

  async execute(runId: string): Promise<void> {
    const run = await this.runs.findById(runId);
    if (!run || run.isTerminal) return;

    if (run.status === 'queued') {
      await this.runFresh(run);
      return;
    }
    await this.recover(run);
  }

  private async runFresh(run: Run): Promise<void> {
    run.startProvisioning();
    await this.tx.saveRunAndEvents(run, [{ type: 'orchestrator.status', payload: { status: 'provisioning' } }]);
    await this.provisionAndPump(run, (adapter, ctx) => adapter.start(ctx));
  }

  /** §5.4: invoked by reconciliation for active runs with a stale lease. */
  private async recover(run: Run): Promise<void> {
    if (run.leaseAt && Date.now() - run.leaseAt.getTime() < LEASE_STALE_MS) {
      return; // another live worker owns it
    }
    const agent = await this.agents.findById(run.agentId);
    const adapter = agent ? this.registry.get(agent.adapter) : undefined;

    if (adapter?.capabilities.resume && adapter.resume && run.resumeState !== null) {
      await this.tx.saveRunAndEvents(run, [{ type: 'orchestrator.resumed', payload: { reason: 'stale_lease' } }]);
      await this.provisionAndPump(run, (a, ctx) => a.resume!(ctx, { data: run.resumeState! }), {
        resuming: true,
      });
      return;
    }

    // Honest failure: no resume path — preserve worktree + history (§5.4).
    const flowRunId = await this.tx.flowRunIdFor(run.id);
    run.fail('recovered after worker crash (adapter cannot resume)');
    await this.tx.saveRunAndEvents(run, [{ type: 'orchestrator.crash_recovered', payload: { resumable: false } }], [this.terminalEvent(run, EventTypes.RunFailed, flowRunId)]);
  }

  private async provisionAndPump(run: Run, begin: (adapter: AgentAdapter, ctx: RunContext) => Promise<AgentHandle>, opts: { resuming?: boolean } = {}): Promise<void> {
    let sandbox: Sandbox | undefined;
    try {
      const agent = await this.agents.findById(run.agentId);
      if (!agent) throw new Error(`agent ${run.agentId} not found`);
      const adapter = this.registry.get(agent.adapter);
      if (!adapter) throw new Error(`adapter '${agent.adapter}' is not installed`);
      const project = await this.projects.findById(run.projectId);
      if (!project) throw new Error(`project ${run.projectId} not found`);

      let workdir = run.workspacePath;
      if (!workdir) {
        try {
          // Standalone runs get a throwaway worktree of their own (§8).
          const worktree = await this.scm.createWorktree(project, {
            kind: 'run',
            id: run.id,
            name: `run-${run.id.slice(-12)}`,
            baseRef: run.baseRef,
          });
          workdir = worktree.path;
          run.setBranch(worktree.branch);
        } catch (error) {
          // No usable git remote: degrade to a plain directory, visibly.
          workdir = path.join(this.env.WORKSPACES_DIR, 'runs', run.id);
          await this.tx.saveRunAndEvents(run, [
            {
              type: 'orchestrator.status',
              payload: {
                status: 'provisioning',
                note: `no git worktree (${String(error).slice(0, 300)}); using plain directory`,
              },
            },
          ]);
        }
        run.setWorkspacePath(workdir);
      }

      const env = await this.secrets.decryptedEnv(run.projectId);
      sandbox = await this.sandboxDriver.create({
        runId: run.id,
        workdir,
        env,
        image: project.settings.sandboxImage,
        networkPolicy: project.settings.networkPolicy ?? this.env.SANDBOX_NETWORK_DEFAULT,
      });

      const ctx: RunContext = {
        runId: run.id,
        prompt: run.taskPrompt,
        config: {
          model: agent.config.model,
          options: agent.config.options,
          allowedCommands: project.settings.allowedCommands,
          timeoutMs: DEFAULT_RUN_TIMEOUT_MS,
        },
        env,
        sandbox,
        ...(runStructured(run) ? { structured: runStructured(run)! } : {}),
      };

      const handle = await begin(adapter, ctx);

      if (!opts.resuming) {
        run.markRunning();
        await this.tx.saveRunAndEvents(run, [{ type: 'orchestrator.status', payload: { status: 'running' } }]);
      }

      const outcome = await this.pump(run, handle);
      await this.finish(run, outcome);
    } catch (error) {
      await this.failSafely(run, String(error));
    } finally {
      await sandbox?.destroy().catch(() => undefined);
    }
  }

  /** Consumes adapter events + user inputs until the stream ends. */
  private async pump(run: Run, handle: AgentHandle): Promise<PumpOutcome> {
    const outcome: PumpOutcome = { cancelled: false, fatalError: null, result: null };
    let stopping = false;

    const heartbeat = setInterval(() => {
      run.heartbeat();
      void this.runs.save(run).catch(() => undefined);
    }, HEARTBEAT_MS);

    const timeout = setTimeout(() => {
      stopping = true;
      void handle.stop('timeout').catch(() => undefined);
    }, DEFAULT_RUN_TIMEOUT_MS);

    const inputPump = setInterval(() => {
      void (async () => {
        for (const input of await this.inputs.pending(run.id)) {
          const payload = input.payload as {
            kind: string;
            text?: string;
            permissionId?: string;
            decision?: 'allow' | 'deny';
            note?: string;
            reason?: string;
          };
          try {
            if (input.kind === 'message' && payload.text) {
              await handle.send({ text: payload.text });
              await this.tx.saveRunAndEvents(run, [{ type: 'user.message', payload: { text: payload.text } }]);
            } else if (input.kind === 'approval' && payload.permissionId && payload.decision) {
              await handle.respondToPermission(payload.permissionId, payload.decision, payload.note);
              if (run.status === 'awaiting_input') run.resumeRunning();
              await this.tx.saveRunAndEvents(run, [
                {
                  type: 'user.approval',
                  payload: { permissionId: payload.permissionId, decision: payload.decision },
                },
              ]);
            } else if (input.kind === 'cancel') {
              outcome.cancelled = true;
              stopping = true;
              await this.tx.saveRunAndEvents(run, [{ type: 'user.cancel', payload: { reason: payload.reason ?? null } }]);
              await handle.stop('cancelled');
            }
          } catch (error) {
            this.logger.warn(`input handling failed for run ${run.id}: ${String(error)}`);
          }
          await this.inputs.markConsumed(input.id);
        }
      })();
    }, INPUT_POLL_MS);

    try {
      for await (const raw of handle.events) {
        const parsed = agentEventSchema.safeParse(raw);
        if (!parsed.success) {
          await this.tx.saveRunAndEvents(run, [{ type: 'raw', payload: { raw: raw as unknown as Json } }]);
          continue;
        }
        const event: AgentEvent = parsed.data;

        if (event.type === 'permission.request') {
          if (run.status === 'running') run.awaitInput();
          await this.tx.saveRunAndEvents(
            run,
            [{ type: event.type, payload: event as unknown as Json }],
            [
              {
                aggregateType: 'run',
                aggregateId: run.id,
                eventType: EventTypes.RunAwaitingInput,
                payload: { permissionId: event.id },
              },
            ],
          );
          continue;
        }

        if (event.type === 'usage') {
          run.mergeUsage({
            tokensIn: event.tokensIn,
            tokensOut: event.tokensOut,
            costUsd: event.costUsd,
          });
        }
        if (event.type === 'result') {
          outcome.result = {
            outcome: event.outcome,
            summary: event.summary,
            structured: event.structured,
          };
        }
        if (event.type === 'fatal') {
          outcome.fatalError = event.error;
        }

        const resumeState = handle.getResumeState?.() ?? run.resumeState;
        run.setResumeState(resumeState ?? null);
        await this.tx.saveRunAndEvents(run, [{ type: event.type, payload: event as unknown as Json }]);

        if (stopping) break;
      }
    } finally {
      clearInterval(heartbeat);
      clearInterval(inputPump);
      clearTimeout(timeout);
    }
    return outcome;
  }

  private async finish(run: Run, outcome: PumpOutcome): Promise<void> {
    const flowRunId = await this.tx.flowRunIdFor(run.id);

    if (outcome.cancelled) {
      run.cancel();
      await this.tx.saveRunAndEvents(run, [{ type: 'orchestrator.status', payload: { status: 'cancelled' } }], [this.terminalEvent(run, EventTypes.RunCancelled, flowRunId)]);
      return;
    }
    if (outcome.fatalError !== null || outcome.result === null) {
      run.fail(outcome.fatalError ?? 'adapter stream ended without a result');
      await this.tx.saveRunAndEvents(
        run,
        [{ type: 'orchestrator.status', payload: { status: 'failed', error: run.error } }],
        [this.terminalEvent(run, EventTypes.RunFailed, flowRunId)],
      );
      return;
    }

    run.beginFinalizing();
    await this.tx.saveRunAndEvents(run, [{ type: 'orchestrator.status', payload: { status: 'finalizing' } }]);
    // Snapshot agent work as a commit + cumulative diff artifact (§8).
    try {
      await this.scm.finalizeRunWorkspace(run.snapshot());
    } catch (error) {
      this.logger.warn(`finalize workspace for run ${run.id} failed: ${String(error)}`);
    }

    if (outcome.result.outcome === 'success') {
      run.succeed();
      await this.tx.saveRunAndEvents(
        run,
        [{ type: 'orchestrator.status', payload: { status: 'succeeded' } }],
        [this.terminalEvent(run, EventTypes.RunSucceeded, flowRunId, outcome.result)],
      );
    } else {
      run.fail(outcome.result.summary || 'agent reported failure');
      await this.tx.saveRunAndEvents(
        run,
        [{ type: 'orchestrator.status', payload: { status: 'failed', error: run.error } }],
        [this.terminalEvent(run, EventTypes.RunFailed, flowRunId, outcome.result)],
      );
    }
  }

  private terminalEvent(run: Run, eventType: string, flowRunId: string | null, result?: { summary: string; structured?: Json }): IntegrationEvent {
    return {
      aggregateType: 'run',
      aggregateId: run.id,
      eventType,
      payload: {
        status: run.status,
        error: run.error,
        flowRunId,
        summary: result?.summary ?? null,
        structured: result?.structured ?? null,
      },
    };
  }

  private async failSafely(run: Run, error: string): Promise<void> {
    try {
      const flowRunId = await this.tx.flowRunIdFor(run.id);
      if (!run.isTerminal) run.fail(error);
      await this.tx.saveRunAndEvents(run, [{ type: 'orchestrator.status', payload: { status: 'failed', error } }], [this.terminalEvent(run, EventTypes.RunFailed, flowRunId)]);
    } catch (persistError) {
      this.logger.error(`could not persist failure for run ${run.id}: ${String(persistError)}`);
    }
  }
}
