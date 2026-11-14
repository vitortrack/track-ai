#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { bestOf } from './attempts.js';
import { readMemories } from './memory.js';
import { orchestrate } from './orchestrator.js';
import { gateFor } from './gate.js';
import { agentJudge } from './judge.js';
import { LANGUAGE_NAMES, languageName } from './prompts.js';
import type { Effort } from './providers/anthropic.js';
import { DEFAULT_EMBED_MODEL, DEFAULT_MODEL, Session, type Config } from './session.js';
import type { Mode } from './tools.js';
import { UI } from './ui.js';

const HELP = `Alien — agente de código autônomo (ReAct + planejamento + reflexão + multiagente + RAG)

Uso:
  alien [opções] "tarefa"      executa a tarefa e sai
  alien [opções]               modo interativo

Opções:
  -p, --provider <ollama|anthropic>  padrão: anthropic com ANTHROPIC_API_KEY, senão ollama
  -m, --model <nome>                 padrão: ${DEFAULT_MODEL.ollama} (ollama) · ${DEFAULT_MODEL.anthropic} (anthropic)
      --mode <ask|auto|read-only>    permissão para escrita e bash (padrão: ask)
  -C, --cwd <dir>                    pasta de trabalho (padrão: a atual)
      --orchestrate                  contrato → fatias com portão → revisão
      --gate                         o próprio modelo escreve checagens de pronto (uma chamada, sem explorar o repo); o agente só conclui quando passam
      --gate-file <arquivo>          reaproveita as checagens salvas nesse arquivo (uma vez por card) ou grava as novas nele
      --harness <arquivo>            texto de harness específico da tarefa (RHI), posto antes do pedido
      --handoff <arquivo>            lê a nota da execução anterior no início e grava a nota desta no fim
      --attempts <n>                 melhor de N: tentativas isoladas, escolhe a que passa nos testes com o menor diff
      --review                       liga a revisão por um agente crítico (padrão: desligada; a checagem de
                                     escopo e o portão de verificação continuam sempre ativos)
      --max-steps <n>                passos por agente (padrão: 80)
      --budget <tokens>              para quando o total de tokens passar disso (padrão: sem limite)
      --effort <low|medium|high|xhigh|max>  esforço de raciocínio do Claude (padrão: high)
      --num-ctx <n>                  janela de contexto do Ollama (padrão: 65536)
      --embed-model <nome>           modelo de embedding do Ollama (padrão: ${DEFAULT_EMBED_MODEL})
      --lang <idioma>                idioma das respostas e interações: pt-BR, en, es, fr, de, it, auto (padrão: pt-BR)
      --thinking                     mostra o raciocínio do modelo (padrão: escondido)
      --no-log                       não grava o trace em ~/.alien/sessions
  -c, --continue                     retoma a última conversa deste projeto
  -r, --resume <id>                  retoma uma conversa salva (veja /sessions)
      --fork                         com -c ou -r: continua numa cópia, sem alterar a original
  -h, --help

Variáveis: OLLAMA_HOST, ANTHROPIC_API_KEY, ALIEN_MODEL, ALIEN_SANDBOX, ALIEN_EMBED_MODEL, ALIEN_LANG`;

const COMMANDS = `Comandos:
  /plan                    mostra o plano atual
  /mode <ask|auto|read-only>
  /review <on|off>
  /lang <idioma>           muda o idioma das respostas e interações (pt-BR, en, es, …, auto)
  /traduzir [idioma]       traduz a última resposta (padrão: o idioma atual)
  /thinking <on|off>       mostra ou esconde o raciocínio do modelo
  /orchestrate <tarefa>    roda a tarefa no pipeline multiagente
  /index                   indexa (ou atualiza) o código para o RAG
  /memory                  lista a memória de longo prazo do projeto
  /usage                   tokens e custo da sessão
  /sessions                lista as conversas salvas deste projeto
  /resume <id>             retoma uma conversa salva
  /fork                    continua numa cópia da conversa atual
  /clear                   começa uma conversa nova
  /exit`;

