import { getTranslations } from "next-intl/server";
import { CreateScreen } from "@/components/CreateScreen";
import { Footer, Header } from "@/components/Header";

export default async function Home() {
  const t = await getTranslations();
  return (
    <>
      <Header />
      <main className="mx-auto flex w-full max-w-xl flex-col gap-4 px-4 pt-2">
        <CreateScreen heading={t("landing.formTitle")} sub={t("landing.formSub")} />
        <section className="mt-6 grid gap-2">
          {[t("landing.step1"), t("landing.step2"), t("landing.step3")].map((s, i) => (
            <div key={i} className="flex items-center gap-3 px-1 text-sm text-muted">
              <span className="inline-grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-ink text-xs font-extrabold text-accent">{i + 1}</span>
              <span className="font-semibold">{s}</span>
            </div>
          ))}
        </section>
      </main>
      <Footer />
    </>
  );
}
