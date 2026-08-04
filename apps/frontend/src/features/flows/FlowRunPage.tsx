import {
  Accordion,
  AccordionItem,
  Button,
  InlineLoading,
  Link as CarbonLink,
  Modal,
  Tab,
  TabList,
  TabPanel,
  TabPanels,
  Tabs,
  Tag,
  TextInput,
  Toggletip,
  ToggletipButton,
  ToggletipContent,
} from '@carbon/react';
import { CheckmarkFilled, CircleDash, ErrorFilled, InProgress, Information, Renew, TrashCan } from '@carbon/icons-react';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import type { FlowStepDto } from '@agentforge/core';
import { useAbandonFlow, useFlowDiff, useFlowRun, useResolveGate, useResumeFlow } from '../../api/hooks';
import { useSse } from '../../api/sse';
import { StatusTag } from '../../components/StatusTag';
import { DiffView } from '../diff/DiffView';

function StepIcon({ status }: { status: string }) {
  if (status === 'succeeded') return <CheckmarkFilled size={20} className="af-step-icon--succeeded" />;
  if (status === 'failed') return <ErrorFilled size={20} className="af-step-icon--failed" />;
  if (status === 'running' || status === 'awaiting_input') return <InProgress size={20} className="af-step-icon--active" />;
  return <CircleDash size={20} className="af-step-icon--idle" />;
}

function StepBody({ step, context }: { step: FlowStepDto; context: Record<string, unknown> }) {
  const stepContext = ((context.steps as Record<string, unknown> | undefined)?.[step.nodeId] ?? {}) as Record<string, unknown>;
  return (
    <div className="af-step-body">
      <div>
        <StatusTag status={step.status} /> started {new Date(step.startedAt).toLocaleTimeString()}
        {step.finishedAt && <> · finished {new Date(step.finishedAt).toLocaleTimeString()}</>}
      </div>
      {step.decision && (
        <div data-testid={`decision-${step.nodeId}`}>
          <Toggletip align="bottom">
            <ToggletipButton label="Why?">
              <Information />
            </ToggletipButton>
            <ToggletipContent>
              <p data-testid="decision-reasoning">{step.decision.reasoning}</p>
            </ToggletipContent>
          </Toggletip>
        </div>
      )}
      {typeof stepContext.summary === 'string' && stepContext.summary && <p>{stepContext.summary}</p>}
      {typeof stepContext.url === 'string' && stepContext.url && (
        <p>
          PR: <CarbonLink href={stepContext.url}>{stepContext.url}</CarbonLink>
        </p>
      )}
      {typeof stepContext.branch === 'string' && !stepContext.url && stepContext.branch && <p data-testid="pr-branch">pushed branch: {stepContext.branch}</p>}
      {step.runId && (
        <p>
          <CarbonLink as={Link} to={`/runs/${step.runId}`}>
            Open run detail →
          </CarbonLink>
        </p>
      )}
    </div>
  );
}

