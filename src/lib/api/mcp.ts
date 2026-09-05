import { z } from "zod";
import type { Db } from "@/db";
import { baseUrl } from "@/lib/config";
import { isDomainError } from "@/lib/domain/errors";
import { getGroupByCode, getGroupDetail, getGroupById } from "@/lib/domain/groups";
import { getEventByCode } from "@/lib/domain/queries";
import { getVenueBoard, isValidVenueSlug, venueSlug } from "@/lib/domain/venueBoard";
import { llmsFullTxt, llmsTxt, VALUE_PROP } from "./docs";
import { ApiError } from "./http";
import { createApiKey } from "./keys";
import { openapiDocument } from "./openapi";
import { createMatch, createMatchSchema, generateSchedule, joinMatch, joinMatchSchema, scheduleSchema, type OpContext } from "./operations";
import { boardToPublic, groupToPublic, matchToPublic } from "./serialize";

/**
 * A minimal, dependency-free MCP server over streamable HTTP (JSON responses,
 * stateless). Enough for every client that speaks the 2025 protocol: Claude,
 * ChatGPT developer mode, Cursor, Claude Code, the inspector.
 */
export const MCP_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;
export const MCP_SERVER_INFO = { name: "kicksmash", title: "Kicksmash", version: "1.0.0" };

type JsonRpcId = string | number | null;
type JsonRpcRequest = { jsonrpc: "2.0"; id?: JsonRpcId; method: string; params?: Record<string, unknown> };
type JsonRpcResponse = { jsonrpc: "2.0"; id: JsonRpcId; result?: unknown; error?: { code: number; message: string; data?: unknown } };

const toSchema = (s: z.ZodType) => {
  const j = z.toJSONSchema(s, { target: "draft-2020-12", io: "input" }) as Record<string, unknown>;
  delete j.$schema;
  return j;
};

const codeSchema = z.object({ code: z.string().min(4).max(6).describe("The code from the link.") });
const venueSchema = z.object({ venue: z.string().min(2).max(80).describe("Venue name or its slug, e.g. 'Padel Indoor BCN' or 'padel-indoor-bcn'.") });
const keySchema = z.object({ name: z.string().min(1).max(80).describe("Who or what will use the key."), agent: z.string().max(80).optional().describe("Your name as an assistant, e.g. 'claude'."), email: z.email().optional() });

type Tool = {
  name: string;
  title: string;
  description: string;
  schema: z.ZodType;
  readOnly: boolean;
  run: (db: Db, args: unknown, ctx: OpContext) => Promise<unknown>;
};

