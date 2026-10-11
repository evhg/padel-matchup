import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { clickData, parsePreview, PREVIEW_MAX_BYTES, PREVIEW_USER_AGENT, previewTarget, readLinkPreview } from "@/lib/booking/unfurl";

/**
 * The one read of a pasted booking link, as a chat app's preview robot reads it (DECIDING rule 35, the
 * owner's words of 11 October 2026). Every fetch here is a stub: the fixture is a synthetic page of the
 * shape The Padel Society's Branch link gives that robot, with a made-up match (12345) and click id.
 */
const fixture = readFileSync(path.join(import.meta.dirname, "fixtures/paste/branch-preview.html"), "utf8");
const LINK = "https://thepadelsociety.app.link/AbCdEf12345";

type Call = { url: string; init: RequestInit | undefined };
function stub(answer: (url: string, n: number) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    return answer(url, calls.length);
  }) as typeof fetch;
  return { calls, fetchImpl };
}
const page = (html: string, o: { status?: number; type?: string } = {}) => new Response(html, { status: o.status ?? 200, headers: { "content-type": o.type ?? "text/html; charset=utf-8" } });
const redirect = (location: string, status = 307) => new Response(null, { status, headers: { location } });
const b64url = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const withClick = (data: unknown) => `<html><head><meta property="al:ios:url" content="padel-app://open?link_click_id&#x3D;link-1000000000000000001-${b64url(data)}" /></head></html>`;

