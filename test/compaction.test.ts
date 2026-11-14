import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compactAt, OllamaProvider } from '../src/providers/ollama.js';
import type { StepRequest } from '../src/types.js';

type Message = { role: string; content: string };

function stubOllama(promptTokens: number): { chats: Message[][]; summaries: number } {
  const seen = { chats: [] as Message[][], summaries: 0 };
  globalThis.fetch = (async (url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as { stream: boolean; messages: Message[] };
    if (url.endsWith('/api/show')) return new Response(JSON.stringify({ model_info: { 'm.context_length': 1000 }, remote_host: 'cloud' }));
    if (!body.stream) {
      seen.summaries++;
      return new Response(JSON.stringify({ message: { content: 'checkpoint summary' } }));
    }
    seen.chats.push(body.messages);
    const chunk = { message: { tool_calls: [{ function: { name: 'bash', arguments: { command: 'ls' } } }] }, done: true, prompt_eval_count: promptTokens, eval_count: 1 };
    return new Response(`${JSON.stringify(chunk)}\n`);
  }) as typeof fetch;
  return seen;
}

test('compaction runs in a single long task and keeps the original request verbatim', async () => {
  const task = `Implement the card.\n${'- acceptance criterion\n'.repeat(400)}- LAST CRITERION: export blocks pending photos`;
  const seen = stubOllama(900);
  const provider = new OllamaProvider('glm:cloud', 1000);
  const req: StepRequest = { system: 's', task, changedFiles: ['src/a.ts'], tools: [{ name: 'bash', description: 'd', schema: { type: 'object', properties: {}, required: [] } }], signal: new AbortController().signal, onText: () => {}, onThinking: () => {} };
  provider.addUser(task);
  let compactions = 0;
  for (let i = 0; i < 8; i++) {
    const r = await provider.step(req);
    if (r.compacted) compactions++;
    provider.addToolResults(r.toolCalls.map((c) => ({ id: c.id, name: c.name, output: 'ok', isError: false })));
  }
  assert.ok(seen.summaries > 0, 'compaction never ran');
  assert.equal(compactions, seen.summaries);
  const last = seen.chats.at(-1)!;
  assert.ok(last.some((m) => m.role === 'user' && m.content.includes(task)), 'original request lost after compaction');
  const checkpoint = last.find((m) => m.content.includes('checkpoint summary'))!;
  assert.match(checkpoint.content, /Do not explore the project again/);
  assert.match(checkpoint.content, /Files you already changed in this task: src\/a\.ts/);
  assert.notEqual(last[1]?.role, 'tool', 'history must not start with an orphan tool result');
});

test('cloud models compact at a fixed token cap; small local windows keep the ratio', () => {
  assert.equal(compactAt(262_144), 150_000);
  assert.equal(compactAt(8192), 6144);
});

test('observations older than the last 10 are masked in blocks of 10, so the prefix stays stable between steps', async () => {
  const seen = stubOllama(10);
  const provider = new OllamaProvider('glm:cloud', 1000);
  const req: StepRequest = { system: 's', tools: [{ name: 'bash', description: 'd', schema: { type: 'object', properties: {}, required: [] } }], signal: new AbortController().signal, onText: () => {}, onThinking: () => {} };
  provider.addUser('task');
  const masked = () => seen.chats.at(-1)!.filter((m) => m.role === 'tool' && m.content.includes('elided')).length;
  for (let i = 0; i < 25; i++) {
    const r = await provider.step(req);
    provider.addToolResults(r.toolCalls.map((c) => ({ id: c.id, name: c.name, output: `out ${i} ${'x'.repeat(2000)}`, isError: false })));
  }
  await provider.step(req);
  assert.equal(masked(), 10);
  provider.addToolResults([{ id: 'z', name: 'bash', output: 'y'.repeat(2000), isError: false }]);
  await provider.step(req);
  assert.equal(masked(), 10);
});

test('an elided output that was saved points to its file instead of asking to run the tool again', async () => {
  const seen = stubOllama(10);
  const provider = new OllamaProvider('glm:cloud', 1000);
  const req: StepRequest = { system: 's', tools: [{ name: 'bash', description: 'd', schema: { type: 'object', properties: {}, required: [] } }], signal: new AbortController().signal, onText: () => {}, onThinking: () => {} };
  provider.addUser('task');
  for (let i = 0; i < 21; i++) {
    const r = await provider.step(req);
    provider.addToolResults(r.toolCalls.map((c) => ({ id: c.id, name: c.name, output: `out ${i} ${'x'.repeat(2000)}`, isError: false, ...(i === 0 ? { savedAs: '.alien/outputs/s/bash-0.txt' } : {}) })));
  }
  await provider.step(req);
  const tools = seen.chats.at(-1)!.filter((m) => m.role === 'tool');
  assert.match(tools[0]!.content, /full output is saved in \.alien\/outputs\/s\/bash-0\.txt/);
  assert.match(tools[1]!.content, /run the tool again/);
  assert.ok(seen.chats.at(-1)!.every((m) => !('saved' in m)), 'the saved path is internal, not an Ollama field');
});