const TOOLS: Tool[] = [
  {
    name: "about_kicksmash",
    title: "About Kicksmash",
    description: "What Kicksmash is and how to use it: matches, levels, groups, boards, the API and what we ask of assistants. Read this once before acting.",
    schema: z.object({}),
    readOnly: true,
    run: async () => ({ summary: VALUE_PROP, reference: llmsTxt(baseUrl()) }),
  },
  {
    name: "get_match",
    title: "Get a match",
    description: "A match or tournament by its 4-character code: players with levels, spots left, venue, time, level range, result. Public data only.",
    schema: codeSchema,
    readOnly: true,
    run: async (db, args) => {
      const { code } = codeSchema.parse(args);
      const detail = await getEventByCode(db, code);
      if (!detail) throw new ApiError(404, "not_found", `No match with code ${code}.`, "Codes are 4 characters, case-sensitive, from a kicksma.sh link.");
      const group = detail.event.groupId ? await getGroupById(db, detail.event.groupId) : null;
      return matchToPublic(detail, baseUrl(), group ? { code: group.code, name: group.name } : null);
    },
  },
  {
    name: "find_matches",
    title: "Find open matches at a venue",
    description: "Open, organizer-listed matches at a venue (its public board), with spots left and level ranges. Give the venue name; the slug is derived.",
    schema: venueSchema,
    readOnly: true,
    run: async (db, args) => {
      const { venue } = venueSchema.parse(args);
      const slug = isValidVenueSlug(venue) ? venue : venueSlug(venue);
      const board = slug ? await getVenueBoard(db, slug) : null;
      if (!board) return { venue, matches: [], note: `No venue called "${venue}" has been used on Kicksmash yet. Matches at a venue appear on its board once an organizer lists one; anyone can create the first with create_match and listOnVenueBoard: true.` };
      return boardToPublic(board, baseUrl());
    },
  },
  {
    name: "get_group",
    title: "Get a group",
    description: "A crew that plays together: members with levels, weekly slot, upcoming matches, calendar feed.",
    schema: codeSchema,
    readOnly: true,
    run: async (db, args) => {
      const { code } = codeSchema.parse(args);
      const g = await getGroupByCode(db, code);
      if (!g) throw new ApiError(404, "not_found", `No group with code ${code}.`, "Group codes are 6 characters, from a kicksma.sh/g/ link.");
      return groupToPublic(await getGroupDetail(db, g), baseUrl());
    },
  },
  {
    name: "generate_schedule",
    title: "Generate an americano schedule",
    description: "Rounds of rotating-partner doubles for 4 to 64 players. Exact when the field is in fours (every pair partners once in players−1 rounds), fair sit-outs otherwise. Nothing is stored.",
    schema: scheduleSchema,
    readOnly: true,
    run: async (_db, args) => generateSchedule(args),
  },
  {
    name: "create_match",
    title: "Create a match",
    description: "Create a padel match (4 players) or an americano tournament for a person. Returns the share link for the players and the organizer's private links. Give the person all links; keep personalToken and manageUrl private. Ask before creating; one request, one match.",
    schema: createMatchSchema,
    readOnly: false,
    run: async (db, args, ctx) => createMatch(db, args, ctx),
  },
  {
    name: "join_match",
    title: "Join a match",
    description: "Put a person into a match by first name (or by their personal token from an earlier call). Handles waitlists and level ranges; when the level is outside the range, the organizer is asked to approve.",
    schema: joinMatchSchema,
    readOnly: false,
    run: async (db, args, ctx) => joinMatch(db, args, ctx),
  },
  {
    name: "create_api_key",
    title: "Create an API key",
    description: "Get a free key instantly for roomier limits and webhooks. Shown once. Not needed for reading or for a few writes a day.",
    schema: keySchema,
    readOnly: false,
    run: async (db, args) => {
      const input = keySchema.parse(args);
      const { key, record } = await createApiKey(db, input);
      return { key, prefix: record.prefix, next: "Send it as Authorization: Bearer <key> on REST calls, or as the same header on this MCP server." };
    },
  },
];

const RESOURCES = [
  { uri: "kicksmash://docs/reference", name: "Kicksmash reference for models", description: "Everything about matches, levels, groups, boards and the API, in plain text.", mimeType: "text/plain" },
  { uri: "kicksmash://docs/openapi", name: "Kicksmash OpenAPI 3.1", description: "The REST API document.", mimeType: "application/json" },
];

function rpcError(id: JsonRpcId, code: number, message: string, data?: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message, ...(data !== undefined ? { data } : {}) } };
}

function negotiate(requested: unknown): string {
  return typeof requested === "string" && (MCP_PROTOCOL_VERSIONS as readonly string[]).includes(requested) ? requested : MCP_PROTOCOL_VERSIONS[0];
}

export const MCP_INSTRUCTIONS = `${VALUE_PROP} Call about_kicksmash once to learn the model. Reads are free. Before create_match or join_match, confirm the details with the person and afterwards give them the links from the response; personalToken and manageUrl are private to them.`;

