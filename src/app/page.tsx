import Link from "next/link";
import { eq } from "drizzle-orm";
import { getTranslations } from "next-intl/server";
import { Footer, Header } from "@/components/Header";
import { getDb } from "@/db";
import { events } from "@/db/schema";
import { shortHost } from "@/lib/config";

export default async function Home() {
  const t = await getTranslations();
  let demoCode: string | null = null;
  try {
    const db = await getDb();
    const [demo] = await db.select({ code: events.code }).from(events).where(eq(events.code, "PLAY")).limit(1);
    demoCode = demo?.code ?? null;
  } catch {
    demoCode = null;
  }
  return (
    <>
      <Header />
      <main className="mx-auto flex w-full max-w-xl flex-col gap-6 px-4 pt-8">
        <section>
          <div className="inline-flex items-center gap-2 rounded-full bg-white px-3 py-1 text-xs font-extrabold uppercase tracking-wider text-muted ring-1 ring-line">
            <span className="h-2 w-2 rounded-full bg-accent" /> {shortHost()}
          </div>
          <h1 className="mt-4 text-5xl font-extrabold leading-[0.95] tracking-tighter">{t("landing.headline")}</h1>
          <p className="mt-4 text-lg text-muted">{t("landing.sub")}</p>
          <Link href="/new" className="btn-primary mt-6 w-full text-lg">
            {t("landing.cta")} →
          </Link>
          {demoCode && (
            <Link href={`/${demoCode}`} className="btn-ghost mt-2 w-full">
              {t("landing.demo")}
            </Link>
          )}
        </section>
        <section className="grid gap-3">
          {[t("landing.step1"), t("landing.step2"), t("landing.step3")].map((s, i) => (
            <div key={i} className="card flex items-center gap-4 py-4">
              <span className="inline-grid h-10 w-10 shrink-0 place-items-center rounded-2xl bg-ink text-lg font-extrabold text-accent">{i + 1}</span>
              <span className="font-bold">{s}</span>
            </div>
          ))}
        </section>
      </main>
      <Footer />
    </>
  );
}