export function FlowRunPage() {
  const { id } = useParams<{ id: string }>();
  const flowRunId = id ?? null;
  const flow = useFlowRun(flowRunId);
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [gateOpen, setGateOpen] = useState(false);
  const [gateNote, setGateNote] = useState('');
  const [abandonOpen, setAbandonOpen] = useState(false);
  const resolveGate = useResolveGate(flowRunId ?? '');
  const resumeFlow = useResumeFlow(flowRunId ?? '');
  const abandonFlow = useAbandonFlow(flowRunId ?? '');
  const terminal = flow.data && ['succeeded', 'failed', 'cancelled'].includes(flow.data.status);
  // Only active or failed sessions need discard; already cancelled is done.
  const canAbandon = flow.data && (flow.data.status === 'failed' || flow.data.status === 'running' || flow.data.status === 'awaiting_input');
  const diff = useFlowDiff(flowRunId, true);

  useSse(flowRunId ? `/api/v1/flow-runs/${flowRunId}/stream` : null, {
    onConnect: () => void qc.invalidateQueries({ queryKey: ['flow-run', flowRunId] }),
    onMessage: () => {
      void qc.invalidateQueries({ queryKey: ['flow-run', flowRunId] });
      void qc.invalidateQueries({ queryKey: ['flow-diff', flowRunId] });
    },
  });

  if (!flow.data) return <InlineLoading description="Loading flow…" />;
  const steps = flow.data.steps ?? [];
  const awaitingGate = steps.find((s) => s.kind === 'gate' && s.status === 'awaiting_input');

  return (
    <div>
      <div className="af-page__header">
        <h3 className="af-page__header-title">Flow {flow.data.id.slice(-8)}</h3>
        <StatusTag status={flow.data.status} />
        {awaitingGate && (
          <Button kind="primary" size="sm" onClick={() => setGateOpen(true)} data-testid="open-gate">
            Review gate
          </Button>
        )}
        {flow.data.status === 'failed' && (
          <Button
            kind="primary"
            size="sm"
            renderIcon={Renew}
            disabled={resumeFlow.isPending || abandonFlow.isPending}
            onClick={() => resumeFlow.mutate()}
            data-testid="resume-flow"
            title="One retry of failed steps only; press again after another failure"
          >
            {resumeFlow.isPending ? 'Retrying…' : 'Retry once'}
          </Button>
        )}
        {canAbandon && (
          <Button
            kind="danger"
            size="sm"
            renderIcon={TrashCan}
            disabled={abandonFlow.isPending || resumeFlow.isPending}
            onClick={() => setAbandonOpen(true)}
            data-testid="abandon-flow"
          >
            Discard session
          </Button>
        )}
      </div>
      {flow.data.status === 'failed' && (
        <p className="af-repo-agent__role">
          <strong>Retry once</strong> — re-run failed steps (keeps worktree). <strong>Discard session</strong> — delete worktree, cancel flow, return task to backlog so you can
          Start workflow again.
        </p>
      )}
      {resumeFlow.isError && <p className="af-repo-agent__role">Retry failed: {resumeFlow.error instanceof Error ? resumeFlow.error.message : 'unknown error'}</p>}
      {abandonFlow.isError && <p className="af-repo-agent__role">Discard failed: {abandonFlow.error instanceof Error ? abandonFlow.error.message : 'unknown error'}</p>}

      <Tabs>
        <TabList aria-label="Flow views">
          <Tab>Timeline</Tab>
          <Tab>Diff</Tab>
        </TabList>
        <TabPanels>
          <TabPanel>
            {/* The story of the flow: every hand-off and decision (§10.2). */}
            <Accordion align="start">
              {steps.map((step) => (
                <AccordionItem
                  key={step.id}
                  open={step.status === 'running' || step.status === 'awaiting_input'}
                  title={
                    <span className="af-step-title" data-testid={`step-${step.nodeId}`}>
                      <StepIcon status={step.status} />
                      <strong>{step.nodeId}</strong>
                      <Tag size="sm" type="cool-gray">
                        {step.kind}
                      </Tag>
                      {step.decision?.route && (
                        <Tag size="sm" type="purple">
                          route: {step.decision.route}
                        </Tag>
                      )}
                    </span>
                  }
                >
                  <StepBody step={step} context={flow.data!.context} />
                </AccordionItem>
              ))}
            </Accordion>
          </TabPanel>
          <TabPanel>
            {diff.data ? <DiffView diff={diff.data.diff} /> : <p>{terminal ? 'No diff captured for this flow.' : 'Diff appears after the first agent step finishes.'}</p>}
          </TabPanel>
        </TabPanels>
      </Tabs>

      {gateOpen && awaitingGate && (
        <Modal
          open
          modalHeading="Human gate"
          primaryButtonText="Approve"
          secondaryButtonText="Reject"
          onRequestClose={() => setGateOpen(false)}
          onRequestSubmit={() => resolveGate.mutate({ approve: true, note: gateNote || undefined }, { onSuccess: () => setGateOpen(false) })}
          onSecondarySubmit={() => resolveGate.mutate({ approve: false, note: gateNote || undefined }, { onSuccess: () => setGateOpen(false) })}
        >
          <p>The flow is paused awaiting your decision.</p>
          <TextInput id="gate-note" labelText="Note (stored as reasoning)" value={gateNote} onChange={(e) => setGateNote(e.target.value)} />
        </Modal>
      )}

      {abandonOpen && (
        <Modal
          open
          danger
          modalHeading="Discard this session?"
          primaryButtonText="Discard"
          secondaryButtonText="Cancel"
          primaryButtonDisabled={abandonFlow.isPending}
          onRequestClose={() => setAbandonOpen(false)}
          onRequestSubmit={() =>
            abandonFlow.mutate(undefined, {
              onSuccess: () => {
                setAbandonOpen(false);
                void navigate('/');
              },
            })
          }
        >
          <p>
            This cancels the flow, deletes its worktree (and local agentforge branch), and returns the task to <strong>backlog</strong> so you can Start workflow again on the same
            issue.
          </p>
        </Modal>
      )}
    </div>
  );
}
