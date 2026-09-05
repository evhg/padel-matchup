import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { reportError } from "@/lib/alerts";
import { isDomainError, type DomainErrorCode } from "@/lib/domain/errors";

/** Open by design: any origin may read and write; keys and rate limits do the protecting. */
export const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, Accept, Mcp-Session-Id, MCP-Protocol-Version",
  "Access-Control-Expose-Headers": "Mcp-Session-Id, MCP-Protocol-Version, X-RateLimit-Scope",
  "Access-Control-Max-Age": "86400",
};

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly hint?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

const DOMAIN_STATUS: Record<DomainErrorCode, number> = {
  not_found: 404,
  cancelled: 409,
  past: 409,
  full: 409,
  closed: 409,
  already_in: 409,
  not_member: 403,
  forbidden: 403,
  invalid: 422,
  locked: 409,
  not_started: 409,
  not_participant: 403,
};

const DOMAIN_HINT: Partial<Record<DomainErrorCode, string>> = {
  not_found: "Check the code: match codes are 4 characters, group codes 6, venue slugs lower-case with dashes.",
  cancelled: "This match was cancelled. Create a new one with create_match or POST /api/v1/matches.",
  past: "This match already happened. Nobody can join a match after it started.",
  full: "The match is full and its waitlist is closed. Try another match or create one.",
  closed: "The match is full and its waitlist is closed.",
  already_in: "This player is already in the match. Nothing to do.",
  invalid: "One of the fields is out of range. The message names it.",
  forbidden: "This action needs the organizer. Ask the person who created the match to do it from their manage link.",
};

export function json(data: unknown, init: { status?: number; headers?: Record<string, string>; cache?: string } = {}): NextResponse {
  return NextResponse.json(data, {
    status: init.status ?? 200,
    headers: { ...CORS_HEADERS, "Cache-Control": init.cache ?? "no-store", ...(init.headers ?? {}) },
  });
}

export function errorBody(status: number, code: string, message: string, hint?: string) {
  return { error: { code, message, ...(hint ? { hint } : {}), status, docs: "https://kicksma.sh/developers" } };
}

/** Every failure becomes a sentence a person or an agent can act on. */
export function fail(e: unknown): NextResponse {
  if (e instanceof ApiError) return json(errorBody(e.status, e.code, e.message, e.hint), { status: e.status });
  if (isDomainError(e)) {
    const status = DOMAIN_STATUS[e.code] ?? 400;
    return json(errorBody(status, e.code, e.message === e.code ? humanize(e.code) : `${humanize(e.code)} (${e.message})`, DOMAIN_HINT[e.code]), { status });
  }
  if (e instanceof ZodError) {
    const first = e.issues[0];
    const path = first?.path?.join(".") || "body";
    return json(errorBody(422, "invalid_request", `${path}: ${first?.message ?? "invalid"}`, "Compare the request with the OpenAPI document at /api/openapi.json."), { status: 422 });
  }
  if (e instanceof SyntaxError) return json(errorBody(400, "bad_json", "The request body is not valid JSON.", "Send a JSON object with Content-Type: application/json."), { status: 400 });
  void reportError("server", e);
  return json(errorBody(500, "internal", "Something went wrong on our side. It has been counted; try again in a moment."), { status: 500 });
}

function humanize(code: string): string {
  return code.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

export function options(): NextResponse {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

const MAX_BODY = 64 * 1024;

export async function readJson(req: Request): Promise<unknown> {
  const text = await req.text();
  if (text.length > MAX_BODY) throw new ApiError(413, "too_large", "The request body is larger than 64 KB.");
  if (!text.trim()) return {};
  return JSON.parse(text);
}

export function clientIp(req: Request): string {
  return (req.headers.get("x-forwarded-for") ?? req.headers.get("x-real-ip") ?? "unknown").split(",")[0].trim().slice(0, 64);
}