describe("the read of a pasted link", () => {
  it("reads the synthetic Branch page: the generic title, and the kind of link with its match id", async () => {
    const { calls, fetchImpl } = stub(() => page(fixture));
    const preview = await readLinkPreview(LINK, { fetchImpl });
    expect(preview).toEqual({ title: "Join Padel Match Invitation", description: "Let's join our match to play together", siteName: null, ref: { type: "matchInvite", id: "12345" } });
    expect(calls).toHaveLength(1);
    const headers = new Headers(calls[0].init?.headers);
    expect(headers.get("user-agent")).toBe(PREVIEW_USER_AGENT);
    expect(PREVIEW_USER_AGENT).toContain("WhatsApp/2");
    expect(PREVIEW_USER_AGENT).toContain("+https://kicksma.sh/about#bot");
    expect(headers.has("cookie") || headers.has("authorization")).toBe(false);
    expect(calls[0].init?.method).toBe("GET");
    expect(calls[0].init?.redirect).toBe("manual");
  });

  it("makes no request for a host that is not a booking platform's", async () => {
    const { calls, fetchImpl } = stub(() => page(fixture));
    expect(await readLinkPreview("https://example.com/booking/1", { fetchImpl })).toBeNull();
    expect(await readLinkPreview("https://evilplaytomic.com/clubs/x", { fetchImpl })).toBeNull();
    expect(await readLinkPreview("https://app.link/x", { fetchImpl })).toBeNull();
    // thepadelsociety.app is no host of The Padel Society's that anybody showed: its name servers did
    // not answer on 11 October 2026, and whoever holds the zone would choose where the read connects.
    // Its Branch links (thepadelsociety.app.link) and its site (thepadelsociety.co) are the hosts.
    expect(await readLinkPreview("https://x.thepadelsociety.app/", { fetchImpl })).toBeNull();
    expect(await readLinkPreview("https://thepadelsociety.app/match/1", { fetchImpl })).toBeNull();
    expect(calls).toHaveLength(0);
    expect(previewTarget("https://www.thepadelsociety.co/club/warehaus")?.hostname).toBe("www.thepadelsociety.co");
  });

  it("makes no request for plain http, an address in figures, a user name or another port", async () => {
    const { calls, fetchImpl } = stub(() => page(fixture));
    for (const url of [
      "http://thepadelsociety.app.link/AbCdEf12345",
      "https://1.2.3.4/AbCdEf12345",
      "https://[::1]/AbCdEf12345",
      "https://user:secret@thepadelsociety.app.link/AbCdEf12345",
      "https://user@thepadelsociety.app.link/AbCdEf12345",
      "https://thepadelsociety.app.link:8443/AbCdEf12345",
      "padel-app://open?x=1",
      "not a link",
    ])
      expect(await readLinkPreview(url, { fetchImpl }), url).toBeNull();
    expect(calls).toHaveLength(0);
    // Port 443 is https's own, and the parser drops it.
    expect(previewTarget("https://thepadelsociety.app.link:443/AbCdEf12345")?.toString()).toBe(LINK);
  });

  it("stops at a redirect to an app store, and makes no second request", async () => {
    const { calls, fetchImpl } = stub(() => redirect("https://apps.apple.com/app/id1000000000"));
    expect(await readLinkPreview(LINK, { fetchImpl })).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it("stops at the app's own scheme and at another host, keeping what the address itself says", async () => {
    const click = { type: "matchInvite", matchId: 12345, $og_title: "Join Padel Match Invitation" };
    const scheme = stub(() => redirect(`padel-app://open?link_click_id=link-1000000000000000001-${b64url(click)}`));
    expect(await readLinkPreview(LINK, { fetchImpl: scheme.fetchImpl })).toEqual({ title: "Join Padel Match Invitation", description: null, siteName: null, ref: { type: "matchInvite", id: "12345" } });
    expect(scheme.calls).toHaveLength(1);
    const away = stub(() => redirect("https://evil.example.com/page"));
    expect(await readLinkPreview(LINK, { fetchImpl: away.fetchImpl })).toBeNull();
    expect(away.calls).toHaveLength(1);
  });

  it("follows a redirect on the platform's own hosts, three at most", async () => {
    const one = stub((url, n) => (n === 1 ? redirect("/s/abc", 301) : page(fixture)));
    expect((await readLinkPreview(LINK, { fetchImpl: one.fetchImpl }))?.ref).toEqual({ type: "matchInvite", id: "12345" });
    expect(one.calls.map((c) => c.url)).toEqual([LINK, "https://thepadelsociety.app.link/s/abc"]);
    const loop = stub((_, n) => redirect(`https://thepadelsociety.app.link/hop${n}`, 302));
    expect(await readLinkPreview(LINK, { fetchImpl: loop.fetchImpl })).toBeNull();
    expect(loop.calls).toHaveLength(4);
  });

  it("gives up on a 401, a 403, a 429, any other failure and a page that is not HTML, and never tries again", async () => {
    for (const status of [401, 403, 429, 404, 500]) {
      const { calls, fetchImpl } = stub(() => page(fixture, { status }));
      expect(await readLinkPreview(LINK, { fetchImpl }), String(status)).toBeNull();
      expect(calls).toHaveLength(1);
    }
    const json = stub(() => page('{"title":"x"}', { type: "application/json" }));
    expect(await readLinkPreview(LINK, { fetchImpl: json.fetchImpl })).toBeNull();
    const thrown = stub(() => {
      throw new TypeError("fetch failed");
    });
    expect(await readLinkPreview(LINK, { fetchImpl: thrown.fetchImpl })).toBeNull();
    const nothing = stub(() => page("<html><body>Nothing here</body></html>"));
    expect(await readLinkPreview(LINK, { fetchImpl: nothing.fetchImpl })).toBeNull();
  });

  it("ends a read that takes too long", async () => {
    const { fetchImpl } = stub(
      () =>
        new Promise<Response>(() => {
          /* never answers: the signal ends it */
        }),
    );
    const slow = (async (input: RequestInfo | URL, init?: RequestInit) => {
      void fetchImpl(input, init);
      return new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)));
    }) as typeof fetch;
    const started = Date.now();
    expect(await readLinkPreview(LINK, { fetchImpl: slow, timeoutMs: 50.7 })).toBeNull();
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("reads the first 256 KB of a page and stops the stream there", async () => {
    let pulled = 0;
    const head = '<html><head><meta property="og:title" content="Court booked" />';
    const filler = "<!-- " + "x".repeat(64 * 1024) + " -->";
    const tail = '<meta property="og:description" content="past the cut" /></head></html>';
    const chunks = [head, ...Array.from({ length: 8 }, () => filler), tail].map((s) => new TextEncoder().encode(s));
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        const next = chunks[pulled++];
        if (next) controller.enqueue(next);
        else controller.close();
      },
    });
    const { fetchImpl } = stub(() => new Response(body, { headers: { "content-type": "text/html" } }));
    const preview = await readLinkPreview(LINK, { fetchImpl });
    expect(preview).toEqual({ title: "Court booked", description: null, siteName: null, ref: null });
    // 256 KB is the head and four fillers; the stream was never read to its end.
    expect(PREVIEW_MAX_BYTES).toBe(262_144);
    expect(pulled).toBeLessThan(chunks.length);
  });
});

