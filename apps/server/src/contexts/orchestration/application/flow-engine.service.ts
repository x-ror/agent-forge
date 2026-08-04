import { Inject, Injectable, Logger } from '@nestjs/common';
import { renderTemplate, type Json, type WorkflowNode } from '@agentforge/core';
import { uuidv7 } from '../../../shared/uuidv7';
import { EventTypes } from '../../../shared/outbox/integration-event';
import { ScmService } from '../../scm/application/scm.service';
import { capDiff, coerceRoute, evaluateRules, matchingEdges, nodeById, stepKindFor, stepOutcome, summarizeDiff } from '../domain/engine-logic';
import type { FlowStep } from '../domain/flow-step';
import { ORCHESTRATION_TX, type OrchestrationTxPort, type TickOps, type TickState } from '../domain/ports';

const DEFAULT_GATE_TIMEOUT_MINUTES = 24 * 60;

/** External side effect an action step needs after the planning tx commits. */
interface SideEffect {
  stepId: string;
  nodeId: string;
  kind: 'worktree' | 'open_pr';
}

/**
 * The workflow engine (§7.3): a stateless process manager. One tick =
 * reconcile finished runs into steps, resolve edges, start next nodes,
 * settle the flow — all in one advisory-locked transaction. External side
 * effects (worktree, PR) run after commit and re-tick.
 */
@Injectable()
export class FlowEngine {
  private readonly logger = new Logger(FlowEngine.name);

  constructor(
    @Inject(ORCHESTRATION_TX) private readonly otx: OrchestrationTxPort,
    private readonly scm: ScmService,
  ) {}

  async tick(flowRunId: string): Promise<void> {
    const effects = await this.otx.withFlowTick(flowRunId, (ops) => this.plan(ops));
    if (!effects || effects.length === 0) return;

    for (const effect of effects) {
      await this.performSideEffect(flowRunId, effect);
    }
    // Side effects completed steps → another planning pass continues the flow.
    await this.tick(flowRunId);
  }

  // ---- planning (inside the tx) --------------------------------------------

  private async plan(ops: TickOps): Promise<SideEffect[]> {
    const state = ops.state();
    if (state.flow.status === 'succeeded' || state.flow.status === 'failed' || state.flow.status === 'cancelled') {
      return [];
    }

    await this.completeFinishedRuns(ops, state);
    await this.expireTimedOutGates(ops, state);

    const effects: SideEffect[] = [];
    // Policy: agents try once. `failed` blocks re-entry until the user hits
    // Resume (which marks those steps skipped). Never auto-retry agents.
    const started = new Set(
      state.steps.filter((s) => s.status === 'succeeded' || s.status === 'running' || s.status === 'awaiting_input' || s.status === 'failed').map((s) => s.nodeId),
    );

    // Resolve edges to a fixpoint: immediately-completing steps (triggers,
    // rule decisions, notify) cascade within one tick.
    // Latest non-skipped step per node drives outcomes.
    let progressed = true;
    while (progressed) {
      progressed = false;
      for (const step of latestStepsByNode(state.steps)) {
        if (step.status === 'skipped') continue;
        const outcome = stepOutcome(step);
        if (!outcome) continue;
        for (const edge of matchingEdges(state.definition, step.nodeId, outcome)) {
          if (started.has(edge.to)) continue;
          started.add(edge.to);
          const node = nodeById(state.definition, edge.to);
          if (!node) continue;
          const effect = await this.startNode(ops, state, node);
          if (effect) effects.push(effect);
          progressed = true;
        }
      }
    }

    await this.settle(ops, state, effects);
    return effects;
  }

