import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { CreateScreen } from "@/components/CreateScreen";
import { Footer, Header } from "@/components/Header";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t("create.title") };
}

export default async function NewEventPage() {
  const t = await getTranslations();
  return (
    <>
      <Header />
      <main className="mx-auto flex w-full max-w-xl flex-col gap-4 px-4 pt-2 pb-8">
        <CreateScreen heading={t("create.title")} />
      </main>
      <Footer />
    </>
  );
}