test('reasoning goes back to the model with its turn and drops out with old argument blocks', async () => {
  const sent: { role: string; thinking?: string }[][] = [];
  globalThis.fetch = (async (url: string, init: { body: string }) => {
    if (url.endsWith('/api/show')) return new Response(JSON.stringify({ capabilities: ['thinking'], model_info: { 'm.context_length': 100000 }, remote_host: 'cloud' }));
    sent.push((JSON.parse(init.body) as { messages: (typeof sent)[number] }).messages);
    const chunk = { message: { thinking: `plan ${sent.length}`, tool_calls: [{ function: { name: 'bash', arguments: { command: 'ls' } } }] }, done: true, prompt_eval_count: 10, eval_count: 1 };
    return new Response(`${JSON.stringify(chunk)}\n`);
  }) as typeof fetch;
  const provider = new OllamaProvider('glm:cloud', 1000);
  const req: StepRequest = { system: 's', tools: [{ name: 'bash', description: 'd', schema: { type: 'object', properties: {}, required: [] } }], signal: new AbortController().signal, onText: () => {}, onThinking: () => {} };
  provider.addUser('task');
  for (let i = 0; i < 21; i++) {
    const r = await provider.step(req);
    provider.addToolResults(r.toolCalls.map((c) => ({ id: c.id, name: c.name, output: 'ok', isError: false })));
  }
  await provider.step(req);
  const assistants = sent.at(-1)!.filter((m) => m.role === 'assistant');
  assert.equal(assistants[0]!.thinking, undefined);
  assert.equal(assistants.at(-1)!.thinking, 'plan 21');
  assert.equal(assistants.filter((m) => m.thinking).length, 11);
});

test('images go to the model only when it has vision; the history keeps them for a later vision model', async () => {
  const sent: { images?: string[] }[][] = [];
  const stub = (capabilities: string[]) => {
    globalThis.fetch = (async (url: string, init: { body: string }) => {
      if (url.endsWith('/api/show')) return new Response(JSON.stringify({ capabilities }));
      sent.push((JSON.parse(init.body) as { messages: { images?: string[] }[] }).messages);
      return new Response(`${JSON.stringify({ message: { content: 'ok' }, done: true, prompt_eval_count: 1, eval_count: 1 })}\n`);
    }) as typeof fetch;
  };
  const req: StepRequest = { system: 's', tools: [], signal: new AbortController().signal, onText: () => {}, onThinking: () => {} };
  stub(['completion', 'vision']);
  const seeing = new OllamaProvider('glm:cloud', 1000);
  seeing.addUser('what is in the print?', [{ mime: 'image/png', data: 'aGVsbG8=' }]);
  await seeing.step(req);
  assert.deepEqual(sent.at(-1)![1]!.images, ['aGVsbG8=']);
  stub(['completion']);
  const blind = new OllamaProvider('qwen3:8b', 1000);
  blind.restore(seeing.snapshot());
  await blind.step(req);
  assert.equal(sent.at(-1)![1]!.images, undefined);
  assert.deepEqual((blind.snapshot() as { history: { images?: string[] }[] }).history[0]!.images, ['aGVsbG8=']);
});

