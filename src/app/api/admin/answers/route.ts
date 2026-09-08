import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { operatorAuthorized } from "@/lib/api/secret";
import { createAnswerPage, listAllAnswers, type AnswerPageInput } from "@/lib/listen/answers";

export const dynamic = "force-dynamic";

/**
 * Answer pages written by the operator or the daily loop (bearer CRON_SECRET or an operator Vercel token):
 *   GET  /api/admin/answers                       → the latest pages, all states
 *   POST /api/admin/answers { pages: [{ slug?, language, title, question, answer, publish? }] }
 * Published pages appear at /answers/<slug> at once and are pushed to IndexNow; the Sunday digest offers Unpublish.
 */
export async function GET(req: Request) {
  if (!(await operatorAuthorized(req))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const rows = await listAllAnswers(await getDb(), 100);
  return NextResponse.json({ ok: true, count: rows.length, answers: rows.map((a) => ({ id: a.id, slug: a.slug, language: a.language, title: a.title, publishedAt: a.publishedAt, unpublishedAt: a.unpublishedAt, createdAt: a.createdAt })) });
}

export async function POST(req: Request) {
  if (!(await operatorAuthorized(req))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => null)) as { pages?: unknown } | null;
  const pages = Array.isArray(body?.pages) ? (body!.pages as Record<string, unknown>[]) : [];
  if (pages.length === 0 || pages.length > 20) return NextResponse.json({ error: "pages: 1..20 required" }, { status: 400 });
  const db = await getDb();
  const out: { slug?: string; url?: string; title: string; error?: string }[] = [];
  for (const p of pages) {
    const input: AnswerPageInput = { slug: typeof p.slug === "string" ? p.slug : null, language: String(p.language ?? "en"), title: String(p.title ?? ""), question: String(p.question ?? ""), answer: String(p.answer ?? ""), publish: p.publish !== false };
    try {
      const row = await createAnswerPage(db, input);
      out.push({ slug: row.slug, url: `/answers/${row.slug}`, title: row.title });
    } catch (e) {
      out.push({ title: input.title, error: e instanceof Error ? e.message : "failed" });
    }
  }
  return NextResponse.json({ ok: out.every((o) => o.slug), pages: out }, { status: out.every((o) => o.slug) ? 201 : 207 });
}