describe("what a page may carry", () => {
  it("keeps the type and the match id of the click data, and drops every other key", () => {
    const html = withClick({ type: "matchInvite", matchId: 12345, token: "secret-token", email: "a@b.c", "~channel": "facebook", $og_title: "Padel", nested: { matchId: 1 } });
    const preview = parsePreview(html);
    expect(preview).toEqual({ title: "Padel", description: null, siteName: null, ref: { type: "matchInvite", id: "12345" } });
    expect(JSON.stringify(preview)).not.toContain("secret");
    expect(Object.keys(preview!.ref!)).toEqual(["type", "id"]);
    expect(clickData(withClick({ type: "match", match_id: "8f14e45f-ceea-467f-a0e6-0c1d2b3a4f5e" }))?.ref).toEqual({ type: "match", id: "8f14e45f-ceea-467f-a0e6-0c1d2b3a4f5e" });
    expect(clickData(withClick({ type: "match", id: "777" }))?.ref).toEqual({ type: "match", id: "777" });
  });

  it("drops a type or an id that is not a plain word or a plain id", () => {
    expect(clickData(withClick({ type: "x\nhttps://evil", matchId: 12345 }))?.ref).toBeNull();
    expect(clickData(withClick({ type: "matchInvite", matchId: "x\nhttps://evil" }))?.ref).toBeNull();
    expect(clickData(withClick({ type: "matchInvite", matchId: "1".repeat(65) }))?.ref).toBeNull();
    expect(clickData(withClick({ type: "matchInvite", matchId: -1 }))?.ref).toBeNull();
    expect(clickData(withClick({ type: "<script>", matchId: 1 }))?.ref).toBeNull();
    // Click data that is no JSON, or no object, is nothing.
    expect(clickData('content="x?link_click_id=link-1-bm90IGpzb24"')).toBeNull();
    expect(clickData(withClick([1, 2, 3]))).toBeNull();
  });

  it("reads a page built to stall it in a moment: a long tag, a tag that never closes, a title that never closes", () => {
    // Each page is 256 KB, as much as a read takes. Before these bounds, the first took 42 s of CPU and
    // the second 5 s, after the four-second limit could no longer fire: the parse runs on the page in hand.
    const pages = {
      longTag: `<meta ${"a".repeat(PREVIEW_MAX_BYTES - 7)}>`,
      unclosedMeta: "<meta ".repeat(Math.floor(PREVIEW_MAX_BYTES / 6)),
      unclosedTitle: "<title ".repeat(Math.floor(PREVIEW_MAX_BYTES / 7)),
      longName: `<meta ${"a".repeat(4000)} property="og:title" content="Still read">`.repeat(Math.floor(PREVIEW_MAX_BYTES / 4060)),
    };
    // The fastest of three parses, under one second: a stall (5 s and 42 s before the bounds) fails every
    // one of the three, while a busy machine (four gates at once: 262 ms on 11 October) slows only some.
    for (const [name, html] of Object.entries(pages)) {
      expect(html.length, name).toBeLessThanOrEqual(PREVIEW_MAX_BYTES);
      let fastest = Infinity;
      for (let i = 0; i < 3; i++) {
        const started = performance.now();
        parsePreview(html);
        fastest = Math.min(fastest, performance.now() - started);
      }
      expect(fastest, name).toBeLessThan(1000);
    }
    // A tag of ordinary length after a long one is still read.
    expect(parsePreview(`<meta ${"a".repeat(5000)}><meta property="og:title" content="Court 3">`)?.title).toBe("Court 3");
  });

  it("decodes entities, trims every value to 300 characters and keeps one line", () => {
    const long = "A".repeat(400);
    const html = `<meta content="Ana &amp; Bo&#39;s &#x2014; match" property="og:title"><meta name='twitter:description' content='line one\nline two'><meta property="og:site_name" content="${long}">`;
    expect(parsePreview(html)).toEqual({ title: "Ana & Bo's — match", description: "line one line two", siteName: "A".repeat(300), ref: null });
    expect(parsePreview("<title>Only &lt;the&gt; title</title>")).toEqual({ title: "Only <the> title", description: null, siteName: null, ref: null });
  });
});