  /** Agent/decision steps whose runs reached a terminal state → complete them. */
  private async completeFinishedRuns(ops: TickOps, state: TickState): Promise<void> {
    for (const step of state.steps) {
      if ((step.kind !== 'agent' && step.kind !== 'decision') || step.status !== 'running') continue;
      if (!step.runId) continue;
      const run = await ops.runInfo(step.runId);
      if (!run) continue;

      if (run.status === 'succeeded') {
        const result = await ops.lastRunResult(step.runId);
        const diff = await ops.latestDiff(step.runId);
        const stepContext: Record<string, Json> = {
          status: 'succeeded',
          summary: result?.summary ?? '',
        };
        if (diff) {
          stepContext.diff = capDiff(diff);
          stepContext.diff_summary = summarizeDiff(diff);
          stepContext.diff_lines = diff.split('\n').filter((l) => /^[+-][^+-]/.test(l)).length;
        }

        if (step.kind === 'decision') {
          const node = nodeById(state.definition, step.nodeId);
          const routes = node && 'routes' in node ? node.routes : [];
          const decision = coerceRoute(routes, result?.structured ?? null, result?.summary ?? '');
          if (!decision) {
            await ops.completeStep(step.id, 'failed', {
              decision: {
                route: '',
                reasoning: `decision output could not be coerced to [${routes.join(', ')}]: ${result?.summary ?? '(no result)'}`,
              },
            });
            continue;
          }
          stepContext.route = decision.route;
          stepContext.reasoning = decision.reasoning;
          if (result?.structured) stepContext.structured = result.structured;
          await ops.completeStep(step.id, 'succeeded', { decision });
        } else {
          if (result?.structured) stepContext.structured = result.structured;
          await ops.completeStep(step.id, 'succeeded');
        }
        await ops.mergeFlowContext({ steps: { [step.nodeId]: stepContext } });
      } else if (run.status === 'failed') {
        await ops.completeStep(step.id, 'failed');
        await ops.mergeFlowContext({
          steps: { [step.nodeId]: { status: 'failed', error: run.error ?? 'run failed' } },
        });
      } else if (run.status === 'cancelled') {
        await ops.completeStep(step.id, 'cancelled');
      }
    }
  }

  private async expireTimedOutGates(ops: TickOps, state: TickState): Promise<void> {
    for (const step of state.steps) {
      if (step.kind !== 'gate' || step.status !== 'awaiting_input') continue;
      const node = nodeById(state.definition, step.nodeId);
      const timeoutMinutes = node && 'timeoutMinutes' in node && node.timeoutMinutes ? node.timeoutMinutes : DEFAULT_GATE_TIMEOUT_MINUTES;
      if (Date.now() - step.startedAt.getTime() > timeoutMinutes * 60_000) {
        // Unattended flows never hang forever (§3.1): timeout = rejection.
        await ops.completeStep(step.id, 'succeeded', {
          decision: { route: 'rejected', reasoning: `gate timed out after ${timeoutMinutes}m` },
        });
        if (state.flow.status === 'awaiting_input') await ops.setFlowStatus('running');
      }
    }
  }

  // ---- starting nodes ------------------------------------------------------