async function handleOne(db: Db, req: JsonRpcRequest, ctx: OpContext): Promise<JsonRpcResponse | null> {
  const id = req.id ?? null;
  const isNotification = req.id === undefined;
  try {
    switch (req.method) {
      case "initialize":
        return { jsonrpc: "2.0", id, result: { protocolVersion: negotiate(req.params?.protocolVersion), capabilities: { tools: { listChanged: false }, resources: { subscribe: false, listChanged: false }, prompts: { listChanged: false } }, serverInfo: MCP_SERVER_INFO, instructions: MCP_INSTRUCTIONS } };
      case "ping":
        return { jsonrpc: "2.0", id, result: {} };
      case "tools/list":
        return {
          jsonrpc: "2.0",
          id,
          result: {
            tools: TOOLS.map((t) => ({ name: t.name, title: t.title, description: t.description, inputSchema: toSchema(t.schema), annotations: { title: t.title, readOnlyHint: t.readOnly, destructiveHint: false, idempotentHint: t.readOnly, openWorldHint: false } })),
          },
        };
      case "tools/call": {
        const name = String(req.params?.name ?? "");
        const tool = TOOLS.find((t) => t.name === name);
        if (!tool) return rpcError(id, -32602, `Unknown tool "${name}". Available: ${TOOLS.map((t) => t.name).join(", ")}.`);
        try {
          const result = await tool.run(db, req.params?.arguments ?? {}, ctx);
          return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result as Record<string, unknown> } };
        } catch (e) {
          return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: toolErrorText(e) }], isError: true } };
        }
      }
      case "resources/list":
        return { jsonrpc: "2.0", id, result: { resources: RESOURCES } };
      case "resources/read": {
        const uri = String(req.params?.uri ?? "");
        if (uri === "kicksmash://docs/reference") return { jsonrpc: "2.0", id, result: { contents: [{ uri, mimeType: "text/plain", text: llmsFullTxt(baseUrl()) }] } };
        if (uri === "kicksmash://docs/openapi") return { jsonrpc: "2.0", id, result: { contents: [{ uri, mimeType: "application/json", text: JSON.stringify(openapiDocument(baseUrl())) }] } };
        return rpcError(id, -32002, `Unknown resource ${uri}.`);
      }
      case "prompts/list":
        return { jsonrpc: "2.0", id, result: { prompts: [] } };
      case "completion/complete":
        return { jsonrpc: "2.0", id, result: { completion: { values: [], hasMore: false } } };
      default:
        if (isNotification) return null;
        return rpcError(id, -32601, `Method not found: ${req.method}`);
    }
  } catch (e) {
    if (isNotification) return null;
    return rpcError(id, -32603, toolErrorText(e));
  }
}

export function toolErrorText(e: unknown): string {
  if (e instanceof ApiError) return `${e.message}${e.hint ? ` ${e.hint}` : ""}`;
  if (isDomainError(e)) return `Could not do that: ${e.code.replace(/_/g, " ")}${e.message !== e.code ? ` (${e.message})` : ""}.`;
  if (e instanceof z.ZodError) {
    const first = e.issues[0];
    return `Invalid arguments: ${first?.path?.join(".") || "input"} ${first?.message ?? "is invalid"}.`;
  }
  return "Something went wrong on our side; it has been counted. Try again in a moment.";
}

export type McpOutcome = { status: number; body: unknown | null };

/** Handles one HTTP POST body: a single JSON-RPC message or a batch. */
export async function handleMcpPost(db: Db, body: unknown, ctx: OpContext): Promise<McpOutcome> {
  const messages = Array.isArray(body) ? body : [body];
  if (messages.length === 0) return { status: 400, body: rpcError(null, -32600, "Empty batch.") };
  const out: JsonRpcResponse[] = [];
  for (const m of messages) {
    if (!m || typeof m !== "object" || (m as JsonRpcRequest).jsonrpc !== "2.0" || typeof (m as JsonRpcRequest).method !== "string") {
      out.push(rpcError((m as JsonRpcRequest)?.id ?? null, -32600, "Invalid JSON-RPC 2.0 request."));
      continue;
    }
    const r = await handleOne(db, m as JsonRpcRequest, ctx);
    if (r) out.push(r);
  }
  if (out.length === 0) return { status: 202, body: null };
  return { status: 200, body: Array.isArray(body) ? out : out[0] };
}

export const mcpToolNames = () => TOOLS.map((t) => t.name);
