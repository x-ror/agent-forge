import type { FlowRun } from './flow-run';
import type { FlowStep, FlowStepDecision, FlowStepStatus } from './flow-step';
import type { Schedule, Workflow } from './workflow';

export interface WorkflowRepository {
  insert(workflow: Workflow): Promise<void>;
  findById(id: string): Promise<Workflow | null>;
  /** Latest version per name for a project. */
  listLatest(projectId: string): Promise<Workflow[]>;
  findLatestByName(projectId: string, name: string): Promise<Workflow | null>;
  setEnabled(id: string, enabled: boolean): Promise<void>;
}

export interface FlowRunListItem {
  flowRun: FlowRun;
  taskTitle: string;
  workflowName: string;
  projectName: string;
}

export interface FlowRunRepository {
  insert(flowRun: FlowRun): Promise<void>;
  save(flowRun: FlowRun): Promise<void>;
  findById(id: string): Promise<FlowRun | null>;
  listActive(): Promise<FlowRun[]>;
  /** Newest-first, restricted to flows whose workflow belongs to one of the projects. */
  list(projectIds: string[], limit: number, cursor?: string): Promise<FlowRunListItem[]>;
}

export interface FlowStepRepository {
  insert(step: FlowStep): Promise<void>;
  findById(id: string): Promise<FlowStep | null>;
  findByRunId(runId: string): Promise<FlowStep | null>;
  listByFlowRun(flowRunId: string): Promise<FlowStep[]>;
  listActiveByFlowRun(flowRunId: string): Promise<FlowStep[]>;
  updateStatus(id: string, status: FlowStepStatus, opts?: { decision?: FlowStepDecision; finishedAt?: Date }): Promise<void>;
}

export interface ScheduleRepository {
  insert(schedule: Schedule): Promise<void>;
  save(schedule: Schedule): Promise<void>;
  findById(id: string): Promise<Schedule | null>;
  listEnabled(): Promise<Schedule[]>;
  listByProject(projectId: string): Promise<Schedule[]>;
  delete(id: string): Promise<void>;
}

export const WORKFLOW_REPOSITORY = Symbol('WorkflowRepository');
export const FLOW_RUN_REPOSITORY = Symbol('FlowRunRepository');
export const FLOW_STEP_REPOSITORY = Symbol('FlowStepRepository');
export const SCHEDULE_REPOSITORY = Symbol('ScheduleRepository');