  private async startNode(ops: TickOps, state: TickState, node: WorkflowNode): Promise<SideEffect | null> {
    const stepId = uuidv7();
    const base: FlowStep = {
      id: stepId,
      flowRunId: state.flow.id,
      nodeId: node.id,
      kind: stepKindFor(node),
      status: 'running',
      runId: null,
      decision: null,
      startedAt: new Date(),
      finishedAt: null,
    };

    switch (node.type) {
      case 'trigger.task_selected':
      case 'trigger.task_synced':
      case 'trigger.schedule':
        await ops.insertStep({ ...base, status: 'succeeded', finishedAt: new Date() });
        return null;

      case 'action.create_worktree':
        await ops.insertStep(base);
        return { stepId, nodeId: node.id, kind: 'worktree' };

      case 'action.open_pr':
        await ops.insertStep(base);
        return { stepId, nodeId: node.id, kind: 'open_pr' };

      case 'action.agent':
      case 'decision.agent': {
        const agentId = await ops.agentIdByName(state.projectOwnerId, node.agent);
        if (!agentId) {
          await ops.insertStep({ ...base, status: 'failed', finishedAt: new Date() });
          await ops.mergeFlowContext({
            steps: { [node.id]: { status: 'failed', error: `agent "${node.agent}" not found` } },
          });
          return null;
        }
        const runId = uuidv7();
        const worktree = state.flow.context.worktree as { path?: string; branch?: string; baseRef?: string } | undefined;
        await ops.insertRun({
          runId,
          agentId,
          prompt: renderTemplate(node.prompt, state.flow.context),
          baseRef: worktree?.baseRef ?? state.defaultBranch,
          workspacePath: worktree?.path ?? null,
          branch: worktree?.branch ?? null,
          structured: node.type === 'decision.agent' ? ({ routes: node.routes } as unknown as Json) : null,
        });
        await ops.insertStep({ ...base, runId });
        return null;
      }

      case 'decision.rule': {
        const decision = evaluateRules(node.rules, node.defaultRoute, state.flow.context as Json);
        if (!decision) {
          await ops.insertStep({ ...base, status: 'failed', finishedAt: new Date() });
          return null;
        }
        await ops.insertStep({
          ...base,
          status: 'succeeded',
          decision,
          finishedAt: new Date(),
        });
        await ops.mergeFlowContext({ steps: { [node.id]: { ...decision, status: 'succeeded' } } });
        return null;
      }

      case 'gate.human': {
        await ops.insertStep({ ...base, status: 'awaiting_input' });
        if (state.flow.status === 'running') await ops.setFlowStatus('awaiting_input');
        return null;
      }

      case 'action.notify': {
        await ops.appendOutbox([
          {
            aggregateType: 'notification',
            aggregateId: state.flow.id,
            eventType: EventTypes.NotifyRequested,
            payload: {
              channel: node.channel ?? 'log',
              flowRunId: state.flow.id,
              taskId: state.task.id,
              message: renderTemplate(node.message ?? 'flow {{task.title}} update', state.flow.context),
            },
          },
        ]);
        await ops.insertStep({ ...base, status: 'succeeded', finishedAt: new Date() });
        return null;
      }
    }
  }

  // ---- settlement ----------------------------------------------------------

  private async settle(ops: TickOps, state: TickState, pendingEffects: SideEffect[]): Promise<void> {
    if (state.flow.status !== 'running') return;
    // Ignore skipped (superseded by resume) when judging the flow.
    const latest = latestStepsByNode(state.steps).filter((s) => s.status !== 'skipped');
    const active = latest.some((s) => s.status === 'running' || s.status === 'awaiting_input');
    if (active || pendingEffects.length > 0) return;

    const anyCancelled = latest.some((s) => s.status === 'cancelled');
    if (anyCancelled) {
      await ops.setFlowStatus('cancelled', new Date());
      if (state.task.status === 'in_flow') await ops.setTaskStatus('backlog');
      return;
    }

    // A failed step whose failure edge was NOT handled ends the flow failed;
    // a handled failure still marks the flow (and task) failed at the end —
    // failure is a first-class, honest outcome (§7.3).
    const anyFailed = latest.some((s) => s.status === 'failed');
    const anyRejectedGate = latest.some((s) => s.kind === 'gate' && s.decision?.route === 'rejected');
    if (anyFailed || anyRejectedGate) {
      await ops.setFlowStatus('failed', new Date());
      if (state.task.status === 'in_flow') await ops.setTaskStatus('failed');
      return;
    }

    await ops.setFlowStatus('succeeded', new Date());
    if (state.task.status === 'in_flow') await ops.setTaskStatus('done');
  }

  // ---- side effects (outside the tx) ---------------------------------------

