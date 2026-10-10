import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { createTranslator } from "next-intl";
import { describe, expect, it } from "vitest";
import en from "../messages/en.json";
import ru from "../messages/ru.json";
import es from "../messages/es.json";
import { cleanNoticeSettings, cleanParams, inQuiet, isUrgent, KIND_DEFAULTS, kindOn, NOTICE_KINDS, noticeKey, noticeSummary, quietZone, RECEIPTS, releaseOf, SENDERS, type NoticeSettings, type Sender } from "@/lib/domain/noticeKinds";
import { noticeVars } from "@/lib/noticeText";

/**
 * The owner's decision D, 9 October 2026: "A switch for each notice kind, quiet hours, and an inbox".
 * These are the pure rules (src/lib/domain/noticeKinds.ts) and the two guards that keep the kind map
 * honest: no file sends a player anything without going through the gate, and no sender is missing
 * from the map or from the messages.
 */

const root = (p: string) => path.resolve(__dirname, "..", p);
const NONE: NoticeSettings = { kinds: {}, quietFrom: null, quietTo: null, quietTz: null };
// 22:00–08:00 in Bangkok (UTC+7): inside from 15:00 to 01:00 UTC.
const NIGHT: NoticeSettings = { kinds: {}, quietFrom: 22 * 60, quietTo: 8 * 60, quietTz: "Asia/Bangkok" };
const at = (iso: string) => new Date(iso);

describe("the kinds and their defaults", () => {
  it("are on, all but the club's new matches (decision B)", () => {
    expect(NOTICE_KINDS.filter((k) => !KIND_DEFAULTS[k])).toEqual(["clubMatches"]);
    for (const k of NOTICE_KINDS) expect(kindOn({}, k)).toBe(KIND_DEFAULTS[k]);
    expect(kindOn(null, "clubMatches")).toBe(false);
    expect(kindOn({ clubMatches: true, spots: false }, "clubMatches")).toBe(true);
    expect(kindOn({ clubMatches: true, spots: false }, "spots")).toBe(false);
  });

  it("store only what differs from the default, and quiet hours only when both ends are set and differ", () => {
    const all = NOTICE_KINDS.filter((k) => KIND_DEFAULTS[k]);
    expect(cleanNoticeSettings({ on: all })).toEqual({ kinds: {}, quietFrom: null, quietTo: null, quietTz: null });
    expect(cleanNoticeSettings({ on: [...all.filter((k) => k !== "spots"), "clubMatches"], quietFrom: "22:00", quietTo: "08:00", tz: "Europe/Madrid" })).toEqual({ kinds: { spots: false, clubMatches: true }, quietFrom: 1320, quietTo: 480, quietTz: "Europe/Madrid" });
    expect(cleanNoticeSettings({ on: all, quietFrom: "22:00", quietTo: "" }).quietFrom).toBeNull();
    expect(cleanNoticeSettings({ on: all, quietFrom: "08:00", quietTo: "08:00" }).quietFrom).toBeNull();
    expect(cleanNoticeSettings({ on: ["nonsense"], quietFrom: "25:00", quietTo: "08:00", tz: "Mars/Olympus" })).toEqual({ kinds: { changes: false, reminders: false, spots: false, results: false, crew: false, coach: false }, quietFrom: null, quietTo: null, quietTz: null });
  });

  it("sum up in one line: how many are on, and the quiet hours", () => {
    expect(noticeSummary(NONE)).toEqual({ on: 6, total: 7, quiet: null });
    expect(noticeSummary({ ...NIGHT, kinds: { clubMatches: true } })).toEqual({ on: 7, total: 7, quiet: { from: "22:00", to: "08:00" } });
  });
});

