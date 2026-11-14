import fs from 'node:fs';
import path from 'node:path';
import { Agent } from './agent.js';
import type { Criterion } from './contract.js';
import { MemoryStore } from './memory.js';
import { findSkills, type Skill } from './skills.js';
import { reviewSkills, type ReviewInput } from './skill-review.js';
import type { Role } from './prompts.js';
import { AnthropicProvider, type Effort } from './providers/anthropic.js';
import { alienHome } from './paths.js';
import { OllamaProvider } from './providers/ollama.js';
import { CodeIndex, Embedder } from './rag.js';
import { workspaceDiff } from './scope.js';
import { newSessionId, SessionStore, type SavedSession, type Turn } from './sessions.js';
import { allowsTestEdits, clip, type Mode, type PlanItem, type ToolContext } from './tools.js';
import type { Provider, Usage, Image } from './types.js';
import type { AgentUI } from './agent-ui.js';

export type ProviderName = 'ollama' | 'anthropic';

export const DEFAULT_MODEL: Record<ProviderName, string> = {
  ollama: 'glm-5.3-flash:cloud',
  anthropic: 'claude-opus-5-5',
};

export const DEFAULT_EMBED_MODEL = 'qwen3-embedding:0.6b';

export interface Config {
  provider: ProviderName;
  model: string;
  mode: Mode;
  root: string;
  maxSteps: number;
  review: boolean;
  reviewModel?: string;
  effort: Effort;
  numCtx: number;
  embedModel: string;
  tokenBudget: number;
  lang: string;
  interactive?: boolean;
  logDir: string | null;
  tools?: string[];
  handoff?: string;
  harness?: string;
  gate?: Criterion[];
}

const PRICE_PER_MTOK: Record<string, [number, number]> = {
  'claude-fable-5-1': [10, 50],
  'claude-opus-5-5': [4, 20],
  'claude-sonnet-5-5': [2, 10],
  'claude-haiku-5-5': [0.1, 0.5],
};

export type ProviderFactory = (model?: string) => Provider;

export interface Verdict {
  approved: boolean;
  feedback: string;
}

function defaultFactory(cfg: Config): ProviderFactory {
  return (model) => {
    const name = model ?? cfg.model;
    const anthropic = model ? name.startsWith('claude-') : cfg.provider === 'anthropic';
    return anthropic ? new AnthropicProvider(name, cfg.effort) : new OllamaProvider(name, cfg.numCtx);
  };
}

export class Session {
  readonly usage: Usage = { input: 0, output: 0 };
  plan: PlanItem[] = [];
  busy = false;
  private controller = new AbortController();
  private main: Agent;
  private spawned = 0;
  private readonly logFile: string | null;
  readonly codeIndex: CodeIndex;
  readonly memory: MemoryStore;
  readonly skills: Skill[];
  readonly activeSkills = new Set<string>();
  readonly allowed = new Set<string>();
  readonly sessions: SessionStore;
  id = newSessionId();
  turns: Turn[] = [];
  readonly testOriginals = new Map<string, string | null>();
  private created = new Date().toISOString();
  reviewing: Promise<void> = Promise.resolve();
  private queued: string[] = [];
  private injected: string[] = [];

  constructor(
    readonly cfg: Config,
    readonly ui: AgentUI,
    private readonly makeProvider: ProviderFactory = defaultFactory(cfg),
  ) {
    const embedder = new Embedder(cfg.embedModel);
    this.codeIndex = new CodeIndex(cfg.root, embedder);
    this.memory = new MemoryStore(cfg.root, embedder);
    this.skills = findSkills(cfg.root);
    this.sessions = new SessionStore(cfg.root);
    this.main = new Agent(this, 'main', ui);
    this.logFile = cfg.logDir ? path.join(cfg.logDir, `${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`) : null;
    if (cfg.logDir) fs.mkdirSync(cfg.logDir, { recursive: true });
  }

