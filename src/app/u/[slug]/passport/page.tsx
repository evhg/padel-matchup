import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { Fragment } from "react";
import { Footer, Header } from "@/components/Header";
import { CopyButton } from "@/components/ShareSheet";
import { getDb } from "@/db";
import { baseUrl } from "@/lib/config";
import { bandOf, formatLevel } from "@/lib/domain/levels";
import { verifyPassport } from "@/lib/domain/passport";
import { getPublicPlayer, issuePassport, passportKeys, profileStats } from "@/lib/domain/profile";

export const dynamic = "force-dynamic";
type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const t = await getTranslations();
  return { title: t("passport.signed"), robots: { index: false, follow: true }, alternates: { canonical: `/u/${slug}` } };
}

/**
 * The signed level as a person sees it: what it says, who signed it, until when,
 * and that the signature checks out. The JSON that apps read is one tap away.
 */
export default async function PassportDocumentPage({ params }: Props) {
  const { slug } = await params;
  const db = await getDb();
  const p = await getPublicPlayer(db, slug);
  if (!p) notFound();
  const [t, locale, stats] = await Promise.all([getTranslations(), getLocale(), profileStats(db, p)]);
  const base = baseUrl();
  const doc = await issuePassport(p, stats, base);
  const keys = passportKeys();
  const ok = doc.alg === "Ed25519" && keys ? await verifyPassport(doc, keys.pub) : false;
  const fmt = new Intl.DateTimeFormat(locale, { day: "numeric", month: "long", year: "numeric" });
  const jsonUrl = `${base}/u/${slug}/passport.json`;
  const facts = [
    { label: t("passport.docLevel"), value: doc.level != null ? `${formatLevel(doc.level)} · ${t(`level.bands.${bandOf(doc.level)}`)}` : t("passport.noLevel") },
    ...(doc.level != null ? [{ label: t("passport.docStatus"), value: doc.verified ? t("passport.verifiedBy") : doc.source === "adjusted" ? t("passport.adjusted") : t("passport.selfDeclared") }] : []),
    { label: t("passport.docRecord"), value: t("passport.docPlayedWon", { played: doc.played, won: doc.won }) },
    { label: t("passport.docIssued"), value: fmt.format(new Date(doc.issuedAt)) },
    { label: t("passport.docExpires"), value: fmt.format(new Date(doc.expiresAt)) },
  ];
  return (
    <>
      <Header />
      <main className="mx-auto flex w-full max-w-xl flex-col gap-4 px-4 pt-2 pb-12">
        <section className="card">
          <span className="chip-muted">🔏 {t("passport.signed")}</span>
          <h1 className="mt-3 text-3xl font-extrabold leading-tight tracking-tight">{doc.name}</h1>
          <p className="mt-2 text-sm text-muted">{t("passport.docIntro", { issuer: base.replace(/^https?:\/\//, "") })}</p>
          <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
            {facts.map((f) => (
              <Fragment key={f.label}>
                <dt className="pt-0.5 text-[11px] font-bold uppercase tracking-wider text-faint">{f.label}</dt>
                <dd className="font-semibold">{f.value}</dd>
              </Fragment>
            ))}
          </dl>
          <p className={`mt-4 rounded-2xl px-4 py-3 text-sm font-semibold ${ok ? "bg-ok-soft text-ok" : "bg-warn-soft text-warn"}`}>{ok ? `✓ ${t("passport.docSignatureOk", { kid: doc.kid })}` : t("passport.docUnsigned")}</p>
        </section>

        <section className="card">
          <h2 className="text-base font-extrabold">{t("passport.docForApps")}</h2>
          <p className="mt-1 text-xs text-muted">{t("passport.docForAppsHelp")}</p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <CopyButton value={jsonUrl} label={t("passport.docCopyLink")} copiedLabel={t("common.copied")} className="btn-ghost btn-sm" />
            <a href={jsonUrl} className="btn-ghost btn-sm" rel="nofollow">
              {t("passport.docOpenJson")}
            </a>
            <Link href="/developers#passport" prefetch={false} className="btn-ghost btn-sm">
              {t("passport.verify")} →
            </Link>
          </div>
          <details className="mt-3 text-sm">
            <summary className="cursor-pointer font-semibold">{t("passport.docShow")}</summary>
            <pre className="mt-2 overflow-x-auto rounded-2xl bg-bg p-3 font-mono text-[11px] leading-relaxed">{JSON.stringify(doc, null, 2)}</pre>
          </details>
        </section>

        <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
          <Link href={`/u/${slug}`} prefetch={false} className="link">
            ← {t("passport.docBack", { name: doc.name })}
          </Link>
          <Link href="/" prefetch={false} className="link">
            + {t("common.newMatch")}
          </Link>
        </div>
      </main>
      <Footer />
    </>
  );
}
