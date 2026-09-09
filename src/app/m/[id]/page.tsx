import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { Footer, Header } from "@/components/Header";
import { ShareButtons } from "@/components/ShareSheet";
import { getDb } from "@/db";
import { baseUrl } from "@/lib/config";
import { momentLine, momentWhere } from "@/lib/moments";
import { getMilestone } from "@/lib/domain/milestones";
import { taggedUrl } from "@/lib/source";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  const db = await getDb();
  const hit = await getMilestone(db, id);
  const [t, locale] = await Promise.all([getTranslations("moments"), getLocale()]);
  if (!hit) return { title: t("title"), robots: { index: false, follow: false } };
  const title = t("pageTitle", { name: hit.player.displayName, moment: await momentLine(hit.milestone, locale) });
  const image = { url: `${baseUrl()}/m/${id}/opengraph-image`, width: 1200, height: 630 };
  return { title, robots: { index: false, follow: true }, openGraph: { title, type: "website", url: `${baseUrl()}/m/${id}`, images: [image] }, twitter: { card: "summary_large_image", title, images: [image.url] } };
}

/** One earned moment, as a page whose link unfurls with the picture. Private by its id; shared by choice. */
export default async function MomentPage({ params }: Props) {
  const { id } = await params;
  const db = await getDb();
  const hit = await getMilestone(db, id);
  if (!hit) notFound();
  const [t, locale] = await Promise.all([getTranslations("moments"), getLocale()]);
  const line = await momentLine(hit.milestone, locale);
  const where = await momentWhere(db, hit.milestone, locale);
  const url = `${baseUrl()}/m/${id}`;
  const shareUrl = taggedUrl(url, "moment");
  return (
    <>
      <Header minimal />
      <main className="mx-auto flex w-full max-w-xl flex-col gap-4 px-4 pt-2 pb-12">
        <h1 className="text-2xl font-extrabold tracking-tight">{line}</h1>
        <div className="overflow-hidden rounded-2xl border border-line bg-white shadow-sm">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={`/m/${id}/opengraph-image`} alt={line} width={1200} height={630} className="block h-auto w-full" />
        </div>
        <p className="text-sm font-semibold">{hit.player.displayName}{where ? ` · ${where}` : ""}</p>
        <ShareButtons url={shareUrl} text={`${hit.player.displayName}: ${line} ${shareUrl}`} imageUrl={`/m/${id}/opengraph-image`} />
        <Link href="/" prefetch={false} className="btn-primary w-full text-lg">
          {t("cta")}
        </Link>
      </main>
      <Footer />
    </>
  );
}