describe("the gate for one notice", () => {
  it("keeps a switched-off kind and never delivers it, not even inside three hours of the match", () => {
    const off = { ...NIGHT, kinds: { crew: false } };
    expect(releaseOf(off, "crew", at("2026-10-10T05:00:00Z"))).toEqual({ release: "off", dueAt: null });
    expect(releaseOf(off, "crew", at("2026-10-10T16:00:00Z"), { startsAt: at("2026-10-10T17:00:00Z") })).toEqual({ release: "off", dueAt: null });
    expect(releaseOf(NONE, "clubMatches", at("2026-10-10T05:00:00Z")).release).toBe("off");
  });

  it("holds a notice inside quiet hours until they end, in the player's own zone", () => {
    // 23:30 in Bangkok: held until 08:00 Bangkok, 01:00 UTC.
    expect(releaseOf(NIGHT, "spots", at("2026-10-10T16:30:00Z"))).toEqual({ release: "held", dueAt: at("2026-10-11T01:00:00Z") });
    // 07:59 in Bangkok: one minute left.
    expect(releaseOf(NIGHT, "spots", at("2026-10-11T00:59:00Z"))).toEqual({ release: "held", dueAt: at("2026-10-11T01:00:00Z") });
    // 08:00 and 21:59 in Bangkok: outside.
    expect(releaseOf(NIGHT, "spots", at("2026-10-11T01:00:00Z")).release).toBe("now");
    expect(releaseOf(NIGHT, "spots", at("2026-10-10T14:59:00Z")).release).toBe("now");
    // No zone of their own: the match's, else Bangkok.
    expect(quietZone({ quietTz: null }, "Europe/Madrid")).toBe("Europe/Madrid");
    expect(quietZone({ quietTz: null }, null)).toBe("Asia/Bangkok");
    expect(releaseOf({ ...NIGHT, quietTz: null }, "spots", at("2026-10-10T21:30:00Z"), { tz: "Europe/Madrid" })).toEqual({ release: "held", dueAt: at("2026-10-11T06:00:00Z") });
  });

  it("lets a notice about a match that starts within three hours through quiet hours", () => {
    const now = at("2026-10-10T16:30:00Z"); // 23:30 Bangkok
    expect(releaseOf(NIGHT, "changes", now, { startsAt: at("2026-10-10T19:30:00Z") }).release).toBe("now");
    expect(releaseOf(NIGHT, "changes", now, { startsAt: at("2026-10-10T19:31:00Z") }).release).toBe("held");
    // A match that already started is not one that starts within three hours: the score ask waits for the morning.
    expect(releaseOf(NIGHT, "results", now, { startsAt: at("2026-10-10T15:00:00Z") }).release).toBe("held");
    expect(isUrgent(null, now)).toBe(false);
  });

  it("reads quiet hours that do not wrap midnight too", () => {
    expect(inQuiet(13 * 60, 15 * 60, 14 * 60)).toBe(true);
    expect(inQuiet(13 * 60, 15 * 60, 15 * 60)).toBe(false);
    expect(inQuiet(22 * 60, 8 * 60, 3 * 60)).toBe(true);
    expect(inQuiet(22 * 60, 8 * 60, 12 * 60)).toBe(false);
  });

  it("never keeps a link in a notice's facts, whoever passes one", () => {
    expect(cleanParams({ venue: "https://kicksma.sh/p/AbCdEf123/7KQ2", name: "Ana", title: "/p/AbCdEf123", club: "www.example.com", count: 3, at: "2026-10-10T10:00:00.000Z" })).toEqual({ name: "Ana", count: 3, at: "2026-10-10T10:00:00.000Z" });
    expect(cleanParams({ venue: "Rawai Padel · Court 3" })).toEqual({ venue: "Rawai Padel · Court 3" });
  });
});

