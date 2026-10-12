import { describe, expect, it } from "vitest";
import { countParts, heldSeats, lineupNames, namesThatFit, PREVIEW_MAX, previewText, TELL_MAX, tellGroupText } from "@/lib/domain/groupLine";
import { createTranslator } from "next-intl";
import { catalogue } from "./helpers/render";
import { formatWeekdayTime } from "@/lib/dates";
import { createRequestStoreForRender } from "next/dist/server/async-storage/request-store";
import { nativeShareData, tagForWhatsapp, tagMatchLinks, tagMatchUrl, telegramShareUrl, whatsappShareUrl } from "@/lib/share";
import { countedSource, isCrawler, isFullPageLoad, viewCounter } from "@/lib/source";

/**
 * The owner, 10 October 2026: "you have to leave the chat group". No link keeps a player inside a
 * WhatsApp group, so the trip out ends back in it: "Tell the group" after a join, and the line-up in
 * the preview under a pasted link. One line each, only what the match page already shows.
 */
describe("the line a group reads", () => {
  const roster = [
    { status: "joined", name: "Ana" },
    { status: "confirmed", name: "Bo" },
    { status: "invited", name: "Cy" },
    { status: "empty", name: null },
    { status: "declined", name: "Dee" },
  ];

  it("names the players who are in, in seat order, and never a spot held for somebody who has not said yes", () => {
    expect(lineupNames(roster)).toEqual(["Ana", "Bo"]);
    expect(heldSeats(roster)).toBe(1);
  });

  it("counts the held spots without their names, in the line and in the preview", () => {
    expect(tellGroupText({ when: "Sat 18:00", venue: "Rawai", names: ["Ana"], capacity: 4, held: "2 held", spots: "1 spot" }, "u")).toBe("🎾 Sat 18:00 · Rawai · 1/4: Ana · 2 held · 1 spot\nu");
    expect(previewText({ when: "Sat 18:00", venue: "Rawai", names: ["Ana"], capacity: 4, held: "2 held", spots: "1 spot" })).toBe("Ana · 2 held · 1 spot · Sat 18:00 Rawai");
  });

  it("is the line a player would type, then the match link on its own line", () => {
    const text = tellGroupText({ when: "Sat 18:00", venue: "Rawai", names: ["Ana", "Bo", "Cy"], capacity: 4, spots: "1 spot" }, "https://kicksma.sh/7KQ2?s=wa");
    expect(text).toBe("🎾 Sat 18:00 · Rawai · 3/4: Ana, Bo, Cy · 1 spot\nhttps://kicksma.sh/7KQ2?s=wa");
  });

  it("leaves out a court nobody chose yet, and says full when it is", () => {
    expect(tellGroupText({ when: "Sat 18:00", venue: null, names: ["Ana", "Bo", "Cy", "Di"], capacity: 4, spots: "full" }, "u")).toBe("🎾 Sat 18:00 · 4/4: Ana, Bo, Cy, Di · full\nu");
  });

  it("cuts a long field to '+N', so the spots stay in sight", () => {
    const names = Array.from({ length: 24 }, (_, i) => `Player${i + 1}`);
    const text = tellGroupText({ when: "Sat 18:00", venue: "Rawai", names, capacity: 24, spots: "full" }, "u");
    const line = text.split("\n")[0];
    expect(line.length).toBeLessThanOrEqual(TELL_MAX);
    expect(line).toMatch(/24\/24: Player1, Player2, .* \+\d+ · full$/);
    expect(namesThatFit(["Ana", "Bo", "Cy"], 10)).toBe("Ana, Bo +1");
  });

  it("carries no personal link, whatever the roster holds", () => {
    const text = tellGroupText({ when: "Sat 18:00", venue: "Rawai", names: lineupNames(roster), capacity: 4, spots: "1 spot" }, "https://kicksma.sh/7KQ2?s=wa");
    expect(text).not.toMatch(/\/p\/|\/i\/|manage/);
    expect(text).not.toContain("Cy");
    expect(whatsappShareUrl(text)).toMatch(/^https:\/\/wa\.me\/\?text=/);
  });

  it("is a preview of names, spots and time within what a phone shows", () => {
    expect(previewText({ when: "Sat 18:00", venue: "Rawai", names: ["Ana", "Bo", "Cy"], capacity: 4, spots: "1 spot" })).toBe("Ana, Bo, Cy · 1 spot · Sat 18:00 Rawai");
    const crowded = previewText({ when: "Sat 18:00", venue: "Rawai Padel Club & Fitness", names: Array.from({ length: 30 }, (_, i) => `Name${i}`), capacity: 32, spots: "2 spots" });
    expect(crowded.length).toBeLessThanOrEqual(PREVIEW_MAX);
    expect(crowded).toMatch(/\+\d+ · 2 spots · Sat 18:00 Rawai Padel Club & Fitness$/);
    // Over: no spots to offer, and nobody yet is the count alone.
    expect(previewText({ when: "Sat 18:00", venue: "Rawai", names: ["Ana"], capacity: 4, spots: null })).toBe("Ana · Sat 18:00 Rawai");
    expect(previewText({ when: "Sat 18:00", venue: null, names: [], capacity: 4, spots: "4 spots" })).toBe("4 spots · Sat 18:00");
  });

  it("says the day and time in the reader's language and the match's zone", () => {
    const at = new Date("2026-10-10T11:00:00Z"); // 18:00 in Bangkok, a Saturday
    expect(formatWeekdayTime(at, "Asia/Bangkok", "en")).toBe("Sat 18:00");
    expect(formatWeekdayTime(at, "Asia/Bangkok", "ru")).toMatch(/^сб.? 18:00$/i);
    expect(formatWeekdayTime(at, "Asia/Bangkok", "es")).toMatch(/^sáb.? 18:00$/i);
  });
});

