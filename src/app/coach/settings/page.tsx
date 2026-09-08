import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { CoachCalendar } from "@/components/coach/CoachCalendar";
import { CoachManagers } from "@/components/coach/CoachManagers";
import { CoachSettings } from "@/components/coach/CoachSettings";
import { Footer, Header } from "@/components/Header";
import { getDb } from "@/db";
import { listManagers } from "@/lib/coach/chains";
import { serviceAccountEmail } from "@/lib/coach/gcal";
import { formatHoursLine, getCoachForActor } from "@/lib/domain/coaching";
import { getSessionPlayer } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("coach");
  return { title: t("settings.title"), robots: { index: false, follow: false } };
}

export default async function CoachSettingsPage() {
  const db = await getDb();
  const me = await getSessionPlayer(db);
  const found = me ? await getCoachForActor(db, me.id) : null;
  if (!found) redirect("/coach");
  const { coach, role } = found;
  const [t, managers] = await Promise.all([getTranslations("coach"), listManagers(db, coach.id)]);
  return (
    <>
      <Header />
      <main className="mx-auto flex w-full max-w-xl flex-col gap-4 px-4 pt-2">
        <Link href="/coach" prefetch={false} className="text-sm text-muted hover:text-ink">
          ← {t("home.title")}
        </Link>
        <CoachSettings
          hasQr={Boolean(coach.qrAssetId)}
          qrUrl={coach.qrAssetId ? `/c/${coach.handle}/qr` : null}
          initial={{
            displayName: coach.displayName,
            clubs: coach.clubNames.join(", "),
            lessonMinutes: coach.lessonMinutes,
            hoursLines: Array.from({ length: 7 }, (_, d) => formatHoursLine(coach.hours[String(d)])),
            cutoffHours: coach.cutoffHours,
            latePasses: coach.latePasses,
            minNoticeHours: coach.minNoticeHours,
            promptpayId: coach.promptpayId ?? "",
            payLink: coach.payLink ?? "",
            whatsapp: coach.whatsapp ? `+${coach.whatsapp}` : "",
            isPublic: coach.isPublic,
            tz: coach.tz,
          }}
        />
        <CoachCalendar
          serviceEmail={serviceAccountEmail()}
          initial={{ gcalId: coach.gcalId ?? "", icalUrl: coach.icalUrl ?? "", status: coach.gcalStatus, syncedAt: coach.calendarSyncedAt?.toISOString() ?? null, error: coach.calendarError }}
        />
        <CoachManagers managers={managers.map((m) => ({ id: m.id, name: m.displayName }))} isOwner={role === "coach"} />
      </main>
      <Footer />
    </>
  );
}
