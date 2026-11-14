import { randomUUID } from 'node:crypto';
import type { Provider, StepRequest, StepResult, ToolCall, ToolResult, ToolSpec, Usage, Image } from '../types.js';

type OllamaToolCall = { function: { name: string; arguments: Record<string, unknown> | string } };

type OllamaMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: OllamaToolCall[];
  tool_name?: string;
  images?: string[];
  thinking?: string;
  saved?: string;
};

type OllamaChunk = {
  message?: { content?: string; thinking?: string; tool_calls?: OllamaToolCall[] };
  done?: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
  error?: string;
};

const COMPACT_AT = 0.75;
const KEEP_FULL_OBSERVATIONS = 10;
const ELIDE_BLOCK = 10;
const ELIDE_OVER = 1500;
const DEDUP_OVER = 200;
const ARG_OVER = 1000;
const CLOUD_CTX_CAP = 262_144;
const KEEP_RECENT = 8;
const RECENT_READS = 5;
const COMPACT_MAX_TOKENS = 150_000;
export const compactAt = (ctx: number): number => Math.min(ctx * COMPACT_AT, COMPACT_MAX_TOKENS);

function parseArgs(raw: Record<string, unknown> | string): Record<string, unknown> {
  if (typeof raw !== 'string') return raw ?? {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return { __invalid_json__: raw };
  }
}

function shrinkArgs(call: OllamaToolCall): OllamaToolCall {
  const args = call.function.arguments;
  if (typeof args === 'string') return call;
  const short = Object.fromEntries(Object.entries(args).map(([k, v]) => [k, typeof v === 'string' && v.length > ARG_OVER ? `${v.slice(0, 300)}… [${v.length - 300} characters elided]` : v]));
  return { function: { ...call.function, arguments: short } };
}

export function parseInlineToolCalls(text: string, toolNames: Set<string>): OllamaToolCall[] {
  const candidates = [
    ...[...text.matchAll(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g)].map((m) => m[1]),
    ...[...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map((m) => m[1]),
    text.trim(),
  ];
  const calls: OllamaToolCall[] = [];
  for (const candidate of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate ?? '');
    } catch {
      continue;
    }
    for (const item of Array.isArray(parsed) ? parsed : [parsed]) {
      const obj = item as { name?: unknown; arguments?: unknown; parameters?: unknown };
      const args = obj?.arguments ?? obj?.parameters;
      if (typeof obj?.name === 'string' && toolNames.has(obj.name) && typeof args === 'object' && args !== null) {
        calls.push({ function: { name: obj.name, arguments: args as Record<string, unknown> } });
      }
    }
    if (calls.length) return calls;
  }
  return calls;
}

export class OllamaProvider implements Provider {
  private history: OllamaMessage[] = [];
  private info: { thinking: boolean; vision: boolean; ctx: number } | undefined;
  private lastPromptTokens = 0;

  constructor(
    private readonly model: string,
    private readonly numCtx: number,
    private readonly host = process.env.OLLAMA_HOST ?? 'http://localhost:11434',
  ) {}

  addUser(text: string, images: Image[] = []): void {
    this.history.push({ role: 'user', content: text, ...(images.length ? { images: images.map((i) => i.data) } : {}) });
  }

  snapshot(): unknown {
    return { history: this.history };
  }

  restore(state: unknown): void {
    this.history = [...((state as { history?: OllamaMessage[] })?.history ?? [])];
    this.lastPromptTokens = 0;
  }

  addToolResults(results: ToolResult[]): void {
    for (const r of results) {
      this.history.push({ role: 'tool', tool_name: r.name, content: r.isError ? `ERROR: ${r.output}` : r.output, ...(r.savedAs ? { saved: r.savedAs } : {}) });
    }
  }

