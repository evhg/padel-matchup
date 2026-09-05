import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { PrintButton } from "@/components/PrintButton";
import { QrPanel } from "@/components/ShareSheet";
import { getDb } from "@/db";
import { APP_NAME, baseUrl, shortHost } from "@/lib/config";
import { getVenueBoard, isValidVenueSlug } from "@/lib/domain/venueBoard";

export const dynamic = "force-dynamic";
type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const t = await getTranslations();
  return { title: `${t("venue.poster")} · ${slug}`, robots: { index: false, follow: false } };
}

/** One printable page: venue name, a big QR to the venue board, one line of instructions. */
export default async function PosterPage({ params }: Props) {
  const { slug } = await params;
  if (!isValidVenueSlug(slug)) notFound();
  const db = await getDb();
  const board = await getVenueBoard(db, slug);
  if (!board) notFound();
  const t = await getTranslations();
  const url = `${baseUrl()}/v/${slug}`;
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-xl flex-col items-center justify-center gap-6 px-6 py-10 text-center print:max-w-none">
      <div className="flex items-center gap-2 text-2xl font-extrabold tracking-tight">
        <span className="inline-grid h-9 w-9 place-items-center rounded-xl bg-ink">
          <span className="h-4 w-4 rounded-full bg-accent" />
        </span>
        {APP_NAME}
      </div>
      <h1 className="text-4xl font-extrabold leading-tight tracking-tight print:text-6xl">{t("venue.boardTitle", { venue: board.name })}</h1>
      <div className="[&_svg]:h-64 [&_svg]:w-64 print:[&_svg]:h-96 print:[&_svg]:w-96">
        <QrPanel url={url} />
      </div>
      <p className="max-w-md text-xl font-bold print:text-3xl">{t("venue.posterScan", { venue: board.name })}</p>
      <p className="text-lg font-extrabold tracking-tight text-muted print:text-2xl">
        {shortHost()}/v/{slug}
      </p>
      <div className="no-print flex flex-col items-center gap-2">
        <PrintButton label={`🖨 ${t("venue.print")}`} />
        <p className="text-xs text-faint">{t("venue.posterHint")}</p>
        <Link href={`/v/${slug}`} prefetch={false} className="link text-sm">
          ← {t("venue.board")}
        </Link>
      </div>
    </main>
  );
}
