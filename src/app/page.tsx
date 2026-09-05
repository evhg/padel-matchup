import type { Metadata } from "next";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { CreateScreen } from "@/components/CreateScreen";
import { Footer, Header } from "@/components/Header";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t("landing.metaTitle"), description: t("landing.metaDescription"), openGraph: { title: t("landing.metaTitle"), description: t("landing.metaDescription"), type: "website", url: "/" } };
}

/** The landing page is the create form. `?type=tournament&capacity=8` prefills it (used by the /americano generator). */
export default async function Home({ searchParams }: { searchParams: Promise<{ type?: string; capacity?: string; group?: string }> }) {
  const [t, sp] = await Promise.all([getTranslations(), searchParams]);
  return (
    <>
      <Header />
      <main className="mx-auto flex w-full max-w-xl flex-col gap-4 px-4 pt-2">
        <CreateScreen heading={t("landing.formTitle")} sub={t("landing.formSub")} prefill={{ type: sp.type, capacity: sp.capacity, group: sp.group }} />
        <section className="mt-6 grid gap-2">
          {[t("landing.step1"), t("landing.step2"), t("landing.step3")].map((s, i) => (
            <div key={i} className="flex items-center gap-3 px-1 text-sm text-muted">
              <span className="inline-grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-ink text-xs font-extrabold text-accent">{i + 1}</span>
              <span className="font-semibold">{s}</span>
            </div>
          ))}
        </section>
        <Link href="/americano" prefetch={false} className="mt-2 self-start px-1 text-sm link">
          {t("landing.americanoLink")}
        </Link>
      </main>
      <Footer spacious />
    </>
  );
}
