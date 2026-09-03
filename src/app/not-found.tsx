import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { Footer, Header } from "@/components/Header";

export default async function NotFound() {
  const t = await getTranslations();
  return (
    <>
      <Header minimal />
      <main className="mx-auto flex w-full max-w-xl flex-col gap-4 px-4 pt-6">
        <section className="card text-center">
          <div className="text-6xl">🤷</div>
          <h1 className="mt-3 text-2xl font-extrabold">{t("notFound.title")}</h1>
          <p className="mt-2 text-muted">{t("notFound.body")}</p>
          <Link href="/new" className="btn-primary mt-5 w-full">
            {t("notFound.cta")}
          </Link>
        </section>
      </main>
      <Footer />
    </>
  );
}
