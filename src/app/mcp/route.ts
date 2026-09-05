import { NextResponse } from "next/server";
import { after } from "next/server";
import { getDb } from "@/db";
import { CORS_HEADERS, fail, json, options, readJson } from "@/lib/api/http";
import { caller, guard } from "@/lib/api/keys";
import { handleMcpPost, MCP_PROTOCOL_VERSIONS } from "@/lib/api/mcp";
import type { OpContext } from "@/lib/api/operations";
import { emitMatchEvent } from "@/lib/api/webhooks";
import { bumpMetric } from "@/lib/domain/metrics";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/** MCP over streamable HTTP, stateless: every POST is complete in itself; no server-initiated streams. */
export async function POST(req: Request) {
  try {
    const db = await getDb();
    const c = await caller(db, req);
    await guard(db, c, "mcp");
    void bumpMetric(db, "mcp_calls").catch(() => undefined);
    const ctx: OpContext = {
      afterwards: (fn) => after(fn),
      emit: (event, code, extra) => after(() => emitMatchEvent(db, event, code, extra)),
    };
    const out = await handleMcpPost(db, await readJson(req), ctx);
    const version = req.headers.get("mcp-protocol-version") ?? MCP_PROTOCOL_VERSIONS[0];
    if (out.body === null) return new NextResponse(null, { status: out.status, headers: { ...CORS_HEADERS, "MCP-Protocol-Version": version } });
    return json(out.body, { status: out.status, headers: { "MCP-Protocol-Version": version } });
  } catch (e) {
    return fail(e);
  }
}

/** No SSE stream: clients that ask for one get a clear 405 and keep using POST. */
export async function GET() {
  return new NextResponse(JSON.stringify({ error: { code: "no_stream", message: "This MCP server is stateless: send JSON-RPC 2.0 over POST.", docs: "https://kicksma.sh/developers" } }), { status: 405, headers: { ...CORS_HEADERS, Allow: "POST, OPTIONS, DELETE", "Content-Type": "application/json" } });
}

export async function DELETE() {
  return new NextResponse(null, { status: 200, headers: CORS_HEADERS });
}

export async function OPTIONS() {
  return options();
}