describe("a WhatsApp link says it is one", () => {
  it("tags a bare match link ?s=wa, wherever it stands in the text", () => {
    expect(tagForWhatsapp("🎾 Padel Sat. Tap to join: https://kicksma.sh/7KQ2", "https://kicksma.sh/7KQ2")).toBe("🎾 Padel Sat. Tap to join: https://kicksma.sh/7KQ2?s=wa");
    expect(tagForWhatsapp("https://kicksma.sh/7KQ2 and again https://kicksma.sh/7KQ2.", "https://kicksma.sh/7KQ2")).toBe("https://kicksma.sh/7KQ2?s=wa and again https://kicksma.sh/7KQ2?s=wa.");
  });

  it("leaves an invitation, a link that already has a tag, and every other page as they are", () => {
    const invites = "Ana: https://kicksma.sh/7KQ2/i/abc123\nBo: https://kicksma.sh/7KQ2/i/def456";
    expect(tagForWhatsapp(invites, "https://kicksma.sh/7KQ2")).toBe(invites);
    expect(tagForWhatsapp("x https://kicksma.sh/7KQ2/card?s=card", "https://kicksma.sh/7KQ2/card?s=card")).toBe("x https://kicksma.sh/7KQ2/card?s=card");
    expect(tagForWhatsapp("Book me: https://kicksma.sh/c/olga", "https://kicksma.sh/c/olga")).toBe("Book me: https://kicksma.sh/c/olga");
  });
});

