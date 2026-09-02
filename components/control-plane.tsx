'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  Activity,
  Bot,
  Boxes,
  CheckCircle2,
  ChevronRight,
  CircleGauge,
  Clock3,
  FlaskConical,
  Layers3,
  Play,
  Plus,
  RefreshCw,
  ShieldCheck,
  TerminalSquare,
  Workflow,
  XCircle,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';

type View = 'Overview' | 'Agents' | 'Runs' | 'Tools' | 'Evaluations' | 'Guardrails';
type Overview = {
  actor: { email: string; role: string };
  workspace: { name: string };
  metrics: { totalRuns: number; successRate: number; medianLatencyMs: number; pendingApprovals: number };
  agents: Array<Record<string, unknown>>;
  tools: Array<Record<string, unknown>>;
  runs: Array<Record<string, unknown>>;
  approvals: Array<Record<string, unknown>>;
  evaluations: Array<Record<string, unknown>>;
  audit: Array<Record<string, unknown>>;
};
type RunResult = {
  id: string;
  status: string;
  output: string;
  latencyMs: number;
  approvalId?: string;
  steps: Array<{ id: string; kind: string; name: string; status: string; durationMs: number }>;
};

const primaryNav: Array<{ label: View; icon: typeof Bot }> = [
  { label: 'Overview', icon: CircleGauge },
  { label: 'Agents', icon: Bot },
  { label: 'Runs', icon: Activity },
  { label: 'Tools', icon: Boxes },
  { label: 'Evaluations', icon: FlaskConical },
];

const initialAgentForm = {
  name: '',
  description: '',
  systemPrompt: 'You are a reliable operations agent. Verify facts with tools before answering. Ask for approval before any action that changes external state.',
  provider: 'mock',
  model: 'relay-sim-1',
  temperature: 0.2,
  status: 'draft',
  allowedTools: ['lookup_account', 'lookup_policy', 'issue_refund'],
  guardrails: { redactPii: true, blockPromptInjection: true, requireApprovalForWrites: true },
};

const initialToolForm = {
  name: '',
  displayName: '',
  description: '',
  url: '',
  method: 'POST',
  approvalRequired: false,
};

const initialEvaluationForm = {
  name: '',
  description: '',
  caseName: '',
  input: '',
  terms: '',
  graderType: 'contains',
};