  static defaultLogDir(): string {
    return path.join(alienHome(), 'sessions');
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get logPath(): string | null {
    return this.logFile;
  }

  newProvider(model?: string): Provider {
    return this.makeProvider(model);
  }

  context(ui: AgentUI, files: Map<string, number> = new Map(), task = ''): ToolContext {
    const session = this;
    return {
      root: session.cfg.root,
      get mode() {
        return session.cfg.mode;
      },
      get signal() {
        return session.signal;
      },
      testEditsAllowed: allowsTestEdits(task),
      testOriginals: session.testOriginals,
      codeIndex: session.codeIndex,
      memory: session.memory,
      skills: session.skills,
      files,
      allowed: session.allowed,
      confirm: (question, alwaysLabel) => ui.confirm(question, session.signal, alwaysLabel),
      setPlan: (plan) => session.setPlan(plan, ui),
      delegate: (role, task) => session.spawn(role, task, ui),
    };
  }

  setPlan(plan: PlanItem[], ui: AgentUI = this.ui): void {
    this.plan = plan;
    ui.plan(plan);
  }

  addUsage(u: Usage): void {
    this.usage.input += u.input;
    this.usage.output += u.output;
    this.log({ event: 'usage', step: u, total: this.usage, costUsd: this.costUsd() });
  }

  costUsd(): number | null {
    if (this.cfg.provider !== 'anthropic') return 0;
    const price = PRICE_PER_MTOK[this.cfg.model];
    if (!price) return null;
    return (this.usage.input * price[0] + this.usage.output * price[1]) / 1_000_000;
  }

  overBudget(): boolean {
    return this.cfg.tokenBudget > 0 && this.usage.input + this.usage.output >= this.cfg.tokenBudget;
  }

  log(entry: Record<string, unknown>): void {
    if (!this.logFile) return;
    fs.appendFileSync(this.logFile, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
  }

  async spawn(role: Role, task: string, parent: AgentUI = this.ui, model?: string): Promise<string> {
    const ui = parent.child(`${role}#${++this.spawned}`);
    ui.info(`início: ${clip(task.replace(/\s+/g, ' '), 140)}`);
    const report = await new Agent(this, role, ui, model).run(task);
    ui.info(`fim: ${clip(report.replace(/\s+/g, ' '), 240)}`);
    return report;
  }

  async review(goal: string, parent: AgentUI = this.ui): Promise<Verdict> {
    const diff = await workspaceDiff(this.cfg.root);
    const evidence = diff
      ? `The current changes (git diff HEAD plus the full content of new files) are below, so you do not need to run git diff or re-read the new files. Read surrounding code only where you need it, then verify.\n\`\`\`diff\n${diff}\n\`\`\``
      : 'Start with git status and git diff (including untracked files), then inspect and verify.';
    const task = `The user asked for:\n${goal}\n\nAnother agent says it is done. You get no explanation from it on purpose: judge only the request and the actual changes. ${evidence}`;
    const feedback = await this.spawn('critic', task, parent, this.cfg.reviewModel);
    const verdict = /<evaluation>\s*(\w+)\s*<\/evaluation>/.exec(feedback)?.[1];
    return { approved: verdict === 'PASS', feedback: /<feedback>([\s\S]*?)<\/feedback>/.exec(feedback)?.[1]?.trim() || feedback };
  }

  reviewSkills(input: Omit<ReviewInput, 'turns'>): void {
    if (process.env.ALIEN_USER_SKILLS === 'off') return;
    const signal = this.signal;
    const turns = [...this.turns];
    this.reviewing = this.reviewing
      .then(() => reviewSkills(this.newProvider(), this.skills, { ...input, turns }, signal))
      .then(({ usage, saved }) => {
        this.addUsage(usage);
        this.log({ event: 'skill-review', saved });
      })
      .catch((e: unknown) => this.log({ event: 'skill-review-failed', error: e instanceof Error ? e.message : String(e) }));
  }

  queue(text: string): void {
    this.queued.push(text);
  }

  takeQueued(): string[] {
    const taken = this.queued.splice(0);
    this.injected.push(...taken);
    return taken;
  }

  run(task: string, images: Image[] = []): Promise<string> {
    return this.track(async () => {
      this.injected = [];
      const answer = await this.main.run(task, images);
      this.turns.push({ task: [task, ...this.injected].join('\n\n'), answer });
      this.save();
      return answer;
    });
  }

  save(): void {
    try {
      this.sessions.save({
        id: this.id,
        title: this.turns[0]?.task.slice(0, 80) ?? '',
        created: this.created,
        updated: new Date().toISOString(),
        provider: this.cfg.provider,
        model: this.cfg.model,
        turns: this.turns,
        plan: this.plan,
        usage: this.usage,
        history: this.main.snapshot(),
      });
    } catch (e) {
      this.ui.warn(`não foi possível salvar a sessão: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  resume(saved: SavedSession): string | null {
    if (saved.provider !== this.cfg.provider) {
      return `A sessão ${saved.id} foi feita com ${saved.provider}; use --provider ${saved.provider} para retomá-la.`;
    }
    this.main = new Agent(this, 'main', this.ui);
    this.main.restore(saved.history);
    this.id = saved.id;
    this.created = saved.created;
    this.turns = [...saved.turns];
    this.plan = saved.plan;
    Object.assign(this.usage, saved.usage);
    return null;
  }

  fork(): void {
    this.id = newSessionId();
    this.created = new Date().toISOString();
    this.save();
  }

  async track<T>(work: () => Promise<T>): Promise<T> {
    this.busy = true;
    this.controller = new AbortController();
    try {
      return await work();
    } finally {
      this.busy = false;
    }
  }

  abort(): void {
    this.controller.abort();
  }

  reset(): void {
    this.main = new Agent(this, 'main', this.ui);
    this.plan = [];
    this.allowed.clear();
    this.id = newSessionId();
    this.created = new Date().toISOString();
    this.turns = [];
    this.testOriginals.clear();
  }
}
