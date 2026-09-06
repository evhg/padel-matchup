import type { Metadata } from "next";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { AmericanoGenerator } from "@/components/AmericanoGenerator";
import { Footer, Header } from "@/components/Header";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return {
    title: t("americano.gen.title"),
    description: t("americano.gen.metaDescription"),
    alternates: { canonical: "/americano" },
    openGraph: { title: t("americano.gen.title"), description: t("americano.gen.metaDescription"), type: "website", url: "/americano" },
  };
}

/** Public, indexable utility page: the same rotation engine the live tournaments use, with a way in. */
export default async function AmericanoPage() {
  const t = await getTranslations();
  return (
    <>
      <Header />
      <main className="mx-auto flex w-full max-w-xl flex-col gap-4 px-4 pt-2 pb-12">
        <div>
          <h1 className="text-3xl font-extrabold tracking-tight">{t("americano.gen.title")}</h1>
          <p className="mt-1 text-muted">{t("americano.gen.sub")}</p>
        </div>
        <AmericanoGenerator />
        <p className="mt-4 text-sm text-muted">
          {t("americano.static.readyMade")}{" "}
          {[8, 12, 16, 20, 24].map((n, i) => (
            <span key={n}>
              {i > 0 ? " · " : ""}
              <Link href={`/americano/${n}`} prefetch={false} className="link">
                {n}
              </Link>
            </span>
          ))}
          {" · "}
          <Link href="/levels" prefetch={false} className="link">
            {t("levels.eyebrow")}
          </Link>
        </p>
        <details className="card no-print text-sm">
          <summary className="cursor-pointer list-none font-extrabold">{t("americano.title")} · ?</summary>
          <p className="mt-2 text-muted">{t("americano.howItWorks")}</p>
        </details>
      </main>
      <Footer />
    </>
  );
}
