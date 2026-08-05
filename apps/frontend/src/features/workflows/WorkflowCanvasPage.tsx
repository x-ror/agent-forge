import { Button, Dropdown, InlineNotification, Layer, Select, SelectItem, Stack, TextArea, TextInput, Tile } from '@carbon/react';
import { addEdge, Background, Controls, Handle, Position, ReactFlow, useEdgesState, useNodesState, type Connection, type NodeProps } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { canonicalWorkflowTemplate, gatedWorkflowTemplate, validateWorkflowGraph, workflowDefinitionSchema, type WorkflowNode } from '@agentforge/core';
import { api } from '../../api/client';
import { useAgents, useWorkflow } from '../../api/hooks';
import { useAppState } from '../../state/app-state';
import { defaultEdgeCondition, defToFlow, flowToDef, freshNode, type CanvasEdge, type CanvasNode } from './graph';

const NODE_TYPES: Array<{ type: WorkflowNode['type']; label: string }> = [
  { type: 'trigger.task_selected', label: 'Trigger: task selected' },
  { type: 'action.create_worktree', label: 'Create worktree' },
  { type: 'action.agent', label: 'Agent step' },
  { type: 'decision.agent', label: 'Agent decision' },
  { type: 'decision.rule', label: 'Rule decision' },
  { type: 'gate.human', label: 'Human gate' },
  { type: 'gate.quality', label: 'Quality gate (commands + fixer)' },
  { type: 'action.open_pr', label: 'Open PR' },
  { type: 'action.notify', label: 'Notify' },
];

