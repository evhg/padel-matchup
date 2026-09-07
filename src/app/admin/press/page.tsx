import type { Metadata } from "next";
import Link from "next/link";
import { isOwner } from "@/actions/listen";
import { PressItemCard, type PressCardItem } from "@/components/admin/PressItemCard";
import { Footer, Header } from "@/components/Header";
import { getDb } from "@/db";
import { ownerTelegramId } from "@/lib/listen/tick";
import { deskAddress, deskEnabled, listOutreach } from "@/lib/outreach/desk";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Press desk", robots: { index: false, follow: false } };

const VIEWS = { queue: ["draft", "failed", "approved"], inbox: ["received"], sent: ["sent"], skipped: ["skipped"] } as const;

/** The owner's press desk: emails we propose to send, and the ones that came back. Owner only (Telegram sign-in). */
export default async function PressDeskPage({ searchParams }: { searchParams: Promise<{ item?: string; view?: string }> }) {
  const sp = await searchParams;
  if (!(await isOwner())) {
    return (
      <>
        <Header minimal />
        <main className="mx-auto flex w-full max-w-xl flex-col gap-4 px-4 pt-2 pb-12">
          <section className="card">
            <h1 className="text-2xl font-extrabold">Press desk</h1>
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
  const view = (sp.view && sp.view in VIEWS ? sp.view : "queue") as keyof typeof VIEWS;
  const db = await getDb();
  const rows = await listOutreach(db, [...VIEWS[view]], 100);
  const items: PressCardItem[] = rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    moment: r.moment,
    counterpartEmail: r.counterpartEmail,
    counterpartName: r.counterpartName,
    org: r.org,
    subject: r.subject,
    body: r.body,
    status: r.status,
    notBefore: r.notBefore?.toISOString() ?? null,
    sentAt: r.sentAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
    lastError: r.lastError,
  }));
  return (
    <>
      <Header minimal />
      <main className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-4 pt-2 pb-12">
        <section className="card">
          <h1 className="text-2xl font-extrabold">Press desk</h1>
          <p className="mt-1 text-sm text-muted">
            Emails drafted for launch moments, sent from {deskAddress()} when you tap Send, and every reply that comes back. Nothing leaves without your tap.
          </p>
          <div className="mt-3 flex flex-wrap gap-2 text-xs">
            <span className="chip-muted">sending {deskEnabled() ? "on" : "off"}</span>
            <span className="chip-muted">{items.length} in this view</span>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            {(Object.keys(VIEWS) as (keyof typeof VIEWS)[]).map((v) => (
              <Link key={v} href={`/admin/press?view=${v}`} prefetch={false} className={`btn-xs ${view === v ? "btn-secondary" : "btn-ghost"}`}>
                {v}
              </Link>
            ))}
            <Link href="/admin/listen" prefetch={false} className="btn-xs btn-ghost">
              listening desk →
            </Link>
          </div>
        </section>
        {items.length === 0 && (
          <section className="card text-sm text-muted">
            {view === "queue" ? "Nothing waiting. Drafts appear here when a launch moment comes up." : view === "inbox" ? `Nothing received yet at ${deskAddress()}.` : "Nothing here."}
          </section>
        )}
        {items.map((it) => (
          <PressItemCard key={it.id} item={it} highlight={sp.item === it.id} canSend={deskEnabled()} />
        ))}
      </main>
      <Footer />
    </>
  );
}
