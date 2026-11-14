import type { Judge } from './contract.js';
import type { Session } from './session.js';

const ATTEMPTS = 3;
const SYSTEM = 'You are the decision engine of a coding pipeline. Answer only with the JSON object requested, with no other text.';

type Schema = { type?: string; properties?: Record<string, Schema>; required?: string[]; items?: Schema; enum?: unknown[] };

export function schemaError(value: unknown, schema: Schema, at = 'value'): string | null {
  if (schema.enum && !schema.enum.includes(value)) return `${at} must be one of ${schema.enum.join(', ')}`;
  switch (schema.type) {
    case 'object': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return `${at} must be an object`;
      const obj = value as Record<string, unknown>;
      for (const key of schema.required ?? []) if (!(key in obj)) return `${at}.${key} is missing`;
      for (const [key, sub] of Object.entries(schema.properties ?? {})) {
        const error = key in obj ? schemaError(obj[key], sub, `${at}.${key}`) : null;
        if (error) return error;
      }
      return null;
    }
    case 'array': {
      if (!Array.isArray(value)) return `${at} must be an array`;
      for (const [i, item] of value.entries()) {
        const error = schema.items ? schemaError(item, schema.items, `${at}[${i}]`) : null;
        if (error) return error;
      }
      return null;
    }
    case 'string':
      return typeof value === 'string' ? null : `${at} must be a string`;
    case 'boolean':
      return typeof value === 'boolean' ? null : `${at} must be a boolean`;
    case 'number':
    case 'integer':
      return typeof value === 'number' ? null : `${at} must be a number`;
    default:
      return null;
  }
}

function parseJson(text: string): { value?: unknown; error?: string } {
  const fenced = /```(?:json)?\s*\n([\s\S]*?)\n```/.exec(text)?.[1];
  const raw = fenced ?? text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  if (!raw.trim()) return { error: 'no JSON object found in the answer' };
  try {
    return { value: JSON.parse(raw) };
  } catch (e) {
    return { error: `the answer is not valid JSON (${e instanceof Error ? e.message : String(e)})` };
  }
}

export function agentJudge(session: Session): Judge {
  const judge: Judge = {
    costUsd: 0,
    async ask<T>(prompt: string, schema: object, tools: string[]): Promise<T> {
      const before = session.costUsd() ?? 0;
      let provider: ReturnType<Session['newProvider']> | null = null;
      const reply = async (message: string): Promise<string> => {
        provider ??= session.newProvider();
        provider.addUser(message);
        const r = await provider.step({ system: SYSTEM, tools: [], signal: session.signal, onText: () => undefined, onThinking: () => undefined });
        session.addUsage(r.usage);
        return r.text;
      };
      const request = `${prompt}\n\nReply with only a JSON object that matches this JSON schema:\n${JSON.stringify(schema)}`;
      const role = tools.some((t) => t.startsWith('Bash')) ? 'critic' : 'explorer';
      let text = tools.length ? await session.spawn(role, request) : await reply(request);
      for (let attempt = 1; ; attempt++) {
        const parsed = parseJson(text);
        const error = parsed.error ?? schemaError(parsed.value, schema as Schema);
        if (!error) {
          judge.costUsd += (session.costUsd() ?? 0) - before;
          return parsed.value as T;
        }
        if (attempt >= ATTEMPTS) throw new Error(`motor de decisão não devolveu um JSON válido: ${error}`);
        const fix = `[schema] ${error}. Reply again with only the corrected JSON object.`;
        text = await reply(tools.length && attempt === 1 ? `${request}\n\nYour previous answer:\n${text}\n\n${fix}` : fix);
      }
    },
  };
  return judge;
}
