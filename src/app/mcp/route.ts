import { NextResponse } from "next/server";
import { after } from "next/server";
import { getDb } from "@/db";
import { CORS_HEADERS, fail, json, options, readJson } from "@/lib/api/http";
import { caller, guard } from "@/lib/api/keys";
import { handleMcpPost, mcpCaller, MCP_PROTOCOL_VERSIONS } from "@/lib/api/mcp";
import type { OpContext } from "@/lib/api/operations";
import { emitMatchEvent } from "@/lib/api/webhooks";
import { bumpMetric } from "@/lib/domain/metrics";
import { later } from "@/lib/alerts";
import { measured } from "@/lib/ops/cpu";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/** MCP over streamable HTTP, stateless: every POST is complete in itself; no server-initiated streams. */
async function post(req: Request) {
  try {
    const db = await getDb();
    const c = await caller(db, req);
    // A refused call costs a function start too, so the log names its caller as well (the body is not read for it).
    await guard(db, c, "mcp").catch((e) => {
      console.info("mcp_call", { ...mcpCaller(req.headers.get("user-agent"), null), refused: true });
      throw e;
    });
    await later(() => bumpMetric(db, "mcp_calls"));
    const ctx: OpContext = {
      afterwards: (fn) => after(fn),
      emit: (event, code, extra) => after(() => emitMatchEvent(db, event, code, extra, { channel: "mcp" })),
      channel: "mcp",
    };
    const body = await readJson(req);
    console.info("mcp_call", mcpCaller(req.headers.get("user-agent"), body));
    const out = await handleMcpPost(db, body, ctx);
    const version = req.headers.get("mcp-protocol-version") ?? MCP_PROTOCOL_VERSIONS[0];
    if (out.body === null) return new NextResponse(null, { status: out.status, headers: { ...CORS_HEADERS, "MCP-Protocol-Version": version } });
    return json(out.body, { status: out.status, headers: { "MCP-Protocol-Version": version } });
  } catch (e) {
    return fail(e);
  }
}

export const POST = measured("mcp", post);

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