  async step(req: StepRequest): Promise<StepResult> {
    const { thinking: think, vision, ctx } = await this.modelInfo(req.signal);
    const compacted = this.lastPromptTokens > compactAt(ctx) && (await this.compact(req.signal, ctx, req.task, req.changedFiles ?? []));
    const res = await this.post(
      {
        model: this.model,
        stream: true,
        ...(think ? { think: true } : {}),
        messages: [{ role: 'system', content: req.system }, ...this.withElidedObservations().map(({ images, saved: _saved, ...m }) => (vision && images ? { ...m, images } : m))],
        tools: req.tools.map((t: ToolSpec) => ({
          type: 'function',
          function: { name: t.name, description: t.description, parameters: t.schema },
        })),
        options: { num_ctx: ctx },
      },
      req.signal,
    );

    let text = '';
    let thinking = '';
    let toolCalls: OllamaToolCall[] = [];
    let calls: ToolCall[] = [];
    const toCall = (c: OllamaToolCall): ToolCall => ({ id: randomUUID(), name: c.function.name, input: parseArgs(c.function.arguments) });
    let usage: Usage = { input: 0, output: 0 };
    let doneReason = '';
    for await (const chunk of this.chunks(res)) {
      if (chunk.error) throw new Error(`Ollama: ${chunk.error}`);
      const m = chunk.message;
      if (m?.thinking) {
        thinking += m.thinking;
        req.onThinking(m.thinking);
      }
      if (m?.content) {
        text += m.content;
        req.onText(m.content);
      }
      for (const c of m?.tool_calls ?? []) {
        toolCalls.push(c);
        const call = toCall(c);
        calls.push(call);
        req.onToolCall?.(call);
      }
      if (chunk.done) {
        usage = { input: chunk.prompt_eval_count ?? 0, output: chunk.eval_count ?? 0 };
        doneReason = chunk.done_reason ?? '';
      }
    }
    this.lastPromptTokens = usage.input;

    if (!toolCalls.length) {
      toolCalls = parseInlineToolCalls(text, new Set(req.tools.map((t) => t.name)));
      calls = toolCalls.map(toCall);
    }
    this.history.push({ role: 'assistant', content: text, ...(thinking ? { thinking } : {}), ...(toolCalls.length ? { tool_calls: toolCalls } : {}) });

    const stop = calls.length ? 'tool_use' : doneReason === 'length' ? 'max_tokens' : 'end';
    return { text, toolCalls: calls, stop, usage, ...(compacted ? { compacted } : {}) };
  }

  private withElidedObservations(): OllamaMessage[] {
    const olderBlocks = (indices: number[]) => new Set(indices.slice(0, Math.floor(Math.max(0, indices.length - KEEP_FULL_OBSERVATIONS) / ELIDE_BLOCK) * ELIDE_BLOCK));
    const elide = olderBlocks(this.history.flatMap((m, i) => (m.role === 'tool' ? [i] : [])));
    const shrink = olderBlocks(this.history.flatMap((m, i) => (m.tool_calls?.length ? [i] : [])));
    const newest = new Map<string, number>();
    this.history.forEach((m, i) => m.role === 'tool' && m.content.length > DEDUP_OVER && newest.set(m.content, i));
    return this.history.map((m, i) => {
      if (m.role === 'tool' && (newest.get(m.content) ?? i) !== i) return { ...m, content: '[identical to a later output of this tool; see the latest copy]' };
      if (shrink.has(i)) return { ...m, tool_calls: m.tool_calls!.map(shrinkArgs), thinking: undefined };
      if (!elide.has(i) || m.content.length <= ELIDE_OVER) return m;
      const where = m.saved ? `the full output is saved in ${m.saved}: read_file or grep it instead of running the tool again` : 'run the tool again if you need it';
      return { ...m, content: `${m.content.slice(0, 600)}\n… [older tool output elided to save context; ${where}]` };
    });
  }

  private async post(body: object, signal: AbortSignal): Promise<Response> {
    let res: Response;
    try {
      res = await fetch(`${this.host}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      });
    } catch (e) {
      if (signal.aborted) throw e;
      throw new Error(`Não foi possível conectar ao Ollama em ${this.host}. Inicie com "ollama serve" ou ajuste OLLAMA_HOST.`, { cause: e });
    }
    if (!res.ok) {
      const detail = await res.text();
      if (res.status === 404) throw new Error(`Modelo "${this.model}" não encontrado no Ollama. Baixe com "ollama pull ${this.model}".`);
      if (res.status === 429) {
        const reason = /"error"\s*:\s*"([^"]*)"/.exec(detail)?.[1] ?? detail;
        throw new Error(`Limite de uso do Ollama atingido para "${this.model}" (${reason}). Aguarde o limite renovar, adicione créditos em https://ollama.com/settings ou escolha outro modelo.`);
      }
      throw new Error(`Ollama respondeu ${res.status}: ${detail}`);
    }
    return res;
  }

