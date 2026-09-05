import type { Metadata } from "next";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { Footer, Header } from "@/components/Header";
import { getDb } from "@/db";
import { addOptOut, optOutSignature } from "@/lib/domain/optouts";
import { normalizeEmail } from "@/lib/domain/players";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { robots: { index: false, follow: false } };

/** One click from an invite email: never contact this address on an organizer's behalf again. */
export default async function UnsubscribePage({ searchParams }: { searchParams: Promise<{ e?: string; s?: string }> }) {
  const { e, s } = await searchParams;
  const t = await getTranslations();
  const email = normalizeEmail(e);
  const valid = Boolean(email && s && optOutSignature(email) === s);
  if (valid && email) await addOptOut(await getDb(), email);
  return (
    <>
      <Header minimal />
      <main className="mx-auto flex w-full max-w-xl flex-col gap-4 px-4 pt-6">
        <section className="card text-center">
          <div className="text-4xl">{valid ? "🙌" : "🤔"}</div>
          <h1 className="mt-3 text-2xl font-extrabold">{valid ? t("optout.doneTitle") : t("optout.badLinkTitle")}</h1>
          <p className="mt-2 text-muted">{valid ? t("optout.doneBody", { email: email ?? "" }) : t("optout.badLinkBody")}</p>
          <Link href="/" prefetch={false} className="btn-ghost mt-5 w-full">
            {t("common.home")}
          </Link>
        </section>
      </main>
      <Footer />
    </>
  );
}
