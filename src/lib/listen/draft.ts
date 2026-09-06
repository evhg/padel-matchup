import type { Db } from "@/db";
import { bumpMetric, dayKey } from "@/lib/domain/metrics";
import { sql } from "drizzle-orm";
import { metricsDaily } from "@/db/schema";
import type { Candidate } from "./parse";

/**
 * Drafting: one model call per candidate, strict JSON out, a daily budget
 * counted in metrics_daily so a capped key can never be surprised. The
 * tone rules live in the prompt and nowhere else.
 */
export const draftingEnabled = () => Boolean(process.env.ANTHROPIC_API_KEY);
const model = () => process.env.LISTEN_MODEL || "claude-sonnet-5";

/** Daily ceilings: well under 20 USD a month even on a bad day. */
export const BUDGET = { draftsPerDay: 40, inputTokensPerDay: 400_000, outputTokensPerDay: 60_000 } as const;

export type Draft = {
  relevant: boolean;
  kind: "asks_for_tool" | "asks_how_to" | "discussion" | "other";
  language: string;
  reply: string | null;
  reason: string;
  mentionsKicksmash: boolean;
};

/** The one list of what exists, shared by every prompt so no model ever invents a feature. */
export const PRODUCT_FACTS = "What exists: create a match or tournament with one short link, first-name joining, waitlist, calendar invites, levels 0-7 with ranges, americano/mexicano/King of the Court with live scores, groups with a weekly slot, venue boards, a Telegram bot, a Discord bot, a public API and MCP server, open data and code.";

export const SYSTEM_PROMPT = `You help a small open-source padel project (Kicksmash, https://kicksma.sh) take part in public conversations the way a knowledgeable, friendly club regular would: European and Asian tone, no hype, no sales language, never pushy.

You will receive one public post or comment. Decide whether a short reply from us would genuinely help the author, and if so write it.

Rules for the reply:
- Answer the actual question first, concretely and briefly (60 to 140 words). If you do not know, say what you would try.
- Mention kicksma.sh at most once, only when it directly solves what they ask (organising a match with one link, americano/mexicano/King of the Court schedules, a level range, a group's weekly slot, a bot for Telegram groups, an open API). Otherwise do not mention it at all.
- When you mention it, disclose in the same breath that you help build it ("I help build kicksma.sh, so take this with a grain of salt").
- Prefer giving the general answer (how to run an americano, how to keep a WhatsApp group from imploding) over the product.
- No emoji, no exclamation marks, no bullet lists unless the question is a list. Write in the language of the post.
- Official "apps and tools" megathreads are the one place where a short, factual, two-sentence description of kicksma.sh is welcome (what it is, that it is free and open source, one link); still no superlatives, still relevant=true only if the thread is current.
- Never invent features. ${PRODUCT_FACTS}

Set relevant=false and reply=null for: highlights, gear, rules of the game, professional tour talk, anything where a reply would be noise, and any post older than the conversation seems alive.

Respond with JSON only: {"relevant": boolean, "kind": "asks_for_tool"|"asks_how_to"|"discussion"|"other", "language": "en"|"ru"|"es"|"other", "reply": string|null, "reason": string, "mentionsKicksmash": boolean}`;

export type Usage = { input: number; output: number };

/** Tokens and drafts spent today, from the metrics table. */
export async function spentToday(db: Db, day = dayKey()): Promise<{ drafts: number; input: number; output: number }> {
  const rows = await db
    .select({ key: metricsDaily.key, value: metricsDaily.value })
    .from(metricsDaily)
    .where(sql`${metricsDaily.day} = ${day} and ${metricsDaily.key} in ('listen_drafts', 'anthropic_in', 'anthropic_out')`);
  const get = (k: string) => Number(rows.find((r) => r.key === k)?.value ?? 0);
  return { drafts: get("listen_drafts"), input: get("anthropic_in"), output: get("anthropic_out") };
}

export async function withinBudget(db: Db, now = new Date()): Promise<boolean> {
  const s = await spentToday(db, dayKey(now));
  return s.drafts < BUDGET.draftsPerDay && s.input < BUDGET.inputTokensPerDay && s.output < BUDGET.outputTokensPerDay;
}

/** One Messages API call with the JSON contract; usage is recorded even when the answer is unusable. */
export async function draftReply(db: Db, c: Pick<Candidate, "source" | "url" | "title" | "body" | "author" | "postedAt">, fetchImpl: typeof fetch = fetch, now = new Date(), o: { system?: string } = {}): Promise<{ draft: Draft | null; usage: Usage; error: string | null }> {
  if (!draftingEnabled()) return { draft: null, usage: { input: 0, output: 0 }, error: "drafting disabled" };
  const user = `Source: ${c.source}\nURL: ${c.url}\nPosted: ${c.postedAt.toISOString()}\nAuthor: ${c.author ?? "unknown"}\nTitle: ${c.title}\n\n${c.body || "(no body)"}`;
  try {
    const res = await fetchImpl("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY!, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: model(), max_tokens: 700, system: o.system ?? SYSTEM_PROMPT, messages: [{ role: "user", content: user }] }),
      signal: AbortSignal.timeout(45_000),
    });
    const json = (await res.json().catch(() => null)) as { content?: { type: string; text?: string }[]; usage?: { input_tokens: number; output_tokens: number }; error?: { message: string } } | null;
    const usage = { input: json?.usage?.input_tokens ?? 0, output: json?.usage?.output_tokens ?? 0 };
    const day = dayKey(now);
    await Promise.all([bumpMetric(db, "listen_drafts", 1, day), usage.input ? bumpMetric(db, "anthropic_in", usage.input, day) : null, usage.output ? bumpMetric(db, "anthropic_out", usage.output, day) : null]);
    if (!res.ok || !json) return { draft: null, usage, error: json?.error?.message ?? `HTTP ${res.status}` };
    const text = (json.content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
    const draft = parseDraft(text);
    return { draft, usage, error: draft ? null : "unparseable answer" };
  } catch (e) {
    return { draft: null, usage: { input: 0, output: 0 }, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Tolerates code fences and stray prose around the JSON object. */
export function parseDraft(text: string): Draft | null {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]) as Partial<Draft>;
    const kind = j.kind === "asks_for_tool" || j.kind === "asks_how_to" || j.kind === "discussion" ? j.kind : "other";
    const reply = typeof j.reply === "string" && j.reply.trim() ? j.reply.trim().slice(0, 1500) : null;
    const relevant = Boolean(j.relevant) && reply != null;
    return { relevant, kind, language: typeof j.language === "string" ? j.language : "en", reply: relevant ? reply : null, reason: typeof j.reason === "string" ? j.reason.slice(0, 300) : "", mentionsKicksmash: Boolean(j.mentionsKicksmash) || /kicksma\.sh/i.test(reply ?? "") };
  } catch {
    return null;
  }
}