// Each step from a shared link to a seat is counted (docs/OPERATING.md, "From a shared link to a seat"):
// the share button tags the link, the match page counts a view by somebody with no seat under that tag,
// and the join and the new record count under the same tag.
describe("every share button says where the link went", () => {
  it("tags the Telegram share and the copied link as the WhatsApp share is tagged", () => {
    const url = "https://kicksma.sh/7KQ2";
    const tg = telegramShareUrl(tagMatchUrl(url, "tg"), tagMatchLinks(`Padel Sat: ${url}`, url, "tg"));
    expect(new URL(tg).searchParams.get("url")).toBe("https://kicksma.sh/7KQ2?s=tg");
    expect(new URL(tg).searchParams.get("text")).toBe("Padel Sat: https://kicksma.sh/7KQ2?s=tg");
    expect(tagMatchUrl(url, "link")).toBe("https://kicksma.sh/7KQ2?s=link");
    // Only a bare match link: a coach's student link or an invitation is copied as it is.
    expect(tagMatchUrl("https://kicksma.sh/c/olga", "link")).toBe("https://kicksma.sh/c/olga");
    expect(tagMatchUrl("https://kicksma.sh/7KQ2/i/abc123", "link")).toBe("https://kicksma.sh/7KQ2/i/abc123");
    expect(countedSource("tg")).toBe("tg");
    expect(countedSource("link")).toBe("link");
  });

  it("tags the phone's own share sheet ?s=share, with or without the picture", () => {
    const url = "https://kicksma.sh/7KQ2";
    const d = nativeShareData(url, `Padel Sat: ${url}`);
    expect(d.url).toBe("https://kicksma.sh/7KQ2?s=share");
    expect(d.text).toBe("Padel Sat:");
    // With a picture the sheet takes text only, so the tagged link rides in the text.
    expect(d.textWithLink).toBe("Padel Sat: https://kicksma.sh/7KQ2?s=share");
    expect(countedSource("share")).toBe("share");
    // A coach's page or an invitation is shared as it is.
    expect(nativeShareData("https://kicksma.sh/c/olga", "Book me").url).toBe("https://kicksma.sh/c/olga");
  });

  it("counts a match page view by a visitor with no seat, under the link's tag", () => {
    const phone = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148";
    const view = (o: { source: string | null; seated?: boolean; ua?: string; fullLoad?: boolean }) => viewCounter({ seated: false, ua: phone, fullLoad: true, ...o });
    expect(view({ source: "wa" })).toBe("view_src_wa");
    expect(view({ source: "link" })).toBe("view_src_link");
    expect(view({ source: null })).toBe("view_src_none");
    expect(view({ source: "my-cousin" })).toBe("view_src_other");
    // A player already in, or the organiser, is not a step of the funnel; a link preview is not a visitor.
    expect(view({ source: "wa", seated: true })).toBeNull();
    expect(view({ source: "wa", ua: "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)" })).toBeNull();
    expect(view({ source: "tg", ua: "TelegramBot (like TwitterBot)" })).toBeNull();
    // The sender's own phone fetches the link to build WhatsApp's preview, with no cookie: not a view.
    expect(view({ source: "wa", ua: "WhatsApp/2.23.20.0 A" })).toBeNull();
    expect(view({ source: "link", ua: "WhatsApp/2.24.1.78 i" })).toBeNull();
    // WhatsApp's in-app browser is a person, and still counts.
    expect(view({ source: "wa", ua: `${phone} WhatsApp/2.24.1.78` })).toBe("view_src_wa");
    // Only a full page load is a view: a refresh of an open page (AutoRefresh polls every 20 s on a
    // live night), a server action, a client navigation and a prefetch are not.
    expect(view({ source: "wa", fullLoad: false })).toBeNull();
    expect(isCrawler("")).toBe(false);
  });

  // Next.js deletes the RSC header and the other router headers before `headers()` returns
  // (getHeaders in next/dist/server/async-storage/request-store.js), so a guard on `rsc` never fired
  // and every 20-second refresh of a live night counted a view. The kind of request is read from the
  // headers Next.js keeps, through the same request store a page reads.
  it("tells a full page load from a refresh, a server action and a prefetch, by the headers a page can read", () => {
    const seen = (headers: Record<string, string>) => isFullPageLoad(createRequestStoreForRender({ headers } as never, undefined, { pathname: "/7KQ2" }, {}, undefined as never, undefined, undefined, false, undefined, undefined, null).headers);
    // A tapped link, a typed address, a reload by hand.
    expect(seen({ "sec-fetch-dest": "document", "sec-fetch-mode": "navigate" })).toBe(true);
    // A browser with no Sec-Fetch-* (Safari before 16.4, so iOS 15) is read by its Accept: a page load asks
    // for text/html; router.refresh() sets no Accept, so the browser sends */*, every 20 seconds.
    const html = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";
    expect(seen({ accept: html })).toBe(true);
    expect(seen({ rsc: "1", "next-router-state-tree": "%5B%22%22%5D", accept: "*/*" })).toBe(false);
    expect(seen({ accept: "*/*" })).toBe(false);
    expect(seen({})).toBe(false);
    // An old browser with Sec-Fetch-Dest says what it is; Accept does not overrule it.
    expect(seen({ "sec-fetch-dest": "empty", accept: html })).toBe(false);
    // router.refresh() (AutoRefresh) and a prefetch: a fetch() with the RSC header, which the page never sees.
    expect(seen({ rsc: "1", "next-router-state-tree": "%5B%22%22%5D", "sec-fetch-dest": "empty", "sec-fetch-mode": "cors" })).toBe(false);
    expect(seen({ rsc: "1", "next-router-prefetch": "1", "sec-fetch-dest": "empty" })).toBe(false);
    // A server action that re-renders the page (leave, a join request, stay updated).
    expect(seen({ "next-action": "7f3a", "sec-fetch-dest": "empty" })).toBe(false);
    expect(seen({ "next-action": "7f3a" })).toBe(false);
    // An iframe or an image request is not a view either.
    expect(seen({ "sec-fetch-dest": "iframe" })).toBe(false);
  });
});

