import type { Metadata } from "next";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { Footer, Header } from "@/components/Header";
import { getDb } from "@/db";
import { baseUrl } from "@/lib/config";
import { listPublishedAnswers } from "@/lib/listen/answers";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  const title = t("answers.title");
  const description = t("answers.metaDescription");
  return { title, description, alternates: { canonical: "/answers" }, openGraph: { title, description, type: "website", url: `${baseUrl()}/answers` } };
}

const LANG_LABEL: Record<string, string> = { en: "English", ru: "Русский", es: "Español" };

/** Evergreen answers to the questions people actually ask about organising padel. Grown from approved community replies. */
export default async function AnswersIndex() {
  const [t, db] = await Promise.all([getTranslations(), getDb()]);
  const rows = await listPublishedAnswers(db);
  const groups = new Map<string, typeof rows>();
  for (const r of rows) groups.set(r.language, [...(groups.get(r.language) ?? []), r]);
  return (
    <>
      <Header />
      <main className="mx-auto flex w-full max-w-xl flex-col gap-4 px-4 pt-2 pb-12">
        <section className="card">
          <span className="chip-muted">💬 {t("answers.eyebrow")}</span>
          <h1 className="mt-3 text-3xl font-extrabold leading-tight tracking-tight">{t("answers.title")}</h1>
          <p className="mt-2 text-sm text-muted">{t("answers.sub")}</p>
        </section>
        {rows.length === 0 && (
          <section className="card">
            <p className="text-sm text-muted">{t("answers.empty")}</p>
            <Link href="/americano" prefetch={false} className="link mt-3 inline-block text-sm">
              {t("americano.gen.title")} →
            </Link>
          </section>
        )}
        {[...groups.entries()].map(([lang, list]) => (
          <section key={lang} className="card">
            <h2 className="text-xs font-bold uppercase tracking-wider text-faint">{LANG_LABEL[lang] ?? lang}</h2>
            <ul className="mt-2 flex flex-col divide-y divide-line">
              {list.map((a) => (
                <li key={a.id}>
                  <Link href={`/answers/${a.slug}`} prefetch={false} className="block py-3 font-bold hover:text-court">
                    {a.title}
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </main>
      <Footer />
    </>
  );
}