  private async performSideEffect(flowRunId: string, effect: SideEffect): Promise<void> {
    try {
      if (effect.kind === 'worktree') {
        await this.performWorktree(flowRunId, effect);
      } else {
        await this.performOpenPr(flowRunId, effect);
      }
    } catch (error) {
      this.logger.warn(`side effect ${effect.kind} for flow ${flowRunId} failed: ${String(error)}`);
      await this.otx.withFlowTick(flowRunId, async (ops) => {
        await ops.completeStep(effect.stepId, 'failed');
        await ops.mergeFlowContext({
          steps: { [effect.nodeId]: { status: 'failed', error: String(error).slice(0, 500) } },
        });
        return [];
      });
    }
  }

  private async performWorktree(flowRunId: string, effect: SideEffect): Promise<void> {
    const setup = await this.otx.withFlowTick(flowRunId, async (ops) => {
      const state = ops.state();
      return {
        projectId: state.projectId,
        defaultBranch: state.defaultBranch,
        task: state.task,
      };
    });
    if (!setup) return;
    // ScmService is idempotent here — recovery re-runs land on the same worktree.
    const project = await this.scm.projectForWorktree(setup.projectId);
    const worktree = await this.scm.createWorktree(project, {
      kind: 'flow',
      id: flowRunId,
      name: setup.task.externalKey ?? setup.task.title,
      baseRef: setup.defaultBranch,
    });
    await this.otx.withFlowTick(flowRunId, async (ops) => {
      await ops.mergeFlowContext({
        worktree: { path: worktree.path, branch: worktree.branch, baseRef: worktree.baseRef },
      });
      await ops.completeStep(effect.stepId, 'succeeded');
      return [];
    });
  }

  private async performOpenPr(flowRunId: string, effect: SideEffect): Promise<void> {
    const setup = await this.otx.withFlowTick(flowRunId, async (ops) => {
      const state = ops.state();
      const node = nodeById(state.definition, effect.nodeId);
      const worktree = state.flow.context.worktree as { path?: string; branch?: string; baseRef?: string } | undefined;
      const lastAgentStep = [...state.steps].reverse().find((s) => s.kind === 'agent' && s.runId !== null);
      return {
        projectId: state.projectId,
        worktree,
        runId: lastAgentStep?.runId ?? null,
        title: renderTemplate(node && 'title' in node && node.title ? node.title : 'AgentForge: {{task.title}}', state.flow.context),
        taskTitle: state.task.title,
      };
    });
    if (!setup) return;
    if (!setup.worktree?.path || !setup.worktree.branch || !setup.worktree.baseRef) {
      throw new Error('open_pr: no worktree in flow context');
    }
    const project = await this.scm.projectForWorktree(setup.projectId);
    const result = await this.scm.pushAndOpenPr({
      project,
      runId: setup.runId,
      flowRunId,
      worktree: setup.worktree.path,
      branch: setup.worktree.branch,
      baseRef: setup.worktree.baseRef,
      title: setup.title,
      body: `Automated by AgentForge for task: ${setup.taskTitle}`,
    });
    await this.otx.withFlowTick(flowRunId, async (ops) => {
      await ops.mergeFlowContext({
        steps: {
          [effect.nodeId]: {
            status: 'succeeded',
            kind: result.kind,
            url: result.url,
            number: result.number,
            branch: result.branch,
          },
        },
      });
      await ops.completeStep(effect.stepId, 'succeeded');
      return [];
    });
  }
}

/** Latest step attempt per workflow node (by startedAt, then id). */
function latestStepsByNode(steps: FlowStep[]): FlowStep[] {
  const map = new Map<string, FlowStep>();
  for (const step of steps) {
    const prev = map.get(step.nodeId);
    if (!prev) {
      map.set(step.nodeId, step);
      continue;
    }
    const t = step.startedAt.getTime() - prev.startedAt.getTime();
    if (t > 0 || (t === 0 && step.id > prev.id)) map.set(step.nodeId, step);
  }
  return [...map.values()];
}
