import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { Footer, Header } from "@/components/Header";
import { baseUrl } from "@/lib/config";
import { buildHistory, mulberry32, rotationLength, scheduleRound, type RoundRef } from "@/lib/domain/americano";

export const dynamic = "force-static";
export const revalidate = 86400;

/** Fields in fours from 8 to 24: the exact rotation exists and the pages are worth indexing. */
const FIELDS = [8, 12, 16, 20, 24] as const;
type Field = (typeof FIELDS)[number];
const parseField = (s: string): Field | null => (FIELDS.includes(Number(s) as Field) ? (Number(s) as Field) : null);

export function generateStaticParams() {
  return FIELDS.map((n) => ({ players: String(n) }));
}

type Props = { params: Promise<{ players: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { players } = await params;
  const n = parseField(players);
  if (!n) return { robots: { index: false } };
  const t = await getTranslations();
  const courts = n / 4;
  const rounds = rotationLength(n) ?? 0;
  const title = t("americano.static.title", { players: n });
  const description = t("americano.static.metaDescription", { players: n, courts, rounds });
  return { title, description, alternates: { canonical: `/americano/${n}` }, openGraph: { title, description, type: "article", url: `${baseUrl()}/americano/${n}` } };
}

/** The full exact schedule for n players on n/4 courts: every pair partners once. Server-rendered, printable, indexable. */
export default async function AmericanoStaticPage({ params }: Props) {
  const { players } = await params;
  const n = parseField(players);
  if (!n) notFound();
  const t = await getTranslations();
  const courts = n / 4;
  const total = rotationLength(n)!;
  const ids = Array.from({ length: n }, (_, i) => `p${i + 1}`);
  const name = (id: string) => t("americano.static.player", { n: Number(id.slice(1)) });
  const rnd = mulberry32(n * 7919);
  const played: RoundRef[] = [];
  const rounds = [];
  for (let r = 0; r < total; r++) {
    const plan = scheduleRound(ids, r, buildHistory(played), rnd);
    played.push({ matches: plan.matches.map((m) => ({ a1: m.a[0], a2: m.a[1], b1: m.b[0], b2: m.b[1], sideA: null, sideB: null })), resting: [] });
    rounds.push(plan);
  }
  return (
    <>
      <Header />
      <main className="mx-auto flex w-full max-w-xl flex-col gap-4 px-4 pt-2 pb-12">
        <section className="card">
          <span className="chip-muted">🔁 {t("americano.gen.title")}</span>
          <h1 className="mt-3 text-3xl font-extrabold leading-tight tracking-tight">{t("americano.static.title", { players: n })}</h1>
          <p className="mt-2 text-sm text-muted">{t("americano.static.sub", { players: n, courts, rounds: total })}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Link href={`/?type=tournament&capacity=${n}`} prefetch={false} className="btn-primary">
              {t("americano.gen.live")}
            </Link>
            <Link href="/americano" prefetch={false} className="btn-secondary">
              {t("americano.static.customise")}
            </Link>
          </div>
        </section>

        <section className="card">
          <h2 className="text-lg font-extrabold">{t("americano.static.howTitle")}</h2>
          <ol className="mt-2 flex flex-col gap-1.5 text-sm text-muted">
            <li>1. {t("americano.static.how1", { players: n, courts })}</li>
            <li>2. {t("americano.static.how2")}</li>
            <li>3. {t("americano.static.how3", { rounds: total })}</li>
          </ol>
        </section>

        {rounds.map((r, i) => (
          <section key={i} className="card">
            <h2 className="font-extrabold">{t("americano.round", { n: i + 1 })}</h2>
            <div className="mt-2 flex flex-col gap-1.5 text-sm">
              {r.matches.map((m) => (
                <div key={m.court} className="grid grid-cols-[auto_1fr_auto_1fr] items-center gap-x-2 rounded-xl bg-bg px-3 py-2">
                  <span className="text-[11px] font-extrabold uppercase tracking-wider text-faint">{t("americano.court", { n: m.court })}</span>
                  <span className="font-semibold">
                    {name(m.a[0])} + {name(m.a[1])}
                  </span>
                  <span className="text-xs font-bold text-faint">{t("americano.vs")}</span>
                  <span className="font-semibold">
                    {name(m.b[0])} + {name(m.b[1])}
                  </span>
                </div>
              ))}
            </div>
          </section>
        ))}

        <section className="card">
          <h2 className="text-lg font-extrabold">{t("americano.static.otherSizes")}</h2>
          <div className="mt-2 flex flex-wrap gap-2">
            {FIELDS.filter((f) => f !== n).map((f) => (
              <Link key={f} href={`/americano/${f}`} prefetch={false} className="chip-muted hover:bg-line">
                {t("americano.static.players", { count: f })}
              </Link>
            ))}
            <Link href="/levels" prefetch={false} className="chip-muted hover:bg-line">
              {t("levels.eyebrow")}
            </Link>
          </div>
        </section>
      </main>
      <Footer />
    </>
  );
}
