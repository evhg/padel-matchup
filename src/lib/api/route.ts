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
