import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { FreeCourts } from "@/components/ClubBits";
import { ClubManageForm } from "@/components/ClubManageForm";
import { Footer, Header } from "@/components/Header";
import { getDb } from "@/db";
import { CITIES } from "@/lib/domain/cities";
import { clubStatus, getClubByToken } from "@/lib/domain/clubs";

export const dynamic = "force-dynamic";
type Props = { params: Promise<{ slug: string; token: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const t = await getTranslations();
  return { title: t("club.manageTitle", { club: slug }), robots: { index: false, follow: false } };
}

/** The club's private page: status of the claim, every field, the feed, free courts as players will see them. */
export default async function ClubManagePage({ params }: Props) {
  const { slug, token } = await params;
  const db = await getDb();
  const club = await getClubByToken(db, token);
  if (!club || club.slug !== slug) notFound();
  const t = await getTranslations();
  const status = clubStatus(club);
  return (
    <>
      <Header />
      <main className="mx-auto flex w-full max-w-xl flex-col gap-4 px-4 pt-2 pb-12">
        <section className="card">
          <span className="chip-muted">🏟 {t("club.eyebrow")}</span>
          <h1 className="mt-3 text-3xl font-extrabold leading-tight tracking-tight">{t("club.manageTitle", { club: club.name })}</h1>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <span className={`chip-muted ${status === "live" ? "text-ok" : status === "rejected" ? "text-warn" : ""}`}>{status === "live" ? `✓ ${t("club.statusLive")}` : status === "rejected" ? t("club.statusRejected") : `⏳ ${t("club.statusPending")}`}</span>
            {club.founding && <span className="chip-muted">🌱 {t("club.foundingBadge")}</span>}
            <Link href={`/v/${club.slug}`} prefetch={false} className="link text-sm">
              {t("club.openPage")} →
            </Link>
          </div>
          {status === "rejected" && <p className="mt-2 text-sm text-muted">{t("club.statusRejectedHelp")}</p>}
          {status === "pending" && <p className="mt-2 text-sm text-muted">{t("club.claimedHelp")}</p>}
        </section>
        <ClubManageForm
          token={token}
          cities={CITIES.map((c) => ({ slug: c.slug, name: c.name }))}
          initial={{
            website: club.website ?? "",
            bookingUrl: club.bookingUrl ?? "",
            mapUrl: club.mapUrl ?? "",
            courts: club.courts ? String(club.courts) : "",
            about: club.about ?? "",
            city: club.city ?? "",
            opensAt: club.opensAt ?? "",
            closesAt: club.closesAt ?? "",
            availabilityUrl: club.availabilityUrl ?? "",
            availabilityKind: club.availabilityKind ?? "ics_bookings",
          }}
        />
        <section className="card">
          <h2 className="text-lg font-extrabold">{t("club.freeToday")}</h2>
          <div className="mt-2">
            <FreeCourts club={club} />
          </div>
        </section>
      </main>
      <Footer />
    </>
  );
}