export function ControlPlane() {
  const [view, setView] = useState<View>('Overview');
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [runOpen, setRunOpen] = useState(false);
  const [agentOpen, setAgentOpen] = useState(false);
  const [toolOpen, setToolOpen] = useState(false);
  const [evaluationOpen, setEvaluationOpen] = useState(false);
  const [runInput, setRunInput] = useState('Can I get a refund for order #A-1042?');
  const [runResult, setRunResult] = useState<RunResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [agentForm, setAgentForm] = useState(initialAgentForm);
  const [toolForm, setToolForm] = useState(initialToolForm);
  const [evaluationForm, setEvaluationForm] = useState(initialEvaluationForm);

  const refresh = useCallback(async () => {
    setError('');
    try {
      const response = await fetch('/api/overview', { cache: 'no-store' });
      const payload = await response.json() as Overview & { error?: string };
      if (!response.ok) throw new Error(payload.error || 'Could not load the workspace.');
      setData(payload);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not load the workspace.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { queueMicrotask(() => void refresh()); }, [refresh]);

  const activeAgent = data?.agents[0];
  const title = view === 'Overview' ? 'Your agents, under control.' : view;
  const subtitle = {
    Overview: 'Build, test, deploy, and improve production agents from one operating surface.',
    Agents: 'Configure instructions, models, tools, and deployment status.',
    Runs: 'Inspect every decision, tool call, policy check, and outcome.',
    Tools: 'Control the capabilities agents can access in your environment.',
    Evaluations: 'Turn expected behavior into repeatable release gates.',
    Guardrails: 'Review sensitive actions and enforce operating policy.',
  }[view];

  async function runAgent() {
    if (!activeAgent) return;
    setBusy(true);
    setError('');
    setRunResult(null);
    try {
      const response = await fetch('/api/runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId: activeAgent.id, input: runInput }),
      });
      const payload = await response.json() as RunResult & { error?: string };
      if (!response.ok) throw new Error(payload.error || 'Run failed.');
      setRunResult(payload);
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Run failed.');
    } finally {
      setBusy(false);
    }
  }

  async function createAgent() {
    setBusy(true);
    setError('');
    try {
      const response = await fetch('/api/agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(agentForm),
      });
      const payload = await response.json() as { error?: string };
      if (!response.ok) throw new Error(payload.error || 'Could not create the agent.');
      setAgentOpen(false);
      setAgentForm(initialAgentForm);
      setView('Agents');
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not create the agent.');
    } finally {
      setBusy(false);
    }
  }

  async function createTool() {
    setBusy(true);
    setError('');
    try {
      const response = await fetch('/api/tools', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(toolForm),
      });
      const payload = await response.json() as { error?: string };
      if (!response.ok) throw new Error(payload.error || 'Could not connect the tool.');
      setToolOpen(false);
      setToolForm(initialToolForm);
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not connect the tool.');
    } finally {
      setBusy(false);
    }
  }

  function toggleAgentTool(name: string) {
    const allowedTools = agentForm.allowedTools.includes(name)
      ? agentForm.allowedTools.filter((item) => item !== name)
      : [...agentForm.allowedTools, name];
    setAgentForm({ ...agentForm, allowedTools });
  }

  async function createEvaluation() {
    if (!activeAgent) return;
    setBusy(true);
    setError('');
    try {
      const response = await fetch('/api/evaluations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agentId: activeAgent.id,
          name: evaluationForm.name,
          description: evaluationForm.description,
          cases: [{
            name: evaluationForm.caseName,
            input: evaluationForm.input,
            graderType: evaluationForm.graderType,
            terms: evaluationForm.terms.split(',').map((term) => term.trim()).filter(Boolean),
          }],
        }),
      });
      const payload = await response.json() as { error?: string };
      if (!response.ok) throw new Error(payload.error || 'Could not create the evaluation.');
      setEvaluationOpen(false);
      setEvaluationForm(initialEvaluationForm);
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not create the evaluation.');
    } finally {
      setBusy(false);
    }
  }

  async function decideApproval(approvalId: string, decision: 'approved' | 'rejected') {
    setBusy(true);
    try {
      const response = await fetch('/api/approvals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ approvalId, decision }),
      });
      const payload = await response.json() as { error?: string };
      if (!response.ok) throw new Error(payload.error || 'Could not record the decision.');
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not record the decision.');
    } finally {
      setBusy(false);
    }
  }

  async function runEvaluation(suiteId: string) {
    setBusy(true);
    setError('');
    try {
      const response = await fetch('/api/evaluations/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ suiteId }),
      });
      const payload = await response.json() as { error?: string; score?: number };
      if (!response.ok) throw new Error(payload.error || 'Evaluation failed.');
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Evaluation failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="mx-auto grid min-h-screen max-w-[1680px] grid-cols-1 lg:grid-cols-[232px_minmax(0,1fr)]">
        <aside className="hidden border-r border-sidebar-border bg-sidebar px-4 py-5 lg:flex lg:flex-col">
          <Brand />
          <nav className="mt-8 space-y-1" aria-label="Primary navigation">
            {primaryNav.map(({ label, icon: Icon }) => (
              <button key={label} onClick={() => setView(label)} aria-current={view === label ? 'page' : undefined} className={navClass(view === label)}>
                <Icon className="size-4" />{label}
              </button>
            ))}
          </nav>
          <div className="mt-8 px-3 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">Workspace</div>
          <nav className="mt-2 space-y-1" aria-label="Workspace navigation">
            <button onClick={() => setView('Tools')} className={navClass(view === 'Tools')}><Layers3 className="size-4" />Integrations</button>
            <button onClick={() => setView('Guardrails')} className={navClass(view === 'Guardrails')}><ShieldCheck className="size-4" />Guardrails</button>
            <button onClick={() => setView('Runs')} className={navClass(false)}><TerminalSquare className="size-4" />Environments</button>
          </nav>
          <div className="mt-auto rounded-xl border border-border bg-card p-3 shadow-sm">
            <div className="flex items-center gap-2 text-xs font-medium"><span className="relative flex size-2"><span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-500 opacity-40" /><span className="relative inline-flex size-2 rounded-full bg-emerald-500" /></span>Runtime healthy</div>
            <p className="mt-1.5 text-[11px] leading-4 text-muted-foreground">Persistent store and tool runner are operational.</p>
          </div>
        </aside>

        <section className="min-w-0">
          <header className="flex h-16 items-center justify-between border-b border-border bg-background/90 px-5 backdrop-blur md:px-8">
            <div className="flex items-center gap-3 lg:hidden"><Brand compact /></div>
            <div className="hidden items-center gap-2 text-sm text-muted-foreground lg:flex"><span>{data?.workspace.name ?? 'Production workspace'}</span><ChevronRight className="size-3.5" /><span className="font-medium text-foreground">{view}</span></div>
            <div className="flex items-center gap-2">
              <Button variant="outline" onClick={() => void refresh()} className="hidden sm:inline-flex"><RefreshCw data-icon="inline-start" className={loading ? 'animate-spin' : ''} />Refresh</Button>
              <Button onClick={() => setAgentOpen(true)}><Plus data-icon="inline-start" />New agent</Button>
              <div title={`${data?.actor.email ?? 'Loading'} · ${data?.actor.role ?? ''}`} className="ml-1 grid size-8 place-items-center rounded-full bg-[#dbe9e4] text-xs font-semibold text-[#184d42]">{initials(data?.actor.email)}</div>
            </div>
          </header>

          <div className="px-5 py-7 md:px-8 md:py-8">
            <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.14em] text-primary">{view === 'Overview' ? 'Live operations' : 'Production workspace'}</p>
                <h1 className="mt-2 text-[clamp(1.75rem,3vw,2.4rem)] font-semibold tracking-[-0.045em]">{title}</h1>
                <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">{subtitle}</p>
              </div>
              {view === 'Overview' && <Button size="lg" onClick={() => { setRunResult(null); setRunOpen(true); }}><Play data-icon="inline-start" className="fill-current" />Run live test</Button>}
              {view === 'Tools' && <Button size="lg" onClick={() => setToolOpen(true)}><Plus data-icon="inline-start" />Connect HTTP tool</Button>}
              {view === 'Evaluations' && <Button size="lg" onClick={() => setEvaluationOpen(true)}><Plus data-icon="inline-start" />New suite</Button>}
            </div>

            {error && <div role="alert" className="mt-5 flex items-center gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800"><XCircle className="size-4" />{error}</div>}
            {loading && !data ? <LoadingGrid /> : data && <WorkspaceView view={view} data={data} busy={busy} setRunOpen={setRunOpen} setRunResult={setRunResult} setView={setView} runEvaluation={runEvaluation} decideApproval={decideApproval} />}
          </div>
        </section>
      </div>

      <Dialog open={runOpen} onOpenChange={setRunOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader><DialogTitle>Run {asText(activeAgent?.name, 'agent')}</DialogTitle><DialogDescription>Send a real input through the configured runtime, tools, guardrails, and trace store.</DialogDescription></DialogHeader>
          <label htmlFor="run-input" className="space-y-2 text-xs font-medium">Input<Textarea id="run-input" className="min-h-24 text-sm" value={runInput} onChange={(event) => setRunInput(event.target.value)} /></label>
          {runResult && <RunResultCard result={runResult} />}
          <DialogFooter><Button variant="outline" onClick={() => setRunOpen(false)}>Close</Button><Button onClick={() => void runAgent()} disabled={busy || !runInput.trim()}>{busy ? <RefreshCw className="animate-spin" /> : <Play className="fill-current" />}Execute</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={agentOpen} onOpenChange={setAgentOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader><DialogTitle>Create an agent</DialogTitle><DialogDescription>Start with a model, operating instructions, an explicit tool allowlist, and safe defaults.</DialogDescription></DialogHeader>
          <div className="grid gap-4 sm:grid-cols-2">
            <label htmlFor="agent-name" className="space-y-2 text-xs font-medium">Name<Input id="agent-name" value={agentForm.name} onChange={(event) => setAgentForm({ ...agentForm, name: event.target.value })} placeholder="Order operations agent" /></label>
            <label htmlFor="agent-model" className="space-y-2 text-xs font-medium">Model<Input id="agent-model" value={agentForm.model} onChange={(event) => setAgentForm({ ...agentForm, model: event.target.value })} /></label>
            <label htmlFor="agent-description" className="space-y-2 text-xs font-medium sm:col-span-2">Description<Input id="agent-description" value={agentForm.description} onChange={(event) => setAgentForm({ ...agentForm, description: event.target.value })} placeholder="What this agent owns" /></label>
            <label htmlFor="agent-instructions" className="space-y-2 text-xs font-medium sm:col-span-2">System instructions<Textarea id="agent-instructions" className="min-h-28" value={agentForm.systemPrompt} onChange={(event) => setAgentForm({ ...agentForm, systemPrompt: event.target.value })} /></label>
            <label htmlFor="agent-provider" className="space-y-2 text-xs font-medium">Provider<select id="agent-provider" className="h-8 w-full rounded-lg border border-input bg-background px-2.5 text-sm" value={agentForm.provider} onChange={(event) => setAgentForm({ ...agentForm, provider: event.target.value, model: event.target.value === 'openai' ? 'gpt-5.4-mini' : 'relay-sim-1' })}><option value="mock">Deterministic local</option><option value="openai">OpenAI compatible</option></select></label>
            <label htmlFor="agent-status" className="space-y-2 text-xs font-medium">Deployment status<select id="agent-status" className="h-8 w-full rounded-lg border border-input bg-background px-2.5 text-sm" value={agentForm.status} onChange={(event) => setAgentForm({ ...agentForm, status: event.target.value })}><option value="draft">Draft</option><option value="live">Live</option><option value="paused">Paused</option></select></label>
            <label htmlFor="agent-temperature" className="space-y-2 text-xs font-medium sm:col-span-2">Temperature · {agentForm.temperature.toFixed(1)}<input id="agent-temperature" type="range" min="0" max="2" step="0.1" value={agentForm.temperature} onChange={(event) => setAgentForm({ ...agentForm, temperature: Number(event.target.value) })} className="block w-full accent-[var(--primary)]" /></label>
          </div>
          <div className="rounded-xl border border-border bg-muted/30 p-4">
            <p className="text-xs font-semibold">Tool allowlist</p>
            <p className="mt-1 text-[11px] text-muted-foreground">The model sees only the capabilities selected here.</p>
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              {data?.tools.map((tool) => {
                const name = asText(tool.name);
                return <button key={name} type="button" onClick={() => toggleAgentTool(name)} className={`flex items-center justify-between rounded-lg border px-3 py-2 text-left text-xs transition-colors ${agentForm.allowedTools.includes(name) ? 'border-primary/40 bg-[#eef7f3] text-foreground' : 'border-border bg-background text-muted-foreground'}`}><span><strong className="block font-medium">{asText(tool.display_name)}</strong><span className="mt-0.5 block font-mono text-[10px]">{name}</span></span><span className={`grid size-5 place-items-center rounded-full ${agentForm.allowedTools.includes(name) ? 'bg-primary text-primary-foreground' : 'bg-muted'}`}>{agentForm.allowedTools.includes(name) && <CheckCircle2 className="size-3" />}</span></button>;
              })}
            </div>
          </div>
          <div className="rounded-xl border border-border bg-muted/30 p-4">
            <p className="text-xs font-semibold">Default guardrails</p>
            <div className="mt-3 grid gap-3 sm:grid-cols-3">
              {[
                ['redactPii', 'Redact PII'],
                ['blockPromptInjection', 'Block injection'],
                ['requireApprovalForWrites', 'Approve writes'],
              ].map(([key, label]) => (
                <label key={key} htmlFor={`guardrail-${key}`} className="flex items-center justify-between gap-2 text-xs text-muted-foreground">{label}<Switch id={`guardrail-${key}`} checked={agentForm.guardrails[key as keyof typeof agentForm.guardrails]} onCheckedChange={(checked) => setAgentForm({ ...agentForm, guardrails: { ...agentForm.guardrails, [key]: checked } })} /></label>
              ))}
            </div>
          </div>
          <DialogFooter><Button variant="outline" onClick={() => setAgentOpen(false)}>Cancel</Button><Button onClick={() => void createAgent()} disabled={busy || !agentForm.name.trim() || !agentForm.description.trim()}>{busy ? <RefreshCw className="animate-spin" /> : <Plus />}Create agent</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={toolOpen} onOpenChange={setToolOpen}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader><DialogTitle>Connect an HTTP tool</DialogTitle><DialogDescription>Expose a public HTTPS endpoint to agents. Private-network addresses are rejected by the runtime.</DialogDescription></DialogHeader>
          <div className="grid gap-4 sm:grid-cols-2">
            <label htmlFor="tool-name" className="space-y-2 text-xs font-medium">Function name<Input id="tool-name" value={toolForm.name} onChange={(event) => setToolForm({ ...toolForm, name: event.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_') })} placeholder="search_inventory" /></label>
            <label htmlFor="tool-display-name" className="space-y-2 text-xs font-medium">Display name<Input id="tool-display-name" value={toolForm.displayName} onChange={(event) => setToolForm({ ...toolForm, displayName: event.target.value })} placeholder="Inventory search" /></label>
            <label htmlFor="tool-description" className="space-y-2 text-xs font-medium sm:col-span-2">Description<Input id="tool-description" value={toolForm.description} onChange={(event) => setToolForm({ ...toolForm, description: event.target.value })} placeholder="Search current stock by SKU" /></label>
            <label htmlFor="tool-url" className="space-y-2 text-xs font-medium sm:col-span-2">HTTPS endpoint<Input id="tool-url" type="url" value={toolForm.url} onChange={(event) => setToolForm({ ...toolForm, url: event.target.value })} placeholder="https://api.example.com/agent-tool" /></label>
            <label htmlFor="tool-method" className="space-y-2 text-xs font-medium">Method<select id="tool-method" className="h-8 w-full rounded-lg border border-input bg-background px-2.5 text-sm" value={toolForm.method} onChange={(event) => setToolForm({ ...toolForm, method: event.target.value })}><option>POST</option><option>GET</option></select></label>
            <label htmlFor="tool-approval" className="flex items-end justify-between gap-3 rounded-lg border border-border px-3 py-2 text-xs font-medium">Require approval<Switch id="tool-approval" checked={toolForm.approvalRequired} onCheckedChange={(checked) => setToolForm({ ...toolForm, approvalRequired: checked })} /></label>
          </div>
          <DialogFooter><Button variant="outline" onClick={() => setToolOpen(false)}>Cancel</Button><Button onClick={() => void createTool()} disabled={busy || !toolForm.name || !toolForm.displayName || !toolForm.description || !toolForm.url}>{busy ? <RefreshCw className="animate-spin" /> : <Layers3 />}Connect tool</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={evaluationOpen} onOpenChange={setEvaluationOpen}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader><DialogTitle>Create an evaluation suite</DialogTitle><DialogDescription>Start with one deterministic case. More cases can be added through the evaluation API.</DialogDescription></DialogHeader>
          <div className="grid gap-4">
            <label htmlFor="eval-name" className="space-y-2 text-xs font-medium">Suite name<Input id="eval-name" value={evaluationForm.name} onChange={(event) => setEvaluationForm({ ...evaluationForm, name: event.target.value })} placeholder="Refund regression" /></label>
            <label htmlFor="eval-description" className="space-y-2 text-xs font-medium">Description<Input id="eval-description" value={evaluationForm.description} onChange={(event) => setEvaluationForm({ ...evaluationForm, description: event.target.value })} placeholder="Behavior required before the next release" /></label>
            <div className="grid gap-4 sm:grid-cols-2">
              <label htmlFor="eval-case-name" className="space-y-2 text-xs font-medium">Case name<Input id="eval-case-name" value={evaluationForm.caseName} onChange={(event) => setEvaluationForm({ ...evaluationForm, caseName: event.target.value })} placeholder="Eligible order" /></label>
              <label htmlFor="eval-grader" className="space-y-2 text-xs font-medium">Grader<select id="eval-grader" className="h-8 w-full rounded-lg border border-input bg-background px-2.5 text-sm" value={evaluationForm.graderType} onChange={(event) => setEvaluationForm({ ...evaluationForm, graderType: event.target.value })}><option value="contains">Must contain</option><option value="not_contains">Must not contain</option></select></label>
            </div>
            <label htmlFor="eval-input" className="space-y-2 text-xs font-medium">Test input<Textarea id="eval-input" value={evaluationForm.input} onChange={(event) => setEvaluationForm({ ...evaluationForm, input: event.target.value })} placeholder="Can I get a refund for order #A-1042?" /></label>
            <label htmlFor="eval-terms" className="space-y-2 text-xs font-medium">Expected terms, comma separated<Input id="eval-terms" value={evaluationForm.terms} onChange={(event) => setEvaluationForm({ ...evaluationForm, terms: event.target.value })} placeholder="refund, eligible" /></label>
          </div>
          <DialogFooter><Button variant="outline" onClick={() => setEvaluationOpen(false)}>Cancel</Button><Button onClick={() => void createEvaluation()} disabled={busy || !evaluationForm.name || !evaluationForm.description || !evaluationForm.caseName || !evaluationForm.input || !evaluationForm.terms}>{busy ? <RefreshCw className="animate-spin" /> : <FlaskConical />}Create suite</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </main>
  );
}

function WorkspaceView({ view, data, busy, setRunOpen, setRunResult, setView, runEvaluation, decideApproval }: {
  view: View;
  data: Overview;
  busy: boolean;
  setRunOpen: (open: boolean) => void;
  setRunResult: (result: RunResult | null) => void;
  setView: (view: View) => void;
  runEvaluation: (id: string) => Promise<void>;
  decideApproval: (id: string, decision: 'approved' | 'rejected') => Promise<void>;
}) {
  if (view === 'Agents') return <AgentsView agents={data.agents} onRun={() => { setRunResult(null); setRunOpen(true); }} />;
  if (view === 'Runs') return <RunsView runs={data.runs} />;
  if (view === 'Tools') return <ToolsView tools={data.tools} />;
  if (view === 'Evaluations') return <EvaluationsView evaluations={data.evaluations} busy={busy} onRun={runEvaluation} />;
  if (view === 'Guardrails') return <GuardrailsView approvals={data.approvals} busy={busy} onDecision={decideApproval} />;
  return <OverviewView data={data} setView={setView} />;
}

function OverviewView({ data, setView }: { data: Overview; setView: (view: View) => void }) {
  const latestRun = data.runs[0];
  const metrics = [
    ['Total runs', String(data.metrics.totalRuns), Activity],
    ['Success rate', `${data.metrics.successRate}%`, CheckCircle2],
    ['Median latency', data.metrics.medianLatencyMs ? `${data.metrics.medianLatencyMs}ms` : '—', Clock3],
    ['Pending approvals', String(data.metrics.pendingApprovals), ShieldCheck],
  ] as const;
  return <>
    <div className="mt-7 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {metrics.map(([label, value, Icon]) => <article key={label} className="rounded-xl border border-border bg-card px-4 py-4 shadow-[0_1px_2px_rgba(12,23,20,.03)]"><div className="flex items-center justify-between"><p className="text-xs font-medium text-muted-foreground">{label}</p><Icon className="size-4 text-primary" /></div><strong className="mt-2 block text-2xl font-semibold tracking-[-0.035em]">{value}</strong></article>)}
    </div>
    <div className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1.55fr)_minmax(300px,.75fr)]">
      <article className="overflow-hidden rounded-2xl border border-border bg-card shadow-[0_8px_30px_rgba(18,36,31,.05)]">
        <div className="flex items-center justify-between border-b border-border px-5 py-4"><div><div className="flex items-center gap-2"><h2 className="text-sm font-semibold">{asText(data.agents[0]?.name, 'No agent')}</h2><StatusBadge status={asText(data.agents[0]?.status, 'draft')} /></div><p className="mt-1 text-xs text-muted-foreground">{asText(data.agents[0]?.model)}</p></div><Button variant="outline" onClick={() => setView('Agents')}>Configure <ChevronRight /></Button></div>
        <div className="p-5 md:p-6">
          {latestRun ? <><div className="flex items-center justify-between"><div><p className="text-xs text-muted-foreground">Latest run</p><p className="mt-1 text-sm font-semibold">{asText(latestRun.input)}</p></div><StatusBadge status={asText(latestRun.status)} /></div><div className="mt-5 rounded-xl border border-border bg-muted/30 p-4 text-sm leading-6">{asText(latestRun.output, 'Run in progress…')}</div><div className="mt-4 flex gap-5 text-xs text-muted-foreground"><span>{Number(latestRun.latency_ms ?? 0)}ms</span><span>${Number(latestRun.estimated_cost_usd ?? 0).toFixed(4)}</span><span className="font-mono">{asText(latestRun.id).slice(0, 18)}</span></div></> : <EmptyState title="No runs yet" copy="Execute the reference agent to create your first production trace." />}
        </div>
      </article>
      <aside className="rounded-2xl border border-border bg-card p-5 shadow-[0_8px_30px_rgba(18,36,31,.05)]"><p className="text-xs font-medium text-muted-foreground">Release gate</p><h2 className="mt-1 text-sm font-semibold">{asText(data.evaluations[0]?.name, 'Evaluation suite')}</h2><div className="mt-6 flex items-end gap-3"><strong className="text-4xl font-semibold tracking-[-0.05em]">{data.evaluations[0]?.latest_score == null ? '—' : asText(data.evaluations[0]?.latest_score)}</strong><span className="pb-1 text-xs text-muted-foreground">/ 100</span></div><p className="mt-4 text-xs leading-5 text-muted-foreground">{Number(data.evaluations[0]?.case_count ?? 0)} deterministic scenarios protect this deployment.</p><Button variant="outline" className="mt-6 w-full" onClick={() => setView('Evaluations')}>Open evaluation <ChevronRight /></Button></aside>
    </div>
  </>;
}

function AgentsView({ agents, onRun }: { agents: Overview['agents']; onRun: () => void }) {
  return <div className="mt-7 grid gap-4 lg:grid-cols-2">{agents.map((agent) => <article key={String(agent.id)} className="rounded-2xl border border-border bg-card p-5 shadow-sm"><div className="flex items-start justify-between"><div className="grid size-10 place-items-center rounded-xl bg-[#e1f0eb] text-primary"><Bot className="size-5" /></div><StatusBadge status={String(agent.status)} /></div><h2 className="mt-5 text-base font-semibold">{String(agent.name)}</h2><p className="mt-2 min-h-10 text-sm leading-5 text-muted-foreground">{String(agent.description)}</p><div className="mt-5 flex items-center justify-between border-t border-border pt-4"><div><p className="text-[10px] uppercase tracking-wider text-muted-foreground">Model</p><p className="mt-1 font-mono text-xs">{String(agent.model)}</p></div><Button onClick={onRun}><Play className="fill-current" />Run</Button></div></article>)}</div>;
}

function RunsView({ runs }: { runs: Overview['runs'] }) {
  return <div className="mt-7 overflow-hidden rounded-2xl border border-border bg-card"><Table><TableHeader><TableRow><TableHead>Run</TableHead><TableHead>Agent</TableHead><TableHead>Status</TableHead><TableHead>Latency</TableHead><TableHead>Created</TableHead></TableRow></TableHeader><TableBody>{runs.map((run) => <TableRow key={String(run.id)}><TableCell><p className="max-w-[320px] truncate font-medium">{String(run.input)}</p><p className="mt-1 font-mono text-[10px] text-muted-foreground">{String(run.id)}</p></TableCell><TableCell>{String(run.agent_name)}</TableCell><TableCell><StatusBadge status={String(run.status)} /></TableCell><TableCell className="font-mono text-xs">{Number(run.latency_ms ?? 0)}ms</TableCell><TableCell className="text-xs text-muted-foreground">{formatDate(run.created_at)}</TableCell></TableRow>)}</TableBody></Table>{!runs.length && <EmptyState title="No stored runs" copy="Run an agent to see traces and outcomes here." />}</div>;
}

function ToolsView({ tools }: { tools: Overview['tools'] }) {
  return <div className="mt-7 grid gap-4 md:grid-cols-2 xl:grid-cols-3">{tools.map((tool) => <article key={String(tool.id)} className="rounded-2xl border border-border bg-card p-5"><div className="flex items-center justify-between"><div className="grid size-10 place-items-center rounded-xl bg-muted text-primary"><Boxes className="size-5" /></div><Badge variant="outline">{String(tool.kind)}</Badge></div><h2 className="mt-5 text-sm font-semibold">{String(tool.display_name)}</h2><p className="mt-2 min-h-10 text-xs leading-5 text-muted-foreground">{String(tool.description)}</p><div className="mt-4 flex items-center justify-between border-t border-border pt-4 text-xs"><span className="font-mono text-muted-foreground">{String(tool.name)}</span>{tool.approval_required ? <Badge className="bg-amber-100 text-amber-800">Approval</Badge> : <Badge className="bg-emerald-100 text-emerald-800">Read only</Badge>}</div></article>)}</div>;
}

function EvaluationsView({ evaluations, busy, onRun }: { evaluations: Overview['evaluations']; busy: boolean; onRun: (id: string) => Promise<void> }) {
  return <div className="mt-7 space-y-4">{evaluations.map((suite) => <article key={String(suite.id)} className="flex flex-col gap-5 rounded-2xl border border-border bg-card p-5 sm:flex-row sm:items-center sm:justify-between"><div><div className="flex items-center gap-2"><FlaskConical className="size-4 text-primary" /><h2 className="font-semibold">{String(suite.name)}</h2></div><p className="mt-2 text-sm text-muted-foreground">{String(suite.description)}</p><p className="mt-3 text-xs text-muted-foreground">{Number(suite.case_count)} cases · Latest score {suite.latest_score == null ? 'not run' : `${asText(suite.latest_score)}/100`}</p></div><Button onClick={() => void onRun(String(suite.id))} disabled={busy}>{busy ? <RefreshCw className="animate-spin" /> : <Play className="fill-current" />}Run suite</Button></article>)}</div>;
}

function GuardrailsView({ approvals, busy, onDecision }: { approvals: Overview['approvals']; busy: boolean; onDecision: (id: string, decision: 'approved' | 'rejected') => Promise<void> }) {
  return <div className="mt-7 space-y-4">{approvals.length ? approvals.map((approval) => <article key={String(approval.id)} className="rounded-2xl border border-amber-200 bg-amber-50/50 p-5"><div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between"><div><Badge className="bg-amber-100 text-amber-800">Action pending</Badge><h2 className="mt-3 font-semibold">{String(approval.tool_name)} requested by {String(approval.agent_name)}</h2><p className="mt-2 font-mono text-xs text-muted-foreground">{String(approval.arguments_json)}</p></div><div className="flex gap-2"><Button variant="outline" disabled={busy} onClick={() => void onDecision(String(approval.id), 'rejected')}>Reject</Button><Button disabled={busy} onClick={() => void onDecision(String(approval.id), 'approved')}>Approve</Button></div></div></article>) : <div className="rounded-2xl border border-border bg-card"><EmptyState title="Approval queue is clear" copy="Mutating tools appear here before they can change external state." /></div>}</div>;
}

function RunResultCard({ result }: { result: RunResult }) {
  return <div className="rounded-xl border border-border bg-muted/25 p-4"><div className="flex items-center justify-between"><StatusBadge status={result.status} /><span className="font-mono text-xs text-muted-foreground">{result.latencyMs}ms</span></div><p className="mt-3 text-sm leading-6">{result.output}</p><div className="mt-4 space-y-2 border-t border-border pt-3">{result.steps.map((item) => <div key={item.id} className="flex items-center gap-2 text-xs"><CheckCircle2 className={`size-3.5 ${item.status === 'pending' ? 'text-amber-600' : 'text-emerald-600'}`} /><span className="font-medium">{item.name}</span><span className="ml-auto text-muted-foreground">{item.kind} · {item.durationMs}ms</span></div>)}</div></div>;
}

function Brand({ compact = false }: { compact?: boolean }) {
  return <div className="flex h-10 items-center gap-2.5 px-2"><div className="grid size-8 place-items-center rounded-[10px] bg-primary text-primary-foreground shadow-[0_7px_18px_rgba(24,77,66,.25)]"><Workflow className="size-4" strokeWidth={2.2} /></div>{!compact && <div><p className="text-sm font-semibold tracking-[-0.02em]">Relay</p><p className="text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground">Agent operations</p></div>}</div>;
}

function StatusBadge({ status }: { status: string }) {
  const style = status === 'succeeded' || status === 'live' || status === 'completed' ? 'bg-emerald-100 text-emerald-800' : status === 'waiting_approval' || status === 'pending' ? 'bg-amber-100 text-amber-800' : status === 'failed' ? 'bg-red-100 text-red-800' : 'bg-muted text-muted-foreground';
  return <Badge className={style}>{status.replace('_', ' ')}</Badge>;
}

function EmptyState({ title, copy }: { title: string; copy: string }) { return <div className="px-5 py-12 text-center"><div className="mx-auto grid size-10 place-items-center rounded-xl bg-muted text-muted-foreground"><Workflow className="size-5" /></div><p className="mt-4 text-sm font-semibold">{title}</p><p className="mx-auto mt-2 max-w-sm text-xs leading-5 text-muted-foreground">{copy}</p></div>; }
function LoadingGrid() { return <div className="mt-7 grid gap-4 md:grid-cols-3">{[1, 2, 3].map((item) => <div key={item} className="h-40 animate-pulse rounded-2xl bg-muted" />)}</div>; }
function navClass(active: boolean) { return `flex h-9 w-full items-center gap-3 rounded-lg px-3 text-left text-sm transition-colors ${active ? 'bg-sidebar-accent font-medium text-sidebar-accent-foreground' : 'text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground'}`; }
function initials(email?: string) { return (email?.slice(0, 2) ?? 'RL').toUpperCase(); }
function formatDate(value: unknown) { const date = new Date(Number(value)); return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); }
function asText(value: unknown, fallback = '') { return typeof value === 'string' || typeof value === 'number' ? String(value) : fallback; }
