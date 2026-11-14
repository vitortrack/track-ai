import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import * as vscode from 'vscode';
import type { AgentUI } from '../../src/agent-ui.js';
import { bestOf } from '../../src/attempts.js';
import { orchestrate } from '../../src/orchestrator.js';
import { DEFAULT_EMBED_MODEL, DEFAULT_MODEL, Session, type Config, type ProviderName } from '../../src/session.js';
import { SessionStore } from '../../src/sessions.js';
import { findSkills, skillCommand } from '../../src/skills.js';
import { THINKING_WORDS } from '../../src/thinking-words.js';
import type { Decision, Mode, PlanItem } from '../../src/tools.js';
import type { Image } from '../../src/types.js';

type Message = Record<string, unknown>;
type Post = (message: Message) => void;
type Pending = Map<string, (decision: Decision) => void>;

const STOP_PREFIXES = ['Interrompido', 'Limite', 'Orçamento', 'O modelo recusou'];

class WebviewUI implements AgentUI {
  constructor(
    private readonly post: Post,
    private readonly pending: Pending,
    private readonly agent = '',
  ) {}

  readonly text = (delta: string): void => {
    if (!this.agent && delta) this.post({ type: 'text', delta });
  };

  readonly thinking = (delta: string): void => {
    if (!this.agent && delta) this.post({ type: 'thinking', delta });
  };

  tool(name: string, args: string): void {
    this.post({ type: 'tool', agent: this.agent, name, args });
  }

  observation(ok: boolean, output: string): void {
    this.post({ type: 'observation', agent: this.agent, ok, output: output.slice(0, 6000) });
  }

  plan(items: PlanItem[]): void {
    this.post({ type: 'plan', items });
  }

  phase(title: string): void {
    this.post({ type: 'phase', title });
  }

  info(message: string): void {
    this.post({ type: 'info', agent: this.agent, message });
  }

  warn(message: string): void {
    this.post({ type: 'warn', agent: this.agent, message });
  }

  error(message: string): void {
    this.post({ type: 'error', message });
  }

  final(text: string): void {
    this.post({ type: 'final', text });
  }

  confirm(question: string, signal: AbortSignal, alwaysLabel?: string): Promise<Decision> {
    const id = randomUUID();
    this.post({ type: 'confirm', id, question, agent: this.agent, alwaysLabel: alwaysLabel ?? null });
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        this.pending.delete(id);
        this.post({ type: 'confirmClosed', id });
        reject(new Error('Interrompido pelo usuário.'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      this.pending.set(id, (decision) => {
        signal.removeEventListener('abort', onAbort);
        this.pending.delete(id);
        resolve(decision);
      });
    });
  }

  child(label: string): AgentUI {
    return new WebviewUI(this.post, this.pending, label);
  }
}

function readConfig(root: string): Config {
  const c = vscode.workspace.getConfiguration('alien');
  const chosen = c.get<string>('provider', 'auto');
  const provider: ProviderName = chosen === 'ollama' || chosen === 'anthropic' ? chosen : hasAnthropicKey() ? 'anthropic' : 'ollama';
  process.env.OLLAMA_HOST = c.get<string>('ollamaHost', 'http://localhost:11434');
  return {
    provider,
    model: c.get<string>('model', '') || DEFAULT_MODEL[provider],
    mode: c.get<Mode>('mode', 'ask'),
    root,
    maxSteps: c.get<number>('maxSteps', 0),
    reviewModel: c.get<string>('reviewModel', '') || undefined,
    review: c.get<boolean>('review', false) || Boolean(c.get<string>('reviewModel', '')),
    effort: 'high',
    numCtx: 65536,
    embedModel: c.get<string>('embedModel', DEFAULT_EMBED_MODEL),
    tokenBudget: 0,
    lang: c.get<string>('lang', 'pt-BR'),
    interactive: true,
    logDir: Session.defaultLogDir(),
  };
}

