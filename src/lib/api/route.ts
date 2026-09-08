import { after } from "next/server";
import { getDb, type Db } from "@/db";
import { bumpMetric } from "@/lib/domain/metrics";
import { fail } from "./http";
import { caller, guard, type Caller } from "./keys";
import type { OpContext } from "./operations";
import { emitMatchEvent } from "./webhooks";

export type ApiRequestContext = { db: Db; caller: Caller; ops: OpContext };

/** Shared plumbing for every REST route: database, caller, rate limit, metrics, error shape. */
export async function withApi(req: Request, scope: "read" | "write" | "keys" | null, handler: (ctx: ApiRequestContext) => Promise<Response>): Promise<Response> {
  try {
    const db = await getDb();
    const c = await caller(db, req);
    if (scope) await guard(db, c, scope);
    void bumpMetric(db, "api_calls").catch(() => undefined);
    if (isAssistantCaller(req, c)) void bumpMetric(db, "api_calls_agent").catch(() => undefined);
    const ops: OpContext = {
      afterwards: (fn) => after(fn),
      emit: (event, code, extra) => after(() => emitMatchEvent(db, event, code, extra)),
    };
    return await handler({ db, caller: c, ops });
  } catch (e) {
    return fail(e);
  }
}

export const READ_CACHE = "public, max-age=0, s-maxage=30, stale-while-revalidate=120";

const ASSISTANT_UA = /claude|anthropic|openai|chatgpt|gpt-|gemini|perplexity|cursor|copilot|mcp|langchain|llamaindex|autogpt|agent|assistant|python-requests|node-fetch|undici|httpx|aiohttp|go-http-client|okhttp/i;

/** An assistant or a program rather than a browser: by the key's declared agent, or by a user agent that is not a browser's. */
export function isAssistantCaller(req: Request, c: Caller): boolean {
  const agent = (c.key as { agent?: string | null } | null)?.agent;
  if (agent) return true;
  const ua = req.headers.get("user-agent") ?? "";
  if (!ua) return true;
  if (/mozilla\/5\.0/i.test(ua) && !/headless|bot|crawler|spider/i.test(ua)) return false;
  return ASSISTANT_UA.test(ua) || !/mozilla/i.test(ua);
}