function fail(message: string): never {
  console.error(`alien: ${message}\nUse --help para ver as opções.`);
  process.exit(2);
}

function oneOf<T extends string>(value: string | undefined, allowed: readonly T[], flag: string, fallback: T): T {
  if (value === undefined) return fallback;
  if (!(allowed as readonly string[]).includes(value)) fail(`${flag} aceita: ${allowed.join(', ')}.`);
  return value as T;
}

function positiveInt(value: string | undefined, flag: string, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) fail(`${flag} precisa ser um inteiro positivo.`);
  return n;
}

function isLang(value: string): boolean {
  return value === 'auto' || value in LANGUAGE_NAMES || /^[a-z]{2}(-[A-Z]{2})?$/.test(value);
}

function validLang(value: string, flag: string): string {
  if (!isLang(value)) fail(`${flag} aceita um código de idioma como pt-BR, en, es ou auto.`);
  return value;
}

function parseConfig(): { cfg: Config; task: string; orchestrateTask: boolean; gate: boolean; gateFile: string | undefined; showThinking: boolean; attempts: number; resumeId: string | undefined; fork: boolean } {
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
        provider: { type: 'string', short: 'p' },
        model: { type: 'string', short: 'm' },
        mode: { type: 'string' },
        cwd: { type: 'string', short: 'C' },
        orchestrate: { type: 'boolean' },
        attempts: { type: 'string' },
        gate: { type: 'boolean' },
        'gate-file': { type: 'string' },
        handoff: { type: 'string' },
        harness: { type: 'string' },
        review: { type: 'boolean' },
        'no-review': { type: 'boolean' },
        'review-model': { type: 'string' },
        'max-steps': { type: 'string' },
        budget: { type: 'string' },
        effort: { type: 'string' },
        'num-ctx': { type: 'string' },
        'embed-model': { type: 'string' },
        'no-log': { type: 'boolean' },
        lang: { type: 'string' },
        thinking: { type: 'boolean' },
        continue: { type: 'boolean', short: 'c' },
        resume: { type: 'string', short: 'r' },
        fork: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e));
  }
  const { values, positionals } = parsed;
  if (values.help) {
    console.log(HELP);
    process.exit(0);
  }
  const hasAnthropicKey = Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
  const provider = oneOf(values.provider, ['ollama', 'anthropic'] as const, '--provider', hasAnthropicKey ? 'anthropic' : 'ollama');
  const root = path.resolve(values.cwd ?? process.cwd());
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) fail(`a pasta "${root}" não existe.`);
  return {
    cfg: {
      provider,
      model: values.model ?? process.env.ALIEN_MODEL ?? DEFAULT_MODEL[provider],
      mode: oneOf(values.mode, ['ask', 'auto', 'read-only'] as const, '--mode', 'ask'),
      root,
      maxSteps: positiveInt(values['max-steps'], '--max-steps', 80),
      reviewModel: values['review-model'] ?? process.env.ALIEN_REVIEW_MODEL,
      review: (Boolean(values.review) || Boolean(values['review-model'] ?? process.env.ALIEN_REVIEW_MODEL)) && !values['no-review'],
      effort: oneOf<Effort>(values.effort, ['low', 'medium', 'high', 'xhigh', 'max'], '--effort', 'high'),
      numCtx: positiveInt(values['num-ctx'], '--num-ctx', 65536),
      embedModel: values['embed-model'] ?? process.env.ALIEN_EMBED_MODEL ?? DEFAULT_EMBED_MODEL,
      tokenBudget: positiveInt(values.budget, '--budget', 0),
      interactive: positionals.length === 0,
      lang: validLang(values.lang ?? process.env.ALIEN_LANG ?? 'pt-BR', '--lang'),
      logDir: values['no-log'] ? null : Session.defaultLogDir(),
      ...(values.handoff ? { handoff: path.resolve(values.handoff) } : {}),
      ...(values.harness ? { harness: fs.readFileSync(path.resolve(values.harness), 'utf8') } : {}),
    },
    task: positionals.join(' ').trim(),
    orchestrateTask: Boolean(values.orchestrate),
    gate: Boolean(values.gate),
    gateFile: values['gate-file'] ? path.resolve(values['gate-file']) : undefined,
    showThinking: Boolean(values.thinking),
    attempts: Math.max(1, positiveInt(values.attempts, '--attempts', 1)),
    resumeId: values.resume ?? (values.continue ? 'latest' : undefined),
    fork: Boolean(values.fork),
  };
}