const OPEN_SESSION = 'alien.openSession';

const statusText = (cfg: Config): string => `${cfg.provider} · ${cfg.model} · ${cfg.mode}`;

type Attachment = { name: string; mime: string; data: string };

function saveAttachments(root: string, list: Attachment[]): { lines: string[]; images: Image[] } {
  const dir = path.join(root, '.alien', 'attachments');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.gitignore'), '*\n');
  const lines = list.map((a) => {
    const file = path.join(dir, `${Date.now()}-${path.basename(a.name).replace(/[^\w.-]/g, '_')}`);
    fs.writeFileSync(file, Buffer.from(a.data, 'base64'));
    return `- ${path.relative(root, file)} (${a.mime || 'tipo desconhecido'})`;
  });
  return { lines, images: list.filter((a) => a.mime.startsWith('image/')).map((a) => ({ mime: a.mime, data: a.data })) };
}

async function hasVision(model: string): Promise<boolean> {
  try {
    const res = await fetch(`${process.env.OLLAMA_HOST}/api/show`, { method: 'POST', body: JSON.stringify({ model }) });
    return ((await res.json()) as { capabilities?: string[] }).capabilities?.includes('vision') ?? false;
  } catch {
    return false;
  }
}

const hasAnthropicKey = (): boolean => Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
const CLAUDE_MODELS = hasAnthropicKey() ? ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'] : [];

async function localModels(current: string): Promise<string[]> {
  try {
    const res = await fetch(`${process.env.OLLAMA_HOST}/api/tags`);
    const body = (await res.json()) as { models?: { name: string; details?: { family?: string } }[] };
    const names = (body.models ?? []).filter((m) => !/embed/i.test(m.name) && !/bert/i.test(m.details?.family ?? '')).map((m) => m.name);
    return [...new Set([current, ...names, ...CLAUDE_MODELS])].sort();
  } catch {
    return [...new Set([current, ...CLAUDE_MODELS])].sort();
  }
}

class ChatViewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  private session: Session | undefined;
  private plainRun = false;
  private readonly pending: Pending = new Map();

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly state: vscode.Memento,
  ) {}

  private readonly post: Post = (message) => {
    void this.view?.webview.postMessage(message);
  };

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const media = vscode.Uri.joinPath(this.extensionUri, 'media');
    view.webview.options = { enableScripts: true, localResourceRoots: [media] };
    view.webview.html = this.html(view.webview, media);
    view.webview.onDidReceiveMessage((m: Message) => void this.onMessage(m));
  }

  private html(webview: vscode.Webview, media: vscode.Uri): string {
    const nonce = randomUUID().replace(/-/g, '');
    const script = webview.asWebviewUri(vscode.Uri.joinPath(media, 'chat.js'));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(media, 'chat.css'));
    return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${style}">
<title>Alien</title>
</head>
<body>
<div id="status"></div>
<div id="plan" hidden></div>
<main id="messages">
  <div class="welcome">
    <h2>Alien</h2>
    <p>Pergunte sobre o código ou peça uma alteração. Ele investiga, altera, verifica e passa por um revisor independente.</p>
    <p class="hint">Enter envia · Shift+Enter quebra linha · referências <code>arquivo:linha</code> abrem no editor</p>
  </div>
  <div id="working" hidden></div>
</main>
<form id="composer">
  <div id="attachments" hidden></div>
  <div id="slash" role="listbox" hidden></div>
  <textarea id="input" rows="3" placeholder="Pergunte ou peça uma tarefa… (cole um print com Ctrl+V ou arraste arquivos)"></textarea>
  <div class="actions">
    <input type="file" id="file" multiple hidden>
    <button type="button" id="attach" class="secondary" title="Anexar arquivos ou imagens" aria-label="Anexar arquivos">📎</button>
    <label class="toggle"><input type="checkbox" id="orchestrate"> multiagente</label>
    <label class="toggle" title="Roda 3 tentativas isoladas e aplica a que passa nos testes com o menor diff (3× mais tokens)"><input type="checkbox" id="best3"> melhor de 3</label>
    <span class="spacer"></span>
    <select id="model" title="Modelo do Ollama (lista os modelos instalados nesta máquina)" aria-label="Modelo"></select>
    <button type="button" id="stop" hidden>Parar</button>
    <button type="submit" id="send">Enviar</button>
  </div>