test('prune: identical tool outputs keep only the newest copy; old big tool-call arguments shrink in blocks', async () => {
  const sent: { role: string; content: string; tool_calls?: { function: { arguments: Record<string, string> } }[] }[][] = [];
  globalThis.fetch = (async (url: string, init: { body: string }) => {
    if (url.endsWith('/api/show')) return new Response(JSON.stringify({ model_info: { 'm.context_length': 100000 }, remote_host: 'cloud' }));
    sent.push((JSON.parse(init.body) as { messages: (typeof sent)[number] }).messages);
    const chunk = { message: { tool_calls: [{ function: { name: 'write_file', arguments: { path: 'a.ts', content: 'c'.repeat(5000) } } }] }, done: true, prompt_eval_count: 10, eval_count: 1 };
    return new Response(`${JSON.stringify(chunk)}\n`);
  }) as typeof fetch;
  const provider = new OllamaProvider('glm:cloud', 1000);
  const req: StepRequest = { system: 's', tools: [{ name: 'write_file', description: 'd', schema: { type: 'object', properties: {}, required: [] } }], signal: new AbortController().signal, onText: () => {}, onThinking: () => {} };
  provider.addUser('task');
  const same = `same output ${'z'.repeat(300)}`;
  for (let i = 0; i < 21; i++) {
    const r = await provider.step(req);
    provider.addToolResults(r.toolCalls.map((c) => ({ id: c.id, name: c.name, output: i === 3 || i === 20 ? same : `out ${i}`, isError: false })));
  }
  await provider.step(req);
  const last = sent.at(-1)!;
  const tools = last.filter((m) => m.role === 'tool');
  assert.match(tools[3]!.content, /^\[identical to a later output of this tool/);
  assert.equal(tools[20]!.content, same);
  const args = last.filter((m) => m.tool_calls).map((m) => m.tool_calls![0]!.function.arguments.content!);
  assert.equal(args.filter((a) => a.includes('characters elided')).length, 10);
  assert.ok(args.slice(0, 10).every((a) => a.length < 400) && args.slice(10).every((a) => a.length === 5000));
  assert.equal(last.filter((m) => m.tool_calls)[0]!.tool_calls![0]!.function.arguments.path, 'a.ts');
});

test('the checkpoint lists the files read most recently before the cut', async () => {
  let n = 0;
  const chats: Message[][] = [];
  globalThis.fetch = (async (url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as { stream: boolean; messages: Message[] };
    if (url.endsWith('/api/show')) return new Response(JSON.stringify({ model_info: { 'm.context_length': 1000 }, remote_host: 'cloud' }));
    if (!body.stream) return new Response(JSON.stringify({ message: { content: 'checkpoint summary' } }));
    chats.push(body.messages);
    const chunk = { message: { tool_calls: [{ function: { name: 'read_file', arguments: { path: `f${n++ % 7}.ts` } } }] }, done: true, prompt_eval_count: n === 13 ? 900 : 10, eval_count: 1 };
    return new Response(`${JSON.stringify(chunk)}\n`);
  }) as typeof fetch;
  const provider = new OllamaProvider('glm:cloud', 1000);
  const req: StepRequest = { system: 's', task: 'task', tools: [{ name: 'read_file', description: 'd', schema: { type: 'object', properties: {}, required: [] } }], signal: new AbortController().signal, onText: () => {}, onThinking: () => {} };
  provider.addUser('task');
  for (let i = 0; i < 15; i++) {
    const r = await provider.step(req);
    provider.addToolResults(r.toolCalls.map((c) => ({ id: c.id, name: c.name, output: 'ok', isError: false })));
  }
  const checkpoint = chats.at(-1)!.find((m) => m.content.includes('checkpoint summary'))!;
  const listed = /Files you read most recently: (.*)/.exec(checkpoint.content)?.[1]?.split(', ');
  assert.equal(listed?.length, 5);
  assert.equal(new Set(listed).size, 5);
});

test('each streamed tool call is announced as it arrives, with the same id the step returns', async () => {
  globalThis.fetch = (async (url: string) => {
    if (url.endsWith('/api/show')) return new Response(JSON.stringify({ model_info: { 'm.context_length': 1000 } }));
    const first = { message: { tool_calls: [{ function: { name: 'read_file', arguments: { path: 'a.ts' } } }] } };
    const second = { message: { tool_calls: [{ function: { name: 'read_file', arguments: { path: 'b.ts' } } }] }, done: true, prompt_eval_count: 1, eval_count: 1 };
    return new Response(`${JSON.stringify(first)}\n${JSON.stringify(second)}\n`);
  }) as typeof fetch;
  const announced: { id: string; input: Record<string, unknown> }[] = [];
  const provider = new OllamaProvider('glm:cloud', 1000);
  provider.addUser('task');
  const r = await provider.step({ system: 's', tools: [{ name: 'read_file', description: 'd', schema: { type: 'object', properties: {}, required: [] } }], signal: new AbortController().signal, onText: () => {}, onThinking: () => {}, onToolCall: (c) => announced.push(c) });
  assert.deepEqual(announced.map((c) => c.input.path), ['a.ts', 'b.ts']);
  assert.deepEqual(r.toolCalls.map((c) => c.id), announced.map((c) => c.id));
});

test('a 429 from Ollama becomes a usage-limit message with what to do, not the raw JSON', async () => {
  globalThis.fetch = (async (url: string) => {
    if (url.endsWith('/api/show')) return new Response(JSON.stringify({ capabilities: ['completion'] }));
    return new Response(JSON.stringify({ error: 'you have reached your monthly usage limit' }), { status: 429 });
  }) as typeof fetch;
  const provider = new OllamaProvider('glm:cloud', 1000);
  provider.addUser('task');
  const req: StepRequest = { system: 's', tools: [], signal: new AbortController().signal, onText: () => {}, onThinking: () => {} };
  await assert.rejects(provider.step(req), (e: Error) => {
    assert.equal(e.message, 'Limite de uso do Ollama atingido para "glm:cloud" (you have reached your monthly usage limit). Aguarde o limite renovar, adicione créditos em https://ollama.com/settings ou escolha outro modelo.');
    return true;
  });
});