  private async *chunks(res: Response): AsyncGenerator<OllamaChunk> {
    if (!res.body) return;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line) yield JSON.parse(line) as OllamaChunk;
      }
    }
    if (buffer.trim()) yield JSON.parse(buffer) as OllamaChunk;
  }

  private async modelInfo(signal: AbortSignal): Promise<{ thinking: boolean; vision: boolean; ctx: number }> {
    if (this.info) return this.info;
    try {
      const res = await fetch(`${this.host}/api/show`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: this.model }),
        signal,
      });
      const info = (await res.json()) as { capabilities?: string[]; model_info?: Record<string, unknown>; remote_host?: string };
      const native = Object.entries(info.model_info ?? {}).find(([k]) => k.endsWith('.context_length'))?.[1];
      const remote = Boolean(info.remote_host) || /cloud/.test(this.model);
      const ctx = remote && typeof native === 'number' ? Math.min(native, CLOUD_CTX_CAP) : remote ? CLOUD_CTX_CAP : this.numCtx;
      this.info = { thinking: info.capabilities?.includes('thinking') ?? false, vision: info.capabilities?.includes('vision') ?? false, ctx };
    } catch (e) {
      if (signal.aborted) throw e;
      this.info = { thinking: false, vision: false, ctx: this.numCtx };
    }
    return this.info;
  }


  private async compact(signal: AbortSignal, ctx: number, task: string | undefined, changedFiles: string[]): Promise<boolean> {
    let cut = Math.max(0, this.history.length - KEEP_RECENT);
    while (cut > 0 && this.history[cut]?.role === 'tool') cut--;
    if (cut < 2) return false;
    const transcript = this.history
      .slice(0, cut)
      .map((m) => {
        const calls = m.tool_calls?.map((c) => `${c.function.name}(${JSON.stringify(c.function.arguments).slice(0, 300)})`).join(', ');
        return `[${m.role}${m.tool_name ? `:${m.tool_name}` : ''}] ${m.content.slice(0, 1500)}${m.saved ? ` (full output saved in ${m.saved})` : ''}${calls ? ` -> calls ${calls}` : ''}`;
      })
      .join('\n');
    const res = await this.post(
      {
        model: this.model,
        stream: false,
        messages: [
          {
            role: 'user',
            content:
              'Write a checkpoint of this coding-agent work log so the agent can continue without the original messages. Use exactly these sections:\n' +
              '## Primary request (the user\'s words, verbatim when short)\n## Key decisions and constraints\n## Files and code (exact paths, what each contains or what was changed)\n## Errors and fixes\n## Current work (what was in progress)\n## Next step\n' +
              'Preserve exact file paths, identifiers, commands and error strings. Be dense and factual; do not invent anything.\n\n' +
              transcript,
          },
        ],
        options: { num_ctx: ctx },
      },
      signal,
    );
    const summary = ((await res.json()) as { message?: { content?: string } }).message?.content ?? '';
    const kept = this.history.slice(cut);
    const recentReads = [
      ...new Set(
        this.history
          .slice(0, cut)
          .flatMap((m) => m.tool_calls ?? [])
          .filter((c) => c.function.name === 'read_file')
          .map((c) => parseArgs(c.function.arguments).path)
          .filter((p): p is string => typeof p === 'string')
          .reverse(),
      ),
    ].slice(0, RECENT_READS);
    const pinned: OllamaMessage[] = task && !kept.some((m) => m.role === 'user' && m.content.includes(task)) ? [{ role: 'user', content: `[Original request, verbatim]\n${task}` }] : [];
    this.history = [
      ...pinned,
      { role: 'user', content: `[Checkpoint of earlier work in this session] Continue from "Next step" below. Do not explore the project again: what you learned is summarized here. Re-read a file only right before you edit it.${changedFiles.length ? `\nFiles you already changed in this task: ${changedFiles.join(', ')}` : ''}${recentReads.length ? `\nFiles you read most recently: ${recentReads.join(', ')}` : ''}\n${summary}` },
      ...kept,
    ];
    this.lastPromptTokens = 0;
    return true;
  }
}
