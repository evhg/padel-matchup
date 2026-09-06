import type { Metadata } from "next";
import Link from "next/link";
import { isOwner } from "@/actions/listen";
import { ListenItemCard } from "@/components/admin/ListenItemCard";
import { Footer, Header } from "@/components/Header";
import { getDb } from "@/db";
import { draftingEnabled, spentToday } from "@/lib/listen/draft";
import { redditEnabled } from "@/lib/listen/reddit";
import { listItems, ownerTelegramId } from "@/lib/listen/tick";
import { telegramEnabled } from "@/lib/telegram/api";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Listening desk", robots: { index: false, follow: false } };

const STATUSES = ["drafted", "approved", "failed", "posted", "skipped", "irrelevant", "new"] as const;

/** The owner's desk: what people asked, what we would answer, one tap to post. Owner only (Telegram sign-in). */
export default async function ListenAdminPage({ searchParams }: { searchParams: Promise<{ item?: string; status?: string }> }) {
  const sp = await searchParams;
  const owner = await isOwner();
  if (!owner) {
    return (
      <>
        <Header minimal />
        <main className="mx-auto flex w-full max-w-xl flex-col gap-4 px-4 pt-2 pb-12">
          <section className="card">
            <h1 className="text-2xl font-extrabold">Listening desk</h1>
            <p className="mt-2 text-sm text-muted">{ownerTelegramId() ? "Sign in with Telegram on My matches with the owner account to open this page." : "Set TELEGRAM_OWNER_ID to the owner's Telegram id to enable this page."}</p>
            <Link href="/me" prefetch={false} className="btn-secondary mt-4 self-start">
              My matches
            </Link>
          </section>
        </main>
        <Footer />
      </>
    );
  }
  const db = await getDb();
  const status = STATUSES.includes(sp.status as (typeof STATUSES)[number]) ? (sp.status as (typeof STATUSES)[number]) : null;
  const [items, spent] = await Promise.all([listItems(db, status ? [status] : ["drafted", "approved", "failed", "posted"]), spentToday(db)]);
  const canPost = redditEnabled();
  return (
    <>
      <Header minimal />
      <main className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-4 pt-2 pb-12">
        <section className="card">
          <h1 className="text-2xl font-extrabold">Listening desk</h1>
          <p className="mt-1 text-sm text-muted">Public posts about organising padel, with a drafted reply. Nothing goes out without your tap. Approve posts on Reddit as u/kicksmash{canPost ? "" : " once the Reddit keys are set; until then Approve means copy and paste it yourself"}.</p>
          <div className="mt-3 flex flex-wrap gap-2 text-xs">
            <span className="chip-muted">drafting {draftingEnabled() ? "on" : "off"}</span>
            <span className="chip-muted">telegram {telegramEnabled() ? "on" : "off"}</span>
            <span className="chip-muted">reddit posting {canPost ? "on" : "off"}</span>
            <span className="chip-muted">today: {spent.drafts} drafts · {Math.round(spent.input / 1000)}k in · {Math.round(spent.output / 1000)}k out</span>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <Link href="/admin/listen" prefetch={false} className={`btn-xs ${status ? "btn-ghost" : "btn-secondary"}`}>
              queue
            </Link>
            {STATUSES.map((s) => (
              <Link key={s} href={`/admin/listen?status=${s}`} prefetch={false} className={`btn-xs ${status === s ? "btn-secondary" : "btn-ghost"}`}>
                {s}
              </Link>
            ))}
          </div>
        </section>
        {items.length === 0 && <p className="text-sm text-muted">Nothing here right now.</p>}
        {items.map((it) => (
          <ListenItemCard
            key={it.id}
            highlight={sp.item === it.id}
            item={{ id: it.id, source: it.source, url: it.url, title: it.title, body: it.body, author: it.author, postedAt: it.postedAt.toISOString(), status: it.status, kind: it.kind, language: it.language, draft: it.draft, draftReason: it.draftReason, replyUrl: it.replyUrl, lastError: it.lastError, canPost: canPost && it.source === "reddit" && Boolean(it.threadId) }}
          />
        ))}
      </main>
      <Footer />
    </>
  );
}