async function main(): Promise<void> {
  const { cfg, task, orchestrateTask, gate, gateFile, showThinking, attempts, resumeId, fork } = parseConfig();
  const ui = UI.create(showThinking);
  const session = new Session(cfg, ui);
  const resume = (id: string, asFork: boolean): string | null => {
    const saved = id === 'latest' ? session.sessions.latest() : session.sessions.load(id);
    if (!saved) return id === 'latest' ? 'nenhuma conversa salva neste projeto' : `conversa "${id}" não encontrada (veja /sessions)`;
    const problem = session.resume(saved);
    if (problem) return problem;
    if (asFork) session.fork();
    ui.info(`${asFork ? `cópia ${session.id} da conversa` : 'conversa retomada:'} ${saved.id} · ${saved.turns.length} tarefa(s) · "${saved.title}"`);
    return null;
  };
  if (fork && !resumeId) fail('--fork precisa de -c ou -r <id>.');
  if (resumeId) {
    const problem = resume(resumeId, fork);
    if (problem) fail(problem);
  }

  ui.onInterrupt(() => {
    if (session.busy) {
      session.abort();
      ui.warn('interrompendo a tarefa...');
      return;
    }
    ui.close();
    process.exit(0);
  });

  ui.banner([
    `provedor: ${cfg.provider} · modelo: ${cfg.model}`,
    `pasta: ${cfg.root}`,
    `idioma: ${cfg.lang === 'auto' ? 'o da pergunta' : languageName(cfg.lang)} · permissões: ${cfg.mode} · revisão: ${cfg.review ? 'ligada' : 'desligada'}${cfg.tokenBudget ? ` · orçamento: ${cfg.tokenBudget} tokens` : ''}`,
    session.logPath ? `trace: ${session.logPath}` : 'trace: desligado',
  ]);

  const execute = async (text: string, viaOrchestrator: boolean): Promise<void> => {
    try {
      if (viaOrchestrator) ui.final(await orchestrate(session, text));
      else if (attempts > 1) {
        const result = await session.track(() => bestOf(session.cfg, ui, text, attempts, undefined, session.signal));
        session.addUsage(result.usage);
        ui.final(result.answer);
      } else {
        const out = await session.run(text);
        if (out.startsWith('Interrompido') || out.startsWith('Limite') || out.startsWith('Orçamento') || out.startsWith('O modelo')) ui.warn(out);
      }
    } catch (e) {
      ui.error(e instanceof Error ? e.message : String(e));
    }
    ui.usage(session.usage, session.costUsd());
  };

  if (task) {
    if (gate && !orchestrateTask) {
      ui.phase('Portão: checagens de pronto');
      try {
        cfg.gate = await gateFor(cfg.root, task, agentJudge(session), gateFile);
        ui.info(`${cfg.gate.length} checagens de pronto escritas pelo motor de decisão`);
        session.log({ event: 'gate', gate: cfg.gate });
      } catch (e) {
        ui.warn(`sem portão: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    await execute(task, orchestrateTask);
    ui.close();
    return;
  }

  for (;;) {
    let line: string;
    try {
      line = (await ui.ask('\n› ')).trim();
    } catch {
      break;
    }
    if (!line) continue;
    if (!line.startsWith('/')) {
      await execute(line, false);
      continue;
    }
    const [command = '', ...rest] = line.split(/\s+/);
    const arg = rest.join(' ');
    switch (command) {
      case '/exit':
      case '/quit':
        ui.close();
        return;
      case '/help':
        ui.final(COMMANDS);
        break;
      case '/plan':
        if (session.plan.length) ui.plan(session.plan);
        else ui.info('nenhum plano ainda');
        break;
      case '/mode':
        if (!['ask', 'auto', 'read-only'].includes(arg)) ui.warn('use /mode ask, /mode auto ou /mode read-only');
        else {
          session.cfg.mode = arg as Mode;
          ui.info(`permissões: ${arg}`);
        }
        break;
      case '/review':
        if (arg !== 'on' && arg !== 'off') ui.warn('use /review on ou /review off');
        else {
          session.cfg.review = arg === 'on';
          ui.info(`revisão ${arg === 'on' ? 'ligada' : 'desligada'}`);
        }
        break;
      case '/lang':
        if (!isLang(arg)) ui.warn('use /lang pt-BR, /lang en, /lang es … ou /lang auto');
        else {
          session.cfg.lang = arg;
          ui.info(`idioma: ${arg === 'auto' ? 'o da pergunta' : languageName(arg)}`);
        }
        break;
      case '/traduzir':
      case '/translate': {
        const target = arg || (session.cfg.lang === 'auto' ? 'pt-BR' : session.cfg.lang);
        if (!isLang(target)) {
          ui.warn('use /traduzir en, /traduzir es …');
          break;
        }
        await execute(
          `Translate your previous answer into ${languageName(target)}. Keep the same structure and Markdown; keep code, identifiers, file paths and quoted excerpts unchanged. Do not call tools.`,
          false,
        );
        break;
      }
      case '/thinking':
        if (arg !== 'on' && arg !== 'off') ui.warn('use /thinking on ou /thinking off');
        else {
          ui.showThinking = arg === 'on';
          ui.info(`raciocínio ${arg === 'on' ? 'visível' : 'escondido'}`);
        }
        break;
      case '/orchestrate':
        if (!arg) ui.warn('use /orchestrate <tarefa>');
        else await execute(arg, true);
        break;
      case '/index': {
        ui.info('indexando o código...');
        try {
          const stats = await session.track(() => session.codeIndex.update(session.signal));
          ui.info(
            `${stats.files} arquivos · ${stats.chunks} trechos · ${stats.changed} atualizados · ${stats.embedded ? `embeddings ${cfg.embedModel}` : `só BM25 (rode "ollama pull ${cfg.embedModel}" para busca vetorial)`}`,
          );
        } catch (e) {
          ui.error(e instanceof Error ? e.message : String(e));
        }
        break;
      }
      case '/memory': {
        const memories = readMemories(cfg.root);
        if (!memories.length) ui.info('a memória de longo prazo deste projeto está vazia');
        for (const m of memories.slice(-30)) ui.final(`[${m.kind} · ${m.at.slice(0, 10)}] ${m.text}`);
        break;
      }
      case '/usage':
        ui.usage(session.usage, session.costUsd());
        break;
      case '/sessions': {
        const saved = session.sessions.list();
        if (!saved.length) ui.info('nenhuma conversa salva neste projeto');
        for (const s of saved) ui.final(`${s.id === session.id ? '*' : ' '} ${s.id}  ${s.updated.slice(0, 16).replace('T', ' ')}  ${s.turns.length} tarefa(s)  ${s.title}`);
        break;
      }
      case '/resume': {
        if (session.busy) break;
        const problem = arg ? resume(arg, false) : 'informe o id (veja /sessions)';
        if (problem) ui.warn(problem);
        break;
      }
      case '/fork':
        session.fork();
        ui.info(`agora numa cópia: ${session.id}`);
        break;
      case '/clear':
        session.reset();
        ui.info('conversa reiniciada');
        break;
      default:
        ui.warn(`comando desconhecido: ${command}. Use /help.`);
    }
  }
  ui.close();
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