describe("the kind map covers every sender", () => {
  const LOCALES = { en, ru, es } as const;
  const senders = Object.keys(SENDERS) as Sender[];

  it("gives every sender a kind and an inbox message in every language, and no message lacks a sender", () => {
    for (const s of senders) expect(NOTICE_KINDS).toContain(SENDERS[s]);
    for (const [l, m] of Object.entries(LOCALES)) {
      const keys = Object.keys((m as { noticeItem: Record<string, string> }).noticeItem);
      expect({ l, keys: keys.sort() }).toEqual({ l, keys: [...senders].sort() });
      for (const k of NOTICE_KINDS) {
        expect((m as { notices: Record<string, string> }).notices[`kind_${k}`], `${l} kind_${k}`).toBeTruthy();
        expect((m as { notices: Record<string, string> }).notices[`line_${k}`], `${l} line_${k}`).toBeTruthy();
      }
    }
  });

  it("renders every inbox message to real words in every language, never to its own key", () => {
    const params = { at: "2026-10-10T11:00:00.000Z", tz: "Asia/Bangkok", venue: "Rawai Padel", name: "Ana", group: "Tuesday crew", club: "Rawai Padel", title: "Phuket Open", count: 3, what: "joined" };
    for (const [l, m] of Object.entries(LOCALES)) {
      const t = createTranslator({ locale: l as "en", messages: m as never, onError: () => undefined });
      for (const s of senders) {
        const out = t(noticeKey(s) as never, noticeVars(params, l, "?") as never) as string;
        expect(out === noticeKey(s) || out.includes("{"), `${l} ${s} → ${out}`).toBe(false);
      }
    }
  });

  /**
   * Every file that calls a delivery primitive is named here: the gated ones go through
   * `src/lib/domain/notices.ts`, the rest say why what they send is not a player's notice. A new file
   * that sends fails until somebody decides which it is, and a gated file that stops calling the gate
   * fails as well.
   */
  const PRIMITIVE = /\b(sendEmail|sendPush|sendWaTemplate|sendMessage|sendPhoto|tell)\(/;
  const GATED = [
    "src/lib/notify.ts",
    "src/lib/coach/notify.ts",
    "src/lib/afterMatch.ts",
    "src/lib/tournament/notify.ts",
    "src/lib/levelChecks.ts",
    "src/lib/domain/coachWants.ts",
    "src/lib/telegram/notices.ts",
    "src/app/api/cron/push/route.ts",
    "src/actions/groups.ts",
    "src/actions/clubs.ts",
    "src/lib/telegram/handlers/owner.ts",
  ];
  const NOT_A_PLAYER_NOTICE: Record<string, string> = {
    "src/lib/email/send.ts": "the email primitive itself",
    "src/lib/push.ts": "the web push primitive itself",
    "src/lib/whatsapp/templates.ts": "the WhatsApp template primitive itself",
    "src/lib/telegram/api.ts": "the Telegram primitive itself",
    "src/lib/coach/wrapSend.ts": "a coach's or a club's monthly statement: their business record, with its own opt-out",
    "src/lib/feedback/store.ts": "the answer to the person's own note (standing order 5): never switchable",
    "src/lib/feedback/propose.ts": "to the owner",
    "src/lib/alerts.ts": "to the owner",
    "src/lib/ops/alerts.ts": "to the owner",
    "src/lib/uptime.ts": "to the owner",
    "src/lib/listen/answers.ts": "to the owner",
    "src/lib/listen/tick.ts": "to the owner",
    "src/lib/outreach/desk.ts": "to the owner",
    "src/lib/telegram/clubs.ts": "to the owner",
    "src/app/api/admin/notify/route.ts": "to the owner",
    "src/lib/channels/telegram.ts": "a room's card, edited in place (rule 5): a room, not a player",
    "src/lib/telegram/bot.ts": "a reply in the chat the person is writing in",
    "src/lib/telegram/handlers/feedback.ts": "a reply in the chat the person is writing in",
    "src/lib/telegram/handlers/games.ts": "a reply in the chat the person is writing in",
    "src/lib/telegram/handlers/new.ts": "a reply in the chat the person is writing in",
    "src/lib/telegram/handlers/result.ts": "a reply to the person's own message or tap",
    "src/lib/telegram/handlers/start.ts": "a reply in the chat the person is writing in",
    "src/lib/telegram/handlers/want.ts": "a reply in the chat the person is writing in",
    "src/lib/telegram/handlers/crew.ts": "the crew's own group: its pinned notice and replies in the room (DECIDING rule 31)",
    "src/lib/telegram/handlers/words.ts": "an answer in the crew's group to the person who just wrote, seen by them alone",
    "src/lib/telegram/handlers/times.ts": "one reply to the person who asked (\"times?\", /times) in the chat they asked in (DECIDING rule 34)",
    "src/lib/telegram/player.ts": "a reply to the person's own tap",
    "src/lib/telegram/coach.ts": "the coach's assistant answering the coach or student who wrote",
    "src/lib/telegram/taps.ts": "a reply to the person's own tap",
    "src/lib/telegram/tournament.ts": "a reply to the person's own score",
    "src/lib/telegram/competitions.ts": "a reply to the person's own tap",
  };

  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((f) => {
      const p = path.join(dir, f);
      return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx)$/.test(f) ? [p] : [];
    });
  const sending = files(root("src"))
    .filter((f) => PRIMITIVE.test(readFileSync(f, "utf8")))
    .map((f) => path.relative(root("."), f).split(path.sep).join("/"))
    .sort();

  it("names every file that sends, as gated or as not a player's notice", () => {
    const unnamed = sending.filter((f) => !GATED.includes(f) && !(f in NOT_A_PLAYER_NOTICE));
    expect(unnamed).toEqual([]);
    // And the lists are not stale: every name on them still sends.
    expect([...GATED, ...Object.keys(NOT_A_PLAYER_NOTICE)].filter((f) => !sending.includes(f))).toEqual([]);
  });

  it("finds the gate in every gated file", () => {
    const GATE = /\brecordNotices?\(|\breleasesFor\(|\bnotice: \{/;
    expect(GATED.filter((f) => !GATE.test(readFileSync(root(f), "utf8")))).toEqual([]);
  });

  it("finds every sender in use, so the map holds no name that no code sends, and every receipt too", () => {
    const src = files(root("src"))
      .filter((f) => !f.endsWith(path.join("domain", "noticeKinds.ts")))
      .map((f) => readFileSync(f, "utf8"))
      .join("\n");
    expect(senders.filter((s) => !src.includes(`"${s}"`))).toEqual([]);
    expect(RECEIPTS.filter((r) => !src.includes(`receipt: "${r}"`))).toEqual([]);
  });
});
