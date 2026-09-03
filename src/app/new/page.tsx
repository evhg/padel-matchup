import type { Metadata } from "next";
import { headers } from "next/headers";
import { getTranslations } from "next-intl/server";
import { CreateEventForm } from "@/components/CreateEventForm";
import { Footer, Header } from "@/components/Header";
import { getDb } from "@/db";
import { isValidTimeZone } from "@/lib/dates";
import { getVenues } from "@/lib/domain/queries";
import { getSessionPlayer } from "@/lib/session";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t("create.title") };
}

export default async function NewEventPage() {
  const t = await getTranslations();
  const hdrs = await headers();
  const headerTz = hdrs.get("x-vercel-ip-timezone");
  const tzFromHeader = Boolean(headerTz && isValidTimeZone(headerTz));
  const defaultTz = tzFromHeader ? headerTz! : "UTC";
  const db = await getDb();
  const me = await getSessionPlayer(db);
  const venues = me ? await getVenues(db, me.id) : [];
  return (
    <>
      <Header />
      <main className="mx-auto flex w-full max-w-xl flex-col gap-4 px-4 pt-2 pb-8">
        <h1 className="text-3xl font-extrabold tracking-tight">{t("create.title")}</h1>
        <CreateEventForm defaultTz={defaultTz} tzFromHeader={tzFromHeader} venues={venues.map((v) => ({ name: v.name, mapUrl: v.mapUrl }))} hasIdentity={Boolean(me)} />
      </main>
      <Footer />
    </>
  );
}