function AgentForgeNode({ data, selected }: NodeProps<CanvasNode>) {
  const wf = data.wf;
  const kindClass = wf.type.startsWith('trigger')
    ? 'af-canvas-node--trigger'
    : wf.type.startsWith('decision')
      ? 'af-canvas-node--decision'
      : wf.type === 'gate.human'
        ? 'af-canvas-node--gate'
        : '';
  const classes = ['af-canvas-node', kindClass, selected ? 'af-canvas-node--selected' : ''].filter(Boolean).join(' ');
  return (
    <div data-testid={`canvas-node-${wf.id}`} className={classes}>
      <Handle type="target" position={Position.Left} />
      <div className="af-canvas-node__type">{wf.type}</div>
      <strong>{wf.id}</strong>
      {'agent' in wf && wf.agent && <div>agent: {wf.agent}</div>}
      {'routes' in wf && <div>routes: {wf.routes.join(' | ')}</div>}
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

const nodeTypes = { agentforge: AgentForgeNode };

function Inspector({
  node,
  edge,
  agents,
  onChangeNode,
  onChangeEdgeLabel,
  onDelete,
}: {
  node: CanvasNode | null;
  edge: CanvasEdge | null;
  agents: string[];
  onChangeNode: (updated: WorkflowNode) => void;
  onChangeEdgeLabel: (label: string) => void;
  onDelete: () => void;
}) {
  if (edge) {
    return (
      <Stack gap={5}>
        <h5>Edge</h5>
        <TextInput
          id="edge-on"
          labelText="Condition (succeeded | failed | approved | rejected | route:<name>)"
          value={String(edge.label ?? '')}
          onChange={(e) => onChangeEdgeLabel(e.target.value)}
        />
        <Button kind="danger--ghost" size="sm" onClick={onDelete}>
          Delete edge
        </Button>
      </Stack>
    );
  }
  if (!node) return <p>Select a node or edge to edit it.</p>;
  const wf = node.data.wf;
  return (
    <Stack gap={5}>
      <h5>{wf.type}</h5>
      <TextInput id="node-id" labelText="Node id" value={wf.id} onChange={(e) => onChangeNode({ ...wf, id: e.target.value })} />
      {'agent' in wf && (
        <>
          <Select id="node-agent" labelText="Agent" value={wf.agent} onChange={(e) => onChangeNode({ ...wf, agent: e.target.value } as WorkflowNode)}>
            <SelectItem value="" text="— choose an agent —" />
            {agents.map((name) => (
              <SelectItem key={name} value={name} text={name} />
            ))}
          </Select>
          {agents.length === 0 ? (
            <p className="af-repo-agent__role">
              No runtime agents yet. Import from Settings → Repo agents (or register under Settings → Agents), then pick the agent <strong>by name</strong> here.
            </p>
          ) : (
            <p className="af-repo-agent__role">Names must match registered runtime agents (Settings → Agents).</p>
          )}
        </>
      )}
      {'prompt' in wf && (
        <TextArea
          id="node-prompt"
          labelText="Prompt template"
          helperText="{{task.title}}, {{steps.<id>.diff_summary}}, …"
          rows={6}
          value={wf.prompt}
          onChange={(e) => onChangeNode({ ...wf, prompt: e.target.value } as WorkflowNode)}
        />
      )}
      {'routes' in wf && (
        <TextInput
          id="node-routes"
          labelText="Routes (comma-separated)"
          value={wf.routes.join(',')}
          onChange={(e) =>
            onChangeNode({
              ...wf,
              routes: e.target.value
                .split(',')
                .map((r) => r.trim())
                .filter(Boolean),
            } as WorkflowNode)
          }
        />
      )}
      {wf.type === 'gate.quality' && (
        <>
          <TextArea
            id="node-commands"
            labelText="Commands (one per line, run in the worktree)"
            helperText="e.g. make fmt / make test — first failure stops and goes to the fixer"
            rows={4}
            value={wf.commands.join('\n')}
            onChange={(e) =>
              onChangeNode({
                ...wf,
                commands: e.target.value
                  .split('\n')
                  .map((c) => c.trim())
                  .filter(Boolean),
              } as WorkflowNode)
            }
          />
          <Select
            id="node-fixer"
            labelText="Fixer agent (optional)"
            value={wf.fixerAgent ?? ''}
            onChange={(e) => {
              const next = { ...wf } as WorkflowNode & { fixerAgent?: string };
              if (e.target.value) next.fixerAgent = e.target.value;
              else delete next.fixerAgent;
              onChangeNode(next);
            }}
          >
            <SelectItem value="" text="— none: gate just passes/fails —" />
            {agents.map((name) => (
              <SelectItem key={name} value={name} text={name} />
            ))}
          </Select>
          <TextInput
            id="node-max-rounds"
            labelText="Max fixer rounds (default 2)"
            value={String(wf.maxRounds ?? '')}
            onChange={(e) => {
              const parsed = Number(e.target.value);
              const next = { ...wf } as WorkflowNode & { maxRounds?: number };
              if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 5) next.maxRounds = parsed;
              else delete next.maxRounds;
              onChangeNode(next);
            }}
          />
        </>
      )}
      {'title' in wf && wf.type === 'action.open_pr' && (
        <>
          <TextInput id="node-title" labelText="PR title template" value={wf.title ?? ''} onChange={(e) => onChangeNode({ ...wf, title: e.target.value })} />
          <TextArea
            id="node-body"
            labelText="PR body template"
            helperText="{{steps.<id>.summary}}, {{task.title}}, … — Closes #N is appended automatically"
            rows={4}
            value={wf.body ?? ''}
            onChange={(e) => {
              const next = { ...wf } as WorkflowNode & { body?: string };
              if (e.target.value.trim()) next.body = e.target.value;
              else delete next.body;
              onChangeNode(next);
            }}
          />
        </>
      )}
      {'message' in wf && (
        <TextInput id="node-message" labelText="Message" value={wf.message ?? ''} onChange={(e) => onChangeNode({ ...wf, message: e.target.value } as WorkflowNode)} />
      )}
      <Button kind="danger--ghost" size="sm" onClick={onDelete}>
        Delete node
      </Button>
    </Stack>
  );
}

export function WorkflowCanvasPage() {
  const { id } = useParams<{ id: string }>();
  const existing = useWorkflow(id ?? null);
  const { projectId } = useAppState();
  const agents = useAgents();
  const navigate = useNavigate();

  const [name, setName] = useState('New workflow');
  const [nodes, setNodes, onNodesChange] = useNodesState<CanvasNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<CanvasEdge>([]);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    if (existing.data) {
      setName(existing.data.name);
      const { nodes: n, edges: e } = defToFlow(existing.data.definition as never);
      setNodes(n);
      setEdges(e);
    }
  }, [existing.data, setNodes, setEdges]);

  const definition = useMemo(() => flowToDef(nodes, edges), [nodes, edges]);
  const issues = useMemo(() => {
    if (nodes.length === 0) return [];
    const parsed = workflowDefinitionSchema.safeParse(definition);
    if (parsed.success) return [];
    // Structural issues from the graph validator read better than zod paths.
    const structural = validateWorkflowGraph(definition);
    if (structural.length > 0) return structural.map((i) => i.message);
    return parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
  }, [definition, nodes.length]);

  const selectedNode = nodes.find((n) => n.id === selectedNodeId) ?? null;
  const selectedEdge = edges.find((e) => e.id === selectedEdgeId) ?? null;

  const onConnect = useCallback(
    (connection: Connection) => {
      const source = nodes.find((n) => n.id === connection.source)?.data.wf;
      const label = defaultEdgeCondition(source, edges);
      setEdges((current) => addEdge({ ...connection, label }, current));
    },
    [nodes, edges, setEdges],
  );

  const addNode = useCallback(
    (type: WorkflowNode['type']) => {
      const wf = freshNode(type);
      setNodes((current) => [...current, { id: wf.id, position: { x: 80 + current.length * 30, y: 80 + current.length * 30 }, data: { wf }, type: 'agentforge' }]);
    },
    [setNodes],
  );

  const loadTemplate = useCallback(
    (template: { name: string; definition: Parameters<typeof defToFlow>[0] }) => {
      setName(template.name);
      const { nodes: n, edges: e } = defToFlow(template.definition);
      setNodes(n);
      setEdges(e);
    },
    [setNodes, setEdges],
  );

  const save = useCallback(async () => {
    setSaveError(null);
    try {
      const saved = id
        ? await api.post<{ id: string }>(`/workflows/${id}/versions`, { definition })
        : await api.post<{ id: string }>('/workflows', { projectId, name, definition });
      navigate(`/workflows`, { state: { saved: saved.id } });
    } catch (error) {
      setSaveError(String((error as Error).message));
    }
  }, [definition, id, name, navigate, projectId]);

  return (
    <div className="af-canvas-page">
      <div className="af-canvas-page__main">
        <div className="af-canvas-page__toolbar">
          <div className="af-canvas-page__toolbar-name">
            <TextInput id="wf-name" labelText="Workflow name" value={name} disabled={!!id} onChange={(e) => setName(e.target.value)} />
          </div>
          <Dropdown
            id="add-node"
            titleText="Add node"
            label="Add node…"
            items={NODE_TYPES}
            itemToString={(item) => item?.label ?? ''}
            selectedItem={null}
            onChange={({ selectedItem }) => selectedItem && addNode(selectedItem.type)}
            className="af-canvas-page__toolbar-add"
          />
          <Button kind="tertiary" size="md" onClick={() => loadTemplate(canonicalWorkflowTemplate)} data-testid="load-template">
            Load canonical template
          </Button>
          <Button kind="tertiary" size="md" onClick={() => loadTemplate(gatedWorkflowTemplate())} data-testid="load-gated-template">
            Load gated template
          </Button>
          <Button size="md" onClick={() => void save()} disabled={issues.length > 0 || nodes.length === 0} data-testid="save-workflow">
            {id ? `Save as v${(existing.data?.version ?? 0) + 1}` : 'Save workflow'}
          </Button>
        </div>
        {issues.length > 0 && <InlineNotification kind="warning" lowContrast hideCloseButton title="Graph issues" subtitle={issues.slice(0, 3).join(' · ')} />}
        {saveError && <InlineNotification kind="error" lowContrast title="Save failed" subtitle={saveError} onClose={() => setSaveError(null)} />}
        <div className="af-canvas-page__flow">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeClick={(_e, node) => {
              setSelectedNodeId(node.id);
              setSelectedEdgeId(null);
            }}
            onEdgeClick={(_e, edge) => {
              setSelectedEdgeId(edge.id);
              setSelectedNodeId(null);
            }}
            onPaneClick={() => {
              setSelectedNodeId(null);
              setSelectedEdgeId(null);
            }}
            fitView
            colorMode="system"
          >
            <Background />
            <Controls />
          </ReactFlow>
        </div>
      </div>
      <Layer>
        <Tile className="af-canvas-page__inspector">
          <Inspector
            node={selectedNode}
            edge={selectedEdge}
            agents={(agents.data ?? []).map((a) => a.name)}
            onChangeNode={(updated) => {
              const oldId = selectedNode?.id;
              setNodes((current) => current.map((n) => (n.id === oldId ? { ...n, id: updated.id, data: { wf: updated } } : n)));
              setEdges((current) =>
                current.map((e) => ({
                  ...e,
                  source: e.source === oldId ? updated.id : e.source,
                  target: e.target === oldId ? updated.id : e.target,
                })),
              );
              setSelectedNodeId(updated.id);
            }}
            onChangeEdgeLabel={(label) => setEdges((current) => current.map((e) => (e.id === selectedEdgeId ? { ...e, label } : e)))}
            onDelete={() => {
              if (selectedNodeId) {
                setNodes((current) => current.filter((n) => n.id !== selectedNodeId));
                setEdges((current) => current.filter((e) => e.source !== selectedNodeId && e.target !== selectedNodeId));
                setSelectedNodeId(null);
              }
              if (selectedEdgeId) {
                setEdges((current) => current.filter((e) => e.id !== selectedEdgeId));
                setSelectedEdgeId(null);
              }
            }}
          />
        </Tile>
      </Layer>
    </div>
  );
}
