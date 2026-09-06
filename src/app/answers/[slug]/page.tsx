import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { Footer, Header } from "@/components/Header";
import { getDb } from "@/db";
import { baseUrl } from "@/lib/config";
import { getPublishedAnswer } from "@/lib/listen/answers";

export const dynamic = "force-dynamic";
type Props = { params: Promise<{ slug: string }> };
const valid = (s: string) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(s) && s.length <= 80;

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const db = await getDb();
  const a = valid(slug) ? await getPublishedAnswer(db, slug) : null;
  if (!a) return { title: "Answers", robots: { index: false } };
  const description = a.answer.slice(0, 155).replace(/\s+\S*$/, "") + (a.answer.length > 155 ? "…" : "");
  return { title: a.title, description, alternates: { canonical: `/answers/${a.slug}` }, openGraph: { title: a.title, description, type: "article", url: `${baseUrl()}/answers/${a.slug}`, locale: a.language } };
}

/** One evergreen answer, marked up as a Q&A page for search engines and assistants alike. */
export default async function AnswerPage({ params }: Props) {
  const { slug } = await params;
  if (!valid(slug)) notFound();
  const db = await getDb();
  const a = await getPublishedAnswer(db, slug);
  if (!a) notFound();
  const t = await getTranslations();
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "QAPage",
    inLanguage: a.language,
    mainEntity: {
      "@type": "Question",
      name: a.title,
      text: a.question,
      answerCount: 1,
      acceptedAnswer: { "@type": "Answer", text: a.answer, url: `${baseUrl()}/answers/${a.slug}`, author: { "@type": "Organization", name: "Kicksmash", url: baseUrl() } },
    },
  };
  return (
    <>
      <Header />
      <main className="mx-auto flex w-full max-w-xl flex-col gap-4 px-4 pt-2 pb-12" lang={a.language}>
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
        <article className="card">
          <Link href="/answers" prefetch={false} className="text-xs font-bold uppercase tracking-wider text-faint hover:text-ink">
            ← {t("answers.eyebrow")}
          </Link>
          <h1 className="mt-3 text-2xl font-extrabold leading-tight tracking-tight">{a.title}</h1>
          <p className="mt-3 whitespace-pre-wrap text-sm text-muted">{a.question}</p>
          <div className="mt-4 whitespace-pre-wrap text-[15px] leading-relaxed">{a.answer}</div>
          <p className="mt-5 border-t border-line pt-3 text-xs text-faint">{t("answers.footer")}</p>
        </article>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
          <Link href="/" prefetch={false} className="link">
            {t("common.newMatch")} →
          </Link>
          <Link href="/americano" prefetch={false} className="link">
            {t("americano.gen.title")} →
          </Link>
        </div>
      </main>
      <Footer />
    </>
  );
}
