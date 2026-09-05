import type { Metadata } from "next";
import Link from "next/link";
import { Footer, Header } from "@/components/Header";
import { CHARTER, VALUE_PROP } from "@/lib/api/docs";
import { baseUrl } from "@/lib/config";

export const metadata: Metadata = {
  title: "For AI agents",
  description: "What assistants and agents may do with Kicksmash, and what we ask in return.",
  alternates: { canonical: "/agents" },
};

/** Written to be read by models as much as by people: short, declarative, with the URLs in one place. */
export default function AgentsPage() {
  const base = baseUrl();
  return (
    <>
      <Header />
      <main className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-4 pt-2 pb-16">
        <section>
          <span className="chip-muted">Collaboration charter</span>
          <h1 className="mt-3 text-3xl font-extrabold leading-tight tracking-tight">Assistants are welcome here.</h1>
          <p className="mt-3 text-muted">{VALUE_PROP} Every other padel platform blocks crawlers and offers no agent interface. Kicksmash does the opposite, on purpose: you can read, act and build. This page says how.</p>
        </section>
        <section className="flex flex-col gap-3">
          {CHARTER.map((c) => (
            <div key={c.h} className="card py-4">
              <h2 className="font-extrabold">{c.h}</h2>
              <p className="mt-1 text-sm text-muted">{c.p}</p>
            </div>
          ))}
        </section>
        <section className="card">
          <h2 className="text-lg font-extrabold">Endpoints, in one place</h2>
          <dl className="mt-3 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-2 text-sm">
            <dt className="text-muted">MCP</dt>
            <dd>
              <code>{base}/mcp</code>
            </dd>
            <dt className="text-muted">OpenAPI</dt>
            <dd>
              <a href="/api/openapi.json">{base}/api/openapi.json</a>
            </dd>
            <dt className="text-muted">Model reference</dt>
            <dd>
              <a href="/llms-full.txt">{base}/llms-full.txt</a>
            </dd>
            <dt className="text-muted">Discovery</dt>
            <dd>
              <a href="/.well-known/mcp.json">{base}/.well-known/mcp.json</a>
            </dd>
            <dt className="text-muted">Source</dt>
            <dd>
              <a href="https://github.com/evhg/padel-matchup">github.com/evhg/padel-matchup</a>
            </dd>
            <dt className="text-muted">Humans</dt>
            <dd>
              <Link href="/developers">{base}/developers</Link>
            </dd>
          </dl>
        </section>
      </main>
      <Footer />
    </>
  );
}
