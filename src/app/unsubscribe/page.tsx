import type { Metadata } from "next";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { stopEmailAction } from "@/actions/optout";
import { Footer, Header } from "@/components/Header";
import { getDb } from "@/db";
import { optOutState } from "@/lib/domain/optouts";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { robots: { index: false, follow: false } };

/**
 * The opt-out link from an invite email. Opening it asks first and changes nothing (`optOutState`): a
 * mail scanner that follows every link in a mail stopped all email to the person on its own visit.
 * "Yes, stop all email" posts, and the page then says it is done.
 */
export default async function UnsubscribePage({ searchParams }: { searchParams: Promise<{ e?: string; s?: string }> }) {
  const { e, s } = await searchParams;
  const t = await getTranslations();
  const view = await optOutState(await getDb(), e, s);
  const title = view.state === "bad" ? t("optout.badLinkTitle") : view.state === "done" ? t("optout.doneTitle") : t("optout.askTitle");
  const body = view.state === "bad" ? t("optout.badLinkBody") : view.state === "done" ? t("optout.doneBody", { email: view.email }) : t("optout.askBody", { email: view.email });
  return (
    <>
      <Header minimal />
      <main className="mx-auto flex w-full max-w-xl flex-col gap-4 px-4 pt-6">
        <section className="card text-center">
          <div className="text-4xl">{view.state === "bad" ? "🤔" : view.state === "done" ? "🙌" : "✉️"}</div>
          <h1 className="mt-3 text-2xl font-extrabold">{title}</h1>
          <p className="mt-2 text-muted">{body}</p>
          {view.state === "ask" && (
            <form action={stopEmailAction} className="mt-5">
              <input type="hidden" name="e" value={view.email} />
              <input type="hidden" name="s" value={s ?? ""} />
              <button type="submit" className="btn-primary w-full">
                {t("optout.askYes")}
              </button>
            </form>
          )}
          <Link href="/" prefetch={false} className="btn-ghost mt-3 w-full">
            {t("common.home")}
          </Link>
        </section>
      </main>
      <Footer />
    </>
  );
}
