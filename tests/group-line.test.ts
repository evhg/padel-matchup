import { describe, expect, it } from "vitest";
import { countParts, heldSeats, lineupNames, namesThatFit, PREVIEW_MAX, previewText, shareMessage, shareMoment, TELL_MAX, tellGroupText, type ShareInput } from "@/lib/domain/groupLine";
import { createTranslator } from "next-intl";
import { catalogue } from "./helpers/render";
import { formatWeekdayTime } from "@/lib/dates";
import { createRequestStoreForRender } from "next/dist/server/async-storage/request-store";
import { nativeShareData, shareTextKey, tagForWhatsapp, tagMatchUrl, telegramShareFor, telegramShareUrl, whatsappShareUrl, withoutLink } from "@/lib/share";
import { countedSource, isCrawler, isFullPageLoad, viewCounter, viewCounters } from "@/lib/source";
import { organiserAlone } from "@/lib/domain/events";

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
  it("tags the Telegram share and the copied link as the WhatsApp share is tagged, and the Telegram message holds the link once", () => {
    const url = "https://kicksma.sh/7KQ2";
    const tg = telegramShareFor(url, `Padel Sat: ${url}`);
    expect(new URL(tg).searchParams.get("url")).toBe("https://kicksma.sh/7KQ2?s=tg");
    // Telegram puts the `url` beside the text, so the text carries no second copy (review, 9 November 2026).
    expect(new URL(tg).searchParams.get("text")).toBe("Padel Sat:");
    // A personal link's box: its own link once too.
    const personal = "https://kicksma.sh/7KQ2/i/abc123";
    const tgPersonal = new URL(telegramShareFor(personal, `Ana, I saved you a spot: ${personal}`));
    expect([tgPersonal.searchParams.get("url"), tgPersonal.searchParams.get("text")]).toEqual([personal, "Ana, I saved you a spot:"]);
    // "Send all invites in one message": the match link is the share's own, and the personal links in the text stay whole.
    const invites = `Sat 18:00\nAna: ${url}/i/abc123\nBo: ${url}/i/def456`;
    expect(new URL(telegramShareFor(url, invites)).searchParams.get("text")).toBe(invites);
    expect(withoutLink(`Join: ${url} now ${url}`, url)).toBe("Join: now");
    expect(telegramShareUrl("u", "t")).toBe("https://t.me/share/url?url=u&text=t");
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
    // A personal link that starts with the match link stays whole in the text (it lost its start before).
    expect(nativeShareData(url, `Ana: ${url}/i/abc123`).text).toBe(`Ana: ${url}/i/abc123`);
  });

  it("the share page and the match page take one share text: a full match with a waiting list says so", () => {
    expect(shareTextKey(0, "waitlist")).toBe("shareText.eventFull");
    expect(shareTextKey(0, "closed")).toBe("shareText.event");
    expect(shareTextKey(2, "waitlist")).toBe("shareText.event");
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

  // A new organiser's match that never fills has no seat to count, so nothing said whether anybody
  // opened its link at all (15 October 2026). `view_lone` rides beside the view while the organiser
  // holds the only seat: one more upsert, on such views only.
  it("counts view_lone beside the view while the organiser holds the only seat, and only then", () => {
    const phone = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/130.0 Mobile Safari/537.36";
    const views = (o: { source?: string | null; seated?: boolean; ua?: string; fullLoad?: boolean; lone: boolean }) => viewCounters({ source: "wa", seated: false, ua: phone, fullLoad: true, ...o });
    expect(views({ lone: true })).toEqual(["view_src_wa", "view_lone"]);
    expect(views({ lone: true, source: null })).toEqual(["view_src_none", "view_lone"]);
    expect(views({ lone: false })).toEqual(["view_src_wa"]);
    // Whatever is not a view is not a lone view either: the organiser, a seat, a preview, a refresh.
    expect(views({ lone: true, seated: true })).toEqual([]);
    expect(views({ lone: true, ua: "WhatsApp/2.23.20.0 A" })).toEqual([]);
    expect(views({ lone: true, fullLoad: false })).toEqual([]);
    // What the match page passes as `lone`: the organiser in the only taken seat, held places and empty seats aside.
    const seat = (status: string, playerId: string | null) => ({ status: status as never, playerId });
    expect(organiserAlone([seat("joined", "org"), seat("empty", null), seat("empty", null), seat("empty", null)], "org")).toBe(true);
    expect(organiserAlone([seat("confirmed", "org"), seat("invited", null), seat("declined", null), seat("empty", null)], "org")).toBe(true);
    expect(organiserAlone([seat("joined", "org"), seat("joined", "ana"), seat("empty", null), seat("empty", null)], "org")).toBe(false);
    expect(organiserAlone([seat("joined", "ana"), seat("empty", null), seat("empty", null), seat("empty", null)], "org")).toBe(false);
    expect(organiserAlone([seat("empty", null), seat("empty", null)], "org")).toBe(false);
    expect(organiserAlone([seat("joined", null)], null)).toBe(false);
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

/**
 * The one share (the owner, 9 November 2026: "Bottom bar (Recommended)"): one button, one message that fits
 * the state. The audit of the same day found "No spots left. Tap to join" on the share page and three
 * different messages for one match link on the organiser's page.
 */
describe("the one share's message, by the state of the match", () => {
  type L = "en" | "ru" | "es";
  const tr = (locale: L) => createTranslator({ locale, messages: catalogue(locale) as never }) as unknown as (key: string, values?: Record<string, string | number>) => string;
  const base = (locale: L, o: Partial<ShareInput> = {}): ShareInput => ({
    locale,
    over: false,
    result: null,
    heldNames: [],
    spots: 0,
    url: "https://kicksma.sh/6WC9",
    day: "Sun, Nov 15",
    time: "19:00",
    venue: "Club Padel Test",
    when: "Sun 19:00",
    venueName: "Club Padel Test",
    names: ["Sofia"],
    capacity: 4,
    held: 0,
    waitlist: true,
    ...o,
  });
  const say = (locale: L, o: Partial<ShareInput>) => shareMessage(tr(locale), base(locale, o));

  it("picks the state: held places first, then open spots, then full; after the match only a result has one", () => {
    expect(shareMoment({ over: false, result: null, heldNames: ["Maria"], spots: 1 })).toBe("held");
    expect(shareMoment({ over: false, result: null, heldNames: [], spots: 2 })).toBe("open");
    expect(shareMoment({ over: false, result: null, heldNames: [], spots: 0 })).toBe("full");
    expect(shareMoment({ over: true, result: { line: "x", url: "u" }, heldNames: ["Maria"], spots: 3 })).toBe("result");
    expect(shareMoment({ over: true, result: null, heldNames: [], spots: 0 })).toBeNull();
  });

  it("held places the plain link fills: the held players' message, in every language", () => {
    const held = { heldNames: ["Maria", "Jordi"], held: 3, names: ["Sofia"] };
    expect(say("en", held)).toBe("🎾 Padel Sun, Nov 15 at 19:00 — Club Padel Test. I'm holding places for Maria and Jordi. Open the link and tap your name: https://kicksma.sh/6WC9");
    expect(say("ru", held)).toContain("Держу места для: Maria и Jordi");
    expect(say("es", held)).toContain("Guardo plazas para Maria y Jordi");
  });

  it("held places and an open spot: the message names both, and says how to join", () => {
    const both = { heldNames: ["Maria"], held: 1, spots: 1 };
    expect(say("en", both)).toBe("🎾 Padel Sun, Nov 15 at 19:00 — Club Padel Test. I'm holding a place for Maria, and 1 spot is open. Open the link: tap your name, or join: https://kicksma.sh/6WC9");
    expect(say("ru", both)).toContain("Свободно ещё 1 место");
    expect(say("es", both)).toContain("queda 1 plaza libre");
  });

  it("open spots: the spots left and \"Tap to join\"", () => {
    expect(say("en", { spots: 2 })).toBe("🎾 Padel Sun, Nov 15 at 19:00 — Club Padel Test. 2 spots left. Tap to join: https://kicksma.sh/6WC9");
    expect(say("ru", { spots: 2 })).toContain("2 места свободно. Записаться:");
    expect(say("es", { spots: 1 })).toContain("1 plaza. Toca para apuntarte:");
  });

  it("full: the line-up line, never \"No spots left. Tap to join\" in any language", () => {
    const full = { names: ["Sofia", "Maria", "Jordi", "Tim"] };
    expect(say("en", full)).toBe("🎾 Sun 19:00 · Club Padel Test · 4/4: Sofia, Maria, Jordi, Tim · full, waiting list open\nhttps://kicksma.sh/6WC9");
    expect(say("en", { ...full, waitlist: false })).toBe("🎾 Sun 19:00 · Club Padel Test · 4/4: Sofia, Maria, Jordi, Tim · full\nhttps://kicksma.sh/6WC9");
    for (const l of ["en", "ru", "es"] as const) {
      const text = say(l, full) ?? "";
      expect(text).toContain("4/4: Sofia, Maria, Jordi, Tim");
      for (const never of ["Tap to join", "No spots left", "Записаться", "мест нет.", "Toca para apuntarte"]) expect(text).not.toContain(never);
    }
  });

  it("held places the link cannot fill and no spot: the line-up line with the held count", () => {
    expect(say("en", { held: 3, waitlist: false })).toBe("🎾 Sun 19:00 · Club Padel Test · 1/4: Sofia · 3 held · full\nhttps://kicksma.sh/6WC9");
  });

  it("after the match: the result card's share, and nothing for a match with no result", () => {
    const result = { line: "Sofia & Micky beat Adrian & Nicolai 6-3 6-4", url: "https://kicksma.sh/EeHT/card?s=card" };
    expect(say("en", { over: true, result })).toBe("🎾 Sofia & Micky beat Adrian & Nicolai 6-3 6-4 · Sun, Nov 15\nhttps://kicksma.sh/EeHT/card?s=card");
    expect(say("ru", { over: true, result })).toContain(result.url);
    expect(say("es", { over: true, result })).toContain(result.line);
    expect(say("en", { over: true, spots: 2 })).toBeNull();
  });
});
