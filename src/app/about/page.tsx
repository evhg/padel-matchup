import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { Footer, Header } from "@/components/Header";
import { emailFrom } from "@/lib/config";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t("about.title") };
}

/** The fine print: privacy, terms, open source. Short, honest, slightly cheeky. */
export default async function AboutPage() {
  const t = await getTranslations();
  const contact = emailFrom().match(/<([^>]+)>/)?.[1] ?? emailFrom();
  const sections: { key: "store" | "never" | "cookies" | "rights" | "terms" | "open" }[] = [{ key: "store" }, { key: "never" }, { key: "cookies" }, { key: "rights" }, { key: "terms" }, { key: "open" }];
  return (
    <>
      <Header minimal />
      <main className="mx-auto flex w-full max-w-xl flex-col gap-4 px-4 pt-2">
        <div>
          <h1 className="text-3xl font-extrabold tracking-tight">{t("about.title")}</h1>
          <p className="mt-1 text-muted">{t("about.sub")}</p>
        </div>
        {sections.map(({ key }) => (
          <section key={key} className="card">
            <h2 className="font-extrabold">{t(`about.${key}Title`)}</h2>
            <p className="mt-1 whitespace-pre-line text-sm text-ink-soft">{t(`about.${key}Body`)}</p>
          </section>
        ))}
        <p className="text-center text-xs text-faint">
          {t("about.contact")}{" "}
          <a className="link" href={`mailto:${contact}`}>
            {contact}
          </a>
        </p>
      </main>
      <Footer />
    </>
  );
}
