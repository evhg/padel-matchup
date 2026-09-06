import type { Metadata } from "next";
import Link from "next/link";
import { ApiKeyForm } from "@/components/ApiKeyForm";
import { Footer, Header } from "@/components/Header";
import { CopyButton } from "@/components/ShareSheet";
import { PROOFS, VALUE_PROP } from "@/lib/api/docs";
import { WEBHOOK_EVENTS } from "@/lib/api/webhooks";
import { baseUrl } from "@/lib/config";
import { LIMITS } from "@/lib/domain/ratelimit";

export const metadata: Metadata = {
  title: "Developers and assistants",
  description: VALUE_PROP,
  alternates: { canonical: "/developers" },
  openGraph: { title: "Kicksmash for developers and assistants", description: VALUE_PROP, type: "website", url: "/developers" },
};

const Code = ({ children }: { children: string }) => (
  <div className="relative">
    <pre className="overflow-x-auto whitespace-pre-wrap [overflow-wrap:anywhere] rounded-2xl bg-ink py-3 pl-4 pr-20 text-[13px] leading-relaxed text-white">
      <code>{children}</code>
    </pre>
    <div className="absolute right-2 top-2">
      <CopyButton value={children} label="Copy" className="btn-ghost btn-xs bg-white/90" />
    </div>
  </div>
);

