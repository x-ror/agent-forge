import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AgentDto,
  CreateAgentRequest,
  CreateProjectRequest,
  CreateTaskRequest,
  CreateTaskSourceRequest,
  FlowRunDto,
  PatDto,
  ProjectDto,
  RunDto,
  RunEventDto,
  RunInputRequest,
  TaskDto,
  TaskSourceDto,
  UserDto,
  WorkflowDto,
} from '@agentforge/core';
import { api } from './client';

// ---- auth ------------------------------------------------------------------

export function useMe() {
  return useQuery({
    queryKey: ['me'],
    queryFn: () => api.get<{ userId: string; via: string }>('/auth/me'),
    retry: false,
    staleTime: 60_000,
  });
}

export function useLogin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { email: string; password: string; register: boolean }) =>
      api.post<UserDto>(args.register ? '/auth/register' : '/auth/login', {
        email: args.email,
        password: args.password,
      }),
    onSuccess: () => void qc.invalidateQueries(),
  });
}

export function useLogout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<void>('/auth/logout'),
    onSuccess: () => qc.clear(),
  });
}

// ---- projects --------------------------------------------------------------

export function useProjects() {
  return useQuery({ queryKey: ['projects'], queryFn: () => api.get<ProjectDto[]>('/projects') });
}

export function useCreateProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateProjectRequest) => api.post<ProjectDto>('/projects', body),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['projects'] }),
  });
}

// ---- agents / adapters -----------------------------------------------------

export function useAgents() {
  return useQuery({ queryKey: ['agents'], queryFn: () => api.get<AgentDto[]>('/agents') });
}

export function useAdapters() {
  return useQuery({
    queryKey: ['adapters'],
    queryFn: () => api.get<Array<{ id: string; capabilities: Record<string, boolean> }>>('/adapters'),
    staleTime: Infinity,
  });
}

export function useCreateAgent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateAgentRequest) => api.post<AgentDto>('/agents', body),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['agents'] }),
  });
}

export function useDeleteAgent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete<void>(`/agents/${id}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['agents'] }),
  });
}

// ---- tasks -----------------------------------------------------------------

export function useTaskBoard(projectId: string | null, status?: string) {
  return useQuery({
    queryKey: ['tasks', projectId, status ?? 'all'],
    enabled: !!projectId,
    queryFn: () => api.get<{ tasks: TaskDto[]; nextCursor: string | null }>(`/tasks?projectId=${projectId}${status ? `&status=${status}` : ''}`),
  });
}

export function useCreateTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateTaskRequest) => api.post<TaskDto>('/tasks', body),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['tasks'] }),
  });
}

export function useTaskSources(projectId: string | null) {
  return useQuery({
    queryKey: ['task-sources', projectId],
    enabled: !!projectId,
    queryFn: () => api.get<TaskSourceDto[]>(`/task-sources?projectId=${projectId}`),
  });
}

export function useCreateTaskSource() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateTaskSourceRequest) => api.post<TaskSourceDto>('/task-sources', body),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['task-sources'] }),
  });
}

export function useSyncTaskSource() {
  return useMutation({
    mutationFn: (id: string) => api.post<{ queued: boolean }>(`/task-sources/${id}/sync`),
  });
}

// ---- workflows -------------------------------------------------------------

export function useWorkflows(projectId: string | null) {
  return useQuery({
    queryKey: ['workflows', projectId],
    enabled: !!projectId,
    queryFn: () => api.get<WorkflowDto[]>(`/workflows?projectId=${projectId}`),
  });
}

export function useWorkflow(id: string | null) {
  return useQuery({
    queryKey: ['workflow', id],
    enabled: !!id,
    queryFn: () => api.get<WorkflowDto>(`/workflows/${id}`),
  });
}

// ---- flow runs -------------------------------------------------------------

export function useFlowRuns() {
  return useQuery({
    queryKey: ['flow-runs'],
    queryFn: () => api.get<FlowRunDto[]>('/flow-runs'),
    refetchInterval: 5000,
  });
}

export function useFlowRun(id: string | null) {
  return useQuery({
    queryKey: ['flow-run', id],
    enabled: !!id,
    queryFn: () => api.get<FlowRunDto>(`/flow-runs/${id}`),
  });
}

export function useStartFlow() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { workflowId: string; taskId: string }) => api.post<FlowRunDto>('/flow-runs', body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['flow-runs'] });
      void qc.invalidateQueries({ queryKey: ['tasks'] });
    },
  });
}

export function useResolveGate(flowRunId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { approve: boolean; note?: string }) => api.post(`/flow-runs/${flowRunId}/gate`, body),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['flow-run', flowRunId] }),
  });
}

export function useFlowDiff(id: string | null, enabled: boolean) {
  return useQuery({
    queryKey: ['flow-diff', id],
    enabled: !!id && enabled,
    retry: false,
    queryFn: () => api.get<{ diff: string; baseRef: string | null }>(`/flow-runs/${id}/diff`),
  });
}

// ---- runs ------------------------------------------------------------------

export function useRun(id: string | null) {
  return useQuery({
    queryKey: ['run', id],
    enabled: !!id,
    queryFn: () => api.get<RunDto>(`/runs/${id}`),
  });
}

export function useRunInput(runId: string) {
  return useMutation({
    mutationFn: (body: RunInputRequest) => api.post<{ id: string }>(`/runs/${runId}/inputs`, body),
  });
}

export function useRunDiff(id: string | null, enabled: boolean) {
  return useQuery({
    queryKey: ['run-diff', id],
    enabled: !!id && enabled,
    retry: false,
    queryFn: () => api.get<{ diff: string; baseRef: string | null }>(`/runs/${id}/diff`),
  });
}

export type { RunEventDto, PatDto };

export function usePats() {
  return useQuery({ queryKey: ['pats'], queryFn: () => api.get<PatDto[]>('/pats') });
}

export function useCreatePat() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => api.post<PatDto & { token: string }>('/pats', { name }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['pats'] }),
  });
}