/**
 * The owner's TDsv, 12 October 2026, at 390 px: "FULL", "3/4 players" and "No spots left" together, because
 * one place was held for Alberto. The count line now says so: "3/4 players · 1 place held for Alberto".
 */
describe("the match page's count line", () => {
  const say = (locale: "en" | "ru" | "es", roster: { status: string; name: string | null }[]) => {
    const t = createTranslator({ locale, messages: catalogue(locale) as never }) as unknown as (key: string, values?: Record<string, string | number>) => string;
    return countParts(roster).map((p) => t(p.key, p.values)).join(" · ");
  };
  const tdsv = [
    { status: "joined", name: "Erik" },
    { status: "joined", name: "Danny" },
    { status: "confirmed", name: "Ana" },
    { status: "invited", name: "Alberto" },
  ];

  it("the owner's case: a full line-up with a place held for a name says whose place it is, not \"No spots left\"", () => {
    expect(say("en", tdsv)).toBe("1 place held for Alberto");
    expect(say("ru", tdsv)).toBe("1 место забронировано для Alberto");
    expect(say("es", tdsv)).toBe("1 plaza reservada para Alberto");
  });

  it("a spot still open comes first, then the held places", () => {
    const open = [...tdsv.slice(0, 2), { status: "invited", name: "Alberto" }, { status: "invited", name: "Cy" }, { status: "empty", name: null }, { status: "declined", name: "Dee" }];
    expect(say("en", open)).toBe("2 spots left · 2 places held for Alberto, Cy");
    expect(say("ru", open)).toBe("2 места свободно · 2 места забронированы для Alberto, Cy");
  });

  it("nothing held reads as before, and many held places are a count", () => {
    expect(say("en", [{ status: "joined", name: "Erik" }, { status: "empty", name: null }])).toBe("1 spot left");
    expect(say("en", tdsv.slice(0, 3).map((s) => ({ ...s, status: "joined" })).concat({ status: "joined", name: "Bo" }))).toBe("No spots left");
    const night = ["Ana", "Bo", "Cy", "Di"].map((name) => ({ status: "invited", name }));
    expect(say("en", night)).toBe("4 places held");
  });
});