/** English only on purpose: the audience is developers and the assistants they use. */
export default function DevelopersPage() {
  const base = baseUrl();
  return (
    <>
      <Header />
      <main className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-4 pt-2 pb-16">
        <section>
          <span className="chip-muted">Developers · assistants · agents</span>
          <h1 className="mt-3 text-3xl font-extrabold leading-tight tracking-tight">{VALUE_PROP}</h1>
          <ul className="mt-4 flex flex-col gap-1.5 text-muted">
            {PROOFS.map((p) => (
              <li key={p} className="flex gap-2">
                <span className="text-ok">✓</span>
                <span>{p}</span>
              </li>
            ))}
          </ul>
        </section>

        <section className="card flex flex-col gap-3">
          <h2 className="text-lg font-extrabold">For assistants: add the MCP server</h2>
          <p className="text-sm text-muted">One URL. Reads need nothing; creating and joining works without a key within a daily allowance. Tools: about_kicksmash, get_match, find_matches, get_group, generate_schedule, create_match, join_match, create_api_key.</p>
          <Code>{`${base}/mcp`}</Code>
          <div className="grid gap-3 text-sm sm:grid-cols-2">
            <div>
              <div className="font-bold">Claude (web or desktop)</div>
              <p className="text-muted">Settings → Connectors → Add custom connector → paste the URL.</p>
            </div>
            <div>
              <div className="font-bold">Claude Code</div>
              <Code>{`claude mcp add --transport http kicksmash ${base}/mcp`}</Code>
            </div>
            <div>
              <div className="font-bold">ChatGPT</div>
              <p className="text-muted">Settings → Connectors → Advanced → Developer mode → Create → paste the URL, no authentication.</p>
            </div>
            <div>
              <div className="font-bold">Cursor, Windsurf, others</div>
              <Code>{`{ "mcpServers": { "kicksmash": { "url": "${base}/mcp" } } }`}</Code>
            </div>
          </div>
          <p className="text-sm text-muted">
            Discovery for machines: <a href="/llms.txt">/llms.txt</a>, <a href="/llms-full.txt">/llms-full.txt</a>, <a href="/.well-known/mcp.json">/.well-known/mcp.json</a>, <a href="/api/openapi.json">/api/openapi.json</a>. What we ask of assistants is on <Link href="/agents">/agents</Link>.
          </p>
        </section>

        <section className="card flex flex-col gap-3">
          <h2 className="text-lg font-extrabold">REST in three calls</h2>
          <p className="text-sm text-muted">Read a match (no key):</p>
          <Code>{`curl ${base}/api/v1/matches/PLAY`}</Code>
          <p className="text-sm text-muted">Create a match for someone (a key is optional; without one, {LIMITS.apiWritesPerIpPerDay} writes a day per address):</p>
          <Code>{`curl -X POST ${base}/api/v1/matches \\
  -H "Content-Type: application/json" \\
  -d '{"startsAt":"2026-09-11T19:00","tz":"Asia/Singapore","venue":"Club Nine",
       "organizer":{"name":"Ana"},"levelMin":3,"levelMax":4.5}'`}</Code>
          <p className="text-sm text-muted">Join by first name:</p>
          <Code>{`curl -X POST ${base}/api/v1/matches/AB12/join \\
  -H "Content-Type: application/json" -d '{"name":"Bo","level":3.5}'`}</Code>
          <p className="text-sm text-muted">
            Responses carry a <code>next</code> sentence saying what to do with the links. Errors carry a <code>hint</code>. The full contract is the <a href="/api/openapi.json">OpenAPI 3.1 document</a>.
          </p>
        </section>

        <section className="card flex flex-col gap-3">
          <h2 className="text-lg font-extrabold">A key, if you want more room</h2>
          <p className="text-sm text-muted">
            Instant, free, no approval. Raises writes to {LIMITS.apiWritesPerKeyPerDay} a day and unlocks webhooks. Assistants may request their own with the <code>create_api_key</code> tool or <code>POST /api/v1/keys</code>.
          </p>
          <ApiKeyForm />
        </section>

        <section className="card flex flex-col gap-3">
          <h2 className="text-lg font-extrabold">Webhooks</h2>
          <p className="text-sm text-muted">Signed callbacks on {WEBHOOK_EVENTS.join(", ")}. Filter by venue, group or match codes. Retried with backoff for a day.</p>
          <Code>{`curl -X POST ${base}/api/v1/webhooks -H "Authorization: Bearer ks_live_…" \\
  -H "Content-Type: application/json" \\
  -d '{"url":"https://example.com/hooks/kicksmash","events":["match.created","match.full"],"filter":{"venueSlug":"club-nine"}}'`}</Code>
          <p className="text-sm text-muted">
            Verify <code>X-Kicksmash-Signature: t=&lt;unix&gt;,v1=&lt;hex&gt;</code> as HMAC-SHA256 of <code>&quot;&lt;unix&gt;.&lt;raw body&gt;&quot;</code> with the secret returned at creation.
          </p>
        </section>

        <section className="card flex flex-col gap-3">
          <h2 className="text-lg font-extrabold">Calendars, feeds, embeds</h2>
          <ul className="flex flex-col gap-1.5 text-sm text-muted">
            <li>
              Group feed: <code>{base}/g/&#123;code&#125;/calendar.ics</code>. Venue feed: <code>{base}/v/&#123;slug&#125;/calendar.ics</code>. Subscribe once; every match lands in the calendar.
            </li>
            <li>
              Schedules without storing anything: <code>{base}/api/v1/schedule?players=8&amp;courts=2</code>.
            </li>
            <li>
              npm: <code>@kicksmash/americano</code> (americano, mexicano and King of the Court schedules) and <code>@kicksmash/levels</code> (the 0–7 scale, ranges, balanced teams, nudges) are the same pure modules this site runs, no dependencies, for your own tools.
            </li>
          </ul>
        </section>

        <section className="card flex flex-col gap-3">
          <h2 className="text-lg font-extrabold">Licence and limits</h2>
          <p className="text-sm text-muted">
            Code: <a href="https://github.com/evhg/padel-matchup/blob/main/LICENSE">Apache-2.0</a>. Public match, board, group and schedule data: <a href="https://creativecommons.org/licenses/by/4.0/">CC BY 4.0</a>, attribute &quot;Kicksmash, kicksma.sh&quot;. Personal data (emails, phones, tokens, manage links) is never in the public data.
          </p>
          <p className="text-sm text-muted">
            Limits without a key: {LIMITS.apiReadsPerIpPerHour} reads an hour, {LIMITS.apiWritesPerIpPerDay} writes a day per address, {LIMITS.mcpCallsPerIpPerHour} MCP calls an hour. With a key: five times the reads, {LIMITS.apiWritesPerKeyPerDay} writes a day, {LIMITS.webhooksPerKey} webhooks. Need more, or building something? Say so in{" "}
            <a href="https://github.com/evhg/padel-matchup/discussions">GitHub Discussions</a>
            {process.env.DISCORD_INVITE_URL ? (
              <>
                {" "}
                or on <a href={process.env.DISCORD_INVITE_URL}>Discord</a>
              </>
            ) : null}
            .
          </p>
          <p className="text-sm text-muted">
            Building your own padel tool with an assistant? <code>npx skills add evhg/padel-matchup</code> installs a skill that teaches it this API. The repository also carries an <code>AGENTS.md</code>.
          </p>
        </section>
      </main>
      <Footer />
    </>
  );
}