</form>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }

  newChat(): void {
    this.session?.abort();
    this.session = undefined;
    void this.state.update(OPEN_SESSION, undefined);
    this.post({ type: 'cleared' });
  }

  private restore(root: string): void {
    const id = this.state.get<string>(OPEN_SESSION);
    if (!this.session && id) {
      const saved = new SessionStore(root).load(id);
      const session = saved && this.ensureSession();
      if (saved && session && session.resume(saved) !== null) this.session = undefined;
    }
    const session = this.session;
    if (session?.turns.length) this.post({ type: 'restored', id: session.id, turns: session.turns, plan: session.plan });
  }

  private ensureSession(): Session | null {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) {
      this.post({ type: 'error', message: 'Abra uma pasta no VS Code para o Alien trabalhar nela.' });
      return null;
    }
    const cfg = readConfig(root);
    const current = this.session?.cfg;
    if (!this.session || current?.root !== root || current.provider !== cfg.provider || current.model !== cfg.model || current.embedModel !== cfg.embedModel) {
      const previous = this.session;
      this.session = new Session(cfg, new WebviewUI(this.post, this.pending));
      if (previous?.turns.length && current?.root === root && current.provider === cfg.provider) {
        previous.save();
        const saved = previous.sessions.load(previous.id);
        if (saved) this.session.resume(saved);
        for (const name of previous.activeSkills) this.session.activeSkills.add(name);
      }
    } else {
      Object.assign(this.session.cfg, { mode: cfg.mode, lang: cfg.lang, review: cfg.review, reviewModel: cfg.reviewModel, maxSteps: cfg.maxSteps });
    }
    return this.session;
  }

  private async onMessage(m: Message): Promise<void> {
    switch (m.type) {
      case 'ready': {
        this.post({ type: 'words', words: THINKING_WORDS });
        const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (root) {
          const cfg = readConfig(root);
          this.post({ type: 'status', text: statusText(cfg) });
          this.post({ type: 'models', models: await localModels(cfg.model), current: cfg.model });
          this.post({ type: 'skills', skills: findSkills(root).map(({ name, description }) => ({ name, description })) });
          this.restore(root);
        }
        return;
      }
      case 'setModel':
        return this.setModel(String(m.model ?? ''));
      case 'send':
        return this.send(String(m.text ?? ''), m.orchestrate === true, m.best3 === true, Array.isArray(m.attachments) ? (m.attachments as Attachment[]) : []);
      case 'stop':
        this.session?.abort();
        return;
      case 'confirmResult':
        this.pending.get(String(m.id))?.(m.decision === 'always' ? 'always' : m.decision === 'yes' ? 'yes' : 'no');
        return;
      case 'open':
        return this.open(String(m.file), Number(m.line));
      case 'newChat':
        this.newChat();
        return;
    }
  }

  private async setModel(model: string): Promise<void> {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!model || !root || this.session?.busy) return;
    const config = vscode.workspace.getConfiguration('alien');
    const provider: ProviderName = CLAUDE_MODELS.includes(model) ? 'anthropic' : 'ollama';
    if (readConfig(root).provider !== provider) await config.update('provider', provider, vscode.ConfigurationTarget.Global);
    await config.update('model', model, vscode.ConfigurationTarget.Global);
    if (this.session) this.ensureSession();
    const cfg = readConfig(root);
    this.post({ type: 'status', text: statusText(cfg) });
  }

  private async send(text: string, viaOrchestrator: boolean, best3: boolean, attachments: Attachment[]): Promise<void> {
    let task = text.trim();
    if (!task && !attachments.length) return;
    const session = this.ensureSession();
    if (!session) return;
    task = skillCommand(session.skills, session.activeSkills, task) ?? task;
    if (session.busy) {
      if (!this.plainRun || attachments.length || viaOrchestrator || best3) {
        this.post({ type: 'warn', message: 'Aguarde a tarefa atual terminar ou clique em Parar.' });
        return;
      }
      session.queue(task);
      this.post({ type: 'info', message: 'Mensagem entregue ao agente no próximo passo.' });
      return;
    }
    const { lines, images } = saveAttachments(session.cfg.root, attachments);
    if (lines.length) task = `${task || 'Analise os arquivos anexados.'}\n\nFiles attached by the user (read them; images are also shown to you when the model has vision; for a PDF run: pdftotext <file> -):\n${lines.join('\n')}`;
    if (images.length && session.cfg.provider === 'ollama' && !(await hasVision(session.cfg.model))) {
      this.post({ type: 'warn', message: `O modelo ${session.cfg.model} não lê imagens: ele recebe só o caminho do arquivo. Para interpretar o print, escolha um modelo com visão no seletor (ex.: glm-5.3-flash:cloud).` });
    }
    this.post({ type: 'status', text: statusText(session.cfg) });
    this.post({ type: 'busy', value: true });
    const start = { ...session.usage };
    const tokens = () => this.post({ type: 'tokens', input: session.usage.input - start.input, output: session.usage.output - start.output });
    const timer = setInterval(tokens, 1000);
    let report: Message;
    try {
      let out: string;
      if (viaOrchestrator) out = await orchestrate(session, task);
      else if (best3) {
        const result = await session.track(() => bestOf(session.cfg, session.ui, task, 3, undefined, session.signal));
        session.addUsage(result.usage);
        out = result.answer;
      } else {
        this.plainRun = true;
        out = await session.run(task, images).finally(() => (this.plainRun = false));
        void this.state.update(OPEN_SESSION, session.id);
      }
      if (STOP_PREFIXES.some((p) => out.startsWith(p))) report = { type: 'warn', message: out };
      else report = { type: 'answer', text: out };
    } catch (e) {
      report = { type: 'error', message: e instanceof Error ? e.message : String(e) };
    }
    clearInterval(timer);
    tokens();
    this.post(report);
    const cost = session.costUsd();
    this.post({ type: 'usage', input: session.usage.input, output: session.usage.output, cost });
    this.post({ type: 'busy', value: false });
    const leftover = session.takeQueued();
    if (leftover.length && report.type === 'answer') await this.send(leftover.join('\n\n'), false, false, []);
  }

  private async open(file: string, line: number): Promise<void> {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) return;
    const target = path.resolve(root, file);
    const rel = path.relative(root, target);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return;
    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(target));
      const position = new vscode.Position(Math.max(0, (line || 1) - 1), 0);
      await vscode.window.showTextDocument(doc, { selection: new vscode.Range(position, position), preview: true });
    } catch {
      const matches = await vscode.workspace.findFiles(`**/${file}`, '**/node_modules/**', 1);
      const found = matches[0];
      if (!found) {
        void vscode.window.showWarningMessage(`Alien: arquivo ${file} não encontrado no workspace.`);
        return;
      }
      const doc = await vscode.workspace.openTextDocument(found);
      const position = new vscode.Position(Math.max(0, (line || 1) - 1), 0);
      await vscode.window.showTextDocument(doc, { selection: new vscode.Range(position, position), preview: true });
    }
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const provider = new ChatViewProvider(context.extensionUri, context.workspaceState);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('alien.chat', provider, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.commands.registerCommand('alien.newChat', () => provider.newChat()),
    vscode.commands.registerCommand('alien.focus', () => vscode.commands.executeCommand('alien.chat.focus')),
  );
}

export function deactivate(): void {}
