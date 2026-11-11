import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import { coaches, lessonWaitlist, lessons } from "@/db/schema";
import { NO_SIDE_EFFECTS } from "@/lib/api/operations";
import { joinWaitlist, leaveWaitlist, offerFreedSlot } from "@/lib/coach/chains";
import { coachErrorKey, COACH_ERROR_CODES } from "@/lib/coach/errorKey";
import { notifyOffer, notifyStudentRequest } from "@/lib/coach/notify";
import { bookLesson, createCoach, createPackage, markLessonPaid, presetHours, setStudentStatus, updateCoach } from "@/lib/domain/coaching";
import { DomainError } from "@/lib/domain/errors";
import { cancelEvent, createEvent } from "@/lib/domain/events";
import { addCategory, createCompetition } from "@/lib/domain/competitions";
import { tellOrganizerOfEntry } from "@/lib/tournament/notify";
import { handleTelegramUpdate, linkTelegram } from "@/lib/telegram/bot";
import { swapButton } from "@/lib/telegram/coach";
import { packId } from "@/lib/telegram/taps";
import { catalogue } from "./helpers/render";
import { freezeClock } from "./helpers/clock";
import { createTestDb, makePlayer } from "./helpers/db";

/**
 * The owner, 9 November 2026: "check all the buttons in the app so they are actually doing what they
 * are supposed to do". The buttons of the coach's book that did something else than their words said:
 * a keypad that cut a PromptPay number to seven digits, "No thanks" that never offered the spot to the
 * next student, "✓ Paid" that took every other button with it, a cancel with no question, a toast
 * that named the wrong thing, and notices whose email link opened the coach setup page.
 *
 * The clock: Monday 9 November 2026, 10:00 in Bangkok (03:00 UTC). Lessons are on Wednesday and
 * Thursday at 09:00 Bangkok (02:00 UTC), inside the "both" preset's morning hours.
 */
const NOW = new Date("2026-11-09T03:00:00Z");
freezeClock(NOW);
const WED_9 = new Date("2026-11-11T02:00:00Z");
const WED_10 = new Date("2026-11-11T03:00:00Z");
const THU_9 = new Date("2026-11-12T02:00:00Z");

const TOKEN = "123456:TESTTOKEN";
type Call = { method: string; body: Record<string, unknown> };
let calls: Call[] = [];
let mails: { to: string; subject: string; html: string }[] = [];
let nextMessageId = 100;
function stub() {
  calls = [];
  mails = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      if (u.startsWith("https://api.resend.com/emails")) {
        mails.push({ to: String(Array.isArray(body.to) ? body.to[0] : body.to), subject: String(body.subject), html: String(body.html) });
        return new Response(JSON.stringify({ id: `m${mails.length}` }), { status: 200, headers: { "content-type": "application/json" } });
      }
      const method = u.split("/").pop()!;
      calls.push({ method, body });
      const result = method === "sendMessage" || method === "sendPhoto" ? { message_id: nextMessageId++, chat: { id: body.chat_id } } : true;
      return new Response(JSON.stringify({ ok: true, result }), { status: 200, headers: { "content-type": "application/json" } });
    }),
  );
}
type Btn = { text: string; callback_data?: string; url?: string };
type Keys = { inline_keyboard: Btn[][] };
const sent = (method: string) => calls.filter((c) => c.method === method);
const to = (chatId: number) => calls.filter((c) => c.body.chat_id === chatId && (c.method === "sendMessage" || c.method === "sendPhoto"));
const lastShown = () => {
  const c = [...calls].reverse().find((x) => x.method === "sendMessage" || x.method === "editMessageText" || x.method === "sendPhoto")!;
  return { text: String(c.body.text ?? c.body.caption ?? ""), keys: (c.body.reply_markup ?? { inline_keyboard: [] }) as Keys };
};
const toast = () => String(sent("answerCallbackQuery").at(-1)?.body.text ?? "");

const tgCoach = { id: 8101, first_name: "Olga", language_code: "en" };
const tgBen = { id: 8102, first_name: "Ben", language_code: "en" };
const tgCara = { id: 8103, first_name: "Cara", language_code: "en" };
const chatOf = (u: { id: number }) => ({ id: u.id, type: "private" as const });
let upd = 9000;
/** A tap, under a message that carries the buttons it was sent with (and a photo when it was one). */
const tap = (from: { id: number; first_name: string; language_code: string }, data: string, o: { keys?: Keys; photo?: boolean; messageId?: number } = {}) =>
  handleTelegramUpdate(db, { update_id: upd++, callback_query: { id: `cb${upd}`, from, message: { message_id: o.messageId ?? 555, date: 0, chat: chatOf(from), ...(o.photo ? { photo: [{ file_id: "qr" }], caption: "QR" } : { text: "x" }), ...(o.keys ? { reply_markup: o.keys } : {}) }, data } }, NO_SIDE_EFFECTS);
const say = (from: { id: number; first_name: string; language_code: string }, text: string) =>
  handleTelegramUpdate(db, { update_id: upd++, message: { message_id: upd, date: 0, chat: chatOf(from), from, text } }, NO_SIDE_EFFECTS);

let db: Db;
let close: () => Promise<void>;
let coachId = "";
let benId = "";
let caraId = "";
const coachRow = async () => (await db.select().from(coaches).where(eq(coaches.id, coachId)))[0];
beforeAll(async () => {
  ({ db, close } = await createTestDb());
  process.env.TELEGRAM_BOT_TOKEN = TOKEN;
  process.env.RESEND_API_KEY = "re_test";
  const olga = await makePlayer(db, "Olga");
  const made = await createCoach(db, { playerId: olga.id, displayName: "Olga", tz: "Asia/Bangkok", hours: presetHours("both") });
  await updateCoach(db, made.id, { priceSingle: 800 });
  coachId = made.id;
  await linkTelegram(db, olga.id, tgCoach);
  const ben = await makePlayer(db, "Ben");
  const cara = await makePlayer(db, "Cara");
  for (const p of [ben, cara]) await setStudentStatus(db, made.id, p.id, "accepted");
  await linkTelegram(db, ben.id, tgBen);
  await linkTelegram(db, cara.id, tgCara);
  benId = ben.id;
  caraId = cara.id;
});
afterAll(async () => {
  delete process.env.RESEND_API_KEY;
  await close();
});
beforeEach(() => stub());
afterEach(() => vi.unstubAllGlobals());

describe("finding 1: the PromptPay keypad takes a whole number", () => {
  it("takes 0812345678 digit by digit, as a thumb taps it, and saves all ten", async () => {
    await tap(tgCoach, "kv:pp:");
    for (const d of "0812345678") {
      const b = lastShown().keys.inline_keyboard.flat().find((x) => x.text === d)!;
      await tap(tgCoach, b.callback_data!);
    }
    expect(lastShown().text).toMatch(/0812345678$/);
    const done = lastShown().keys.inline_keyboard.flat().find((x) => x.callback_data?.endsWith(":ok"))!;
    expect(done.callback_data).toBe("kv:pp:0812345678:ok");
    expect(await tap(tgCoach, done.callback_data!)).toBe("coach:set:pp");
    expect((await coachRow()).promptpayId).toBe("0812345678");
  });

  it("stops at thirteen digits for PromptPay and at seven for money", async () => {
    await tap(tgCoach, "kv:pp:1234567890123");
    expect(lastShown().keys.inline_keyboard.flat().find((x) => x.text === "4")!.callback_data).toBe("kv:pp:1234567890123");
    await tap(tgCoach, "kv:p1:1234567");
    expect(lastShown().keys.inline_keyboard.flat().find((x) => x.text === "4")!.callback_data).toBe("kv:p1:1234567");
  });

  it("refuses an ID no bank reads, says why, and keeps the one saved", async () => {
    expect(await tap(tgCoach, "kv:pp:0812345:ok")).toBe("coach:tap:keypad_refused");
    expect(lastShown().text).toContain("phone number (10 digits) or an ID number (13 digits)");
    expect((await coachRow()).promptpayId).toBe("0812345678");
    // The same rule at the one place every door writes it.
    await expect(updateCoach(db, coachId, { promptpayId: "0812345" })).rejects.toThrow(DomainError);
    expect((await updateCoach(db, coachId, { promptpayId: "+66 81 234 5678" })).promptpayId).toBe("+66812345678");
    await updateCoach(db, coachId, { promptpayId: "0812345678" });
  });
});

describe("finding 3: \"No thanks\" offers the spot to the next student", () => {
  it("in Telegram, the next student hears at once, not after thirty minutes", async () => {
    const coach = await coachRow();
    await joinWaitlist(db, coach, benId, { slotStartsAt: THU_9 });
    await joinWaitlist(db, coach, caraId, { slotStartsAt: THU_9 });
    const offer = (await offerFreedSlot(db, coach, THU_9))!;
    expect(offer.player.id).toBe(benId);
    expect(await tap(tgBen, `lw:${offer.entry.id}`)).toBe("student:offer:passed_on");
    const rows = await db.select().from(lessonWaitlist).where(eq(lessonWaitlist.coachId, coachId));
    expect(rows.find((r) => r.studentPlayerId === benId)!.status).toBe("withdrawn");
    const cara = rows.find((r) => r.studentPlayerId === caraId)!;
    expect(cara.status).toBe("offered");
    const told = to(tgCara.id).at(-1)!;
    expect(JSON.stringify(told.body.reply_markup)).toContain(`lo:${cara.id}`);
  });

  it("on the web, leaving a held spot hands it on; leaving a plain wait hands nothing", async () => {
    const coach = await coachRow();
    const caraRow = (await db.select().from(lessonWaitlist).where(eq(lessonWaitlist.studentPlayerId, caraId)))[0];
    await joinWaitlist(db, coach, benId, { slotStartsAt: THU_9 });
    const { next } = await leaveWaitlist(db, coach, caraRow.id, caraId);
    expect(next?.player.id).toBe(benId);
    const { next: none } = await leaveWaitlist(db, coach, next!.entry.id, benId);
    expect(none).toBeNull();
    const plain = await joinWaitlist(db, coach, caraId, { slotStartsAt: THU_9 });
    expect((await leaveWaitlist(db, coach, plain.id, caraId)).next).toBeNull();
  });
});

describe("findings 4 and 5: a paid button changes only itself", () => {
  let first = "";
  let second = "";
  it("on the money list, \"✓ Paid\" takes out its own row and the student hears once", async () => {
    const coach = await coachRow();
    first = (await bookLesson(db, { coach, studentPlayerId: benId, startsAt: WED_9, byCoach: true, source: "telegram" })).lesson.id;
    second = (await bookLesson(db, { coach, studentPlayerId: caraId, startsAt: WED_10, byCoach: true, source: "telegram" })).lesson.id;
    expect(await say(tgCoach, "💰 Money")).toBe("coach:tap:money");
    const keys = lastShown().keys;
    expect(keys.inline_keyboard.flat().filter((b) => b.callback_data?.startsWith("cq:"))).toHaveLength(2);
    calls = [];
    expect(await tap(tgCoach, `cq:${first}`, { keys })).toBe("coach:lesson_paid");
    const left = sent("editMessageReplyMarkup").at(-1)!.body.reply_markup as Keys;
    expect(left.inline_keyboard.flat().some((b) => b.callback_data === `cq:${first}`)).toBe(false);
    expect(left.inline_keyboard.flat().some((b) => b.callback_data === `cq:${second}`)).toBe(true);
    expect(left.inline_keyboard.flat().some((b) => b.callback_data === "kw:0")).toBe(true);
    expect(sent("editMessageText")).toHaveLength(0);
    expect(to(tgBen.id)).toHaveLength(1);
    // A second tap on the old message is not a second payment.
    calls = [];
    expect(await tap(tgCoach, `cq:${first}`, { keys })).toBe("coach:lesson_paid:already");
    expect(to(tgBen.id)).toHaveLength(0);
    expect((await markLessonPaid(db, coachId, first)).changed).toBe(false);
  });

  it("on a lesson's own card, the card is drawn again and says paid", async () => {
    calls = [];
    await tap(tgCoach, `kl:${packId(second)}`);
    const card = lastShown();
    expect(card.text).toContain("not paid");
    calls = [];
    expect(await tap(tgCoach, `cq:${second}`, { keys: card.keys })).toBe("coach:lesson_paid");
    const redrawn = lastShown();
    expect(redrawn.text).not.toContain("not paid");
    expect(redrawn.keys.inline_keyboard.flat().some((b) => b.callback_data?.startsWith("cq:") || b.callback_data?.startsWith("kf:"))).toBe(false);
    expect(redrawn.keys.inline_keyboard.flat().some((b) => b.callback_data?.startsWith("kx:"))).toBe(true);
  });

  it("under the QR photo, \"Not paid → Paid\" turns into \"Paid ✓\" and back, alone", async () => {
    const pkg = await createPackage(db, { coachId, studentPlayerId: caraId, size: 5, amount: 3500 });
    const keys: Keys = { inline_keyboard: [[{ text: "Not paid → Paid", callback_data: `cp:${pkg.id}` }], [{ text: "Other", callback_data: "kw:0" }]] };
    expect(await tap(tgCoach, `cp:${pkg.id}`, { keys, photo: true })).toBe("coach:paid");
    const after = sent("editMessageReplyMarkup").at(-1)!.body.reply_markup as Keys;
    expect(after.inline_keyboard).toEqual([[{ text: "Paid ✓", callback_data: `cp:${pkg.id}` }], [{ text: "Other", callback_data: "kw:0" }]]);
    expect(sent("editMessageText")).toHaveLength(0);
    expect(await tap(tgCoach, `cp:${pkg.id}`, { keys: after, photo: true })).toBe("coach:unpaid");
    expect((sent("editMessageReplyMarkup").at(-1)!.body.reply_markup as Keys).inline_keyboard[0][0].text).toBe("Not paid → Paid");
    // On a list the button keeps the name beside its state.
    expect(swapButton({ inline_keyboard: [[{ text: "✓ Paid: Cara · 3500 THB", callback_data: "cp:1" }]] }, "cp:1", (b) => ({ ...b, text: `Paid ✓: ${b.text.slice(b.text.indexOf(": ") + 2)}` })).inline_keyboard[0][0].text).toBe("Paid ✓: Cara · 3500 THB");
  });
});

describe("finding 7: the student's Cancel asks first, as on the web", () => {
  it("outside the cutoff the question says nothing counts, and only the second tap cancels", async () => {
    const coach = await coachRow();
    const { lesson } = await bookLesson(db, { coach, studentPlayerId: benId, startsAt: THU_9, byCoach: true, source: "telegram" });
    expect(await tap(tgBen, `lc:${lesson.id}`)).toBe("student:cancel:confirm");
    const ask = lastShown();
    expect(ask.text).toMatch(/Cancel this lesson\? More than \d+ h before: nothing counts\./);
    expect(ask.keys.inline_keyboard.flat().map((b) => b.callback_data)).toEqual([`lx:${lesson.id}`, "kz:"]);
    expect((await db.select().from(lessons).where(eq(lessons.id, lesson.id)))[0].status).toBe("booked");
    expect(await tap(tgBen, `lx:${lesson.id}`)).toBe("student:cancelled");
    expect((await db.select().from(lessons).where(eq(lessons.id, lesson.id)))[0].status).toBe("cancelled_by_student");
  });
});

describe("finding 11: the coach's \"✕ Yes, cancel\" toast names what happened", () => {
  it("says cancelled, and names the package only when one paid for the lesson", async () => {
    const coach = await coachRow();
    // Ben holds no package yet (Cara has one from the photo test above).
    const { lesson } = await bookLesson(db, { coach, studentPlayerId: benId, startsAt: new Date("2026-11-13T02:00:00Z"), byCoach: true, source: "telegram" });
    expect(lesson.consumed).toBe(false);
    expect(await tap(tgCoach, `cu:${lesson.id}`)).toBe("coach:undo");
    expect(toast()).toBe("Cancelled.");
    await createPackage(db, { coachId, studentPlayerId: benId, size: 5, amount: 3500, paid: true });
    const { lesson: fromPkg } = await bookLesson(db, { coach, studentPlayerId: benId, startsAt: new Date("2026-11-13T03:00:00Z"), byCoach: true, source: "telegram" });
    expect(fromPkg.consumed).toBe(true);
    await tap(tgCoach, `cu:${fromPkg.id}`);
    expect(toast()).toBe("Cancelled. Back on the package.");
  });
});

describe("finding 12: \"🎁 On me\" on a paid lesson says why nothing happened", () => {
  it("the card says the lesson is paid already", async () => {
    const coach = await coachRow();
    const { lesson } = await bookLesson(db, { coach, studentPlayerId: caraId, startsAt: new Date("2026-11-16T02:00:00Z"), byCoach: true, source: "telegram" });
    await markLessonPaid(db, coachId, lesson.id);
    expect(await tap(tgCoach, `kf:${packId(lesson.id)}`)).toBe("coach:tap:comp_refused");
    expect(lastShown().text).toMatch(/^Cara, .*: already paid\. A refund happens at the bank, not here\.$/);
  });
});

describe("finding 2: a notice by email opens the page where the same thing is done", () => {
  it("a student with only email: the offer opens their lessons with this coach, under a label that says so", async () => {
    const coach = await coachRow();
    const eve = await makePlayer(db, "Eve", { email: "eve@example.com" });
    await setStudentStatus(db, coachId, eve.id, "accepted");
    await joinWaitlist(db, coach, eve.id, { slotStartsAt: new Date("2026-11-17T02:00:00Z") });
    const offer = (await offerFreedSlot(db, coach, new Date("2026-11-17T02:00:00Z")))!;
    await notifyOffer(db, coach, offer);
    const mail = mails.find((m) => m.to === "eve@example.com")!;
    expect(mail.html).toContain(`/c/${coach.handle}`);
    expect(mail.html).toContain("Open your lessons");
    expect(mail.html).not.toContain("Open the match");
    expect(mail.html).not.toMatch(/\/coach"/);
  });

  it("a coach with only email: a join request opens the student's row on the students screen", async () => {
    const pia = await makePlayer(db, "Pia", { email: "pia@example.com" });
    const book = await createCoach(db, { playerId: pia.id, displayName: "Pia", tz: "Asia/Bangkok", hours: presetHours("both") });
    const asker = await makePlayer(db, "Ana");
    await notifyStudentRequest(db, book, asker);
    const mail = mails.find((m) => m.to === "pia@example.com")!;
    expect(mail.html).toContain(`/coach/students#s-${asker.id}`);
    expect(mail.html).toContain("Open my students");
    expect(mail.html).not.toContain("Open the match");
  });
});

describe("finding 2, the label only: a tournament notice by email", () => {
  it("names the tournament's page, not a match", async () => {
    const org = await makePlayer(db, "Toni", { email: "toni@example.com" });
    const competition = await createCompetition(db, { organizerPlayerId: org.id, name: "Rawai Open", tz: "Asia/Bangkok", startsOn: "2026-12-05", endsOn: "2026-12-06" });
    const category = await addCategory(db, { competitionId: competition.id, organizerPlayerId: org.id, name: "Gold" });
    await tellOrganizerOfEntry(db, { competition, category, player: { displayName: "Ana" }, partner: { displayName: "Bo" } }, 1);
    const mail = mails.find((m) => m.to === "toni@example.com")!;
    expect(mail.html).toContain("See the public page");
    expect(mail.html).not.toContain("Open the match");
  });
});

describe("finding 13: every error code of the book has its own words", () => {
  it("names each known code, and says only that it did not work for the rest", () => {
    expect(coachErrorKey("too_late")).toBe("errors.too_late");
    expect(coachErrorKey("cancelled")).toBe("errors.cancelled");
    expect(coachErrorKey("rate_limited")).toBe("errors.generic");
    expect(coachErrorKey(undefined)).toBe("errors.generic");
    for (const locale of ["en", "ru", "es"] as const) {
      const errors = (catalogue(locale).coach as { errors: Record<string, string> }).errors;
      for (const code of [...COACH_ERROR_CODES, "generic"]) expect(typeof errors[code], `${locale} coach.errors.${code}`).toBe("string");
    }
  });
});

describe("findings 14 and 15: the match card's buttons always answer, in words that fit", () => {
  it("a join tap on a cancelled match says the card's own word for it", async () => {
    const org = await makePlayer(db, "Org");
    const ev = await createEvent(db, { creatorPlayerId: org.id, type: "match", startsAt: new Date("2026-11-14T11:00:00Z"), tz: "Asia/Bangkok", venueName: "Rawai Padel Club", whenFull: "waitlist" });
    await cancelEvent(db, ev.id, org.id);
    const out = await tap({ id: 8199, first_name: "Late", language_code: "en" }, `j:${ev.code}`);
    expect(out).toBe("join:error:cancelled");
    expect(toast()).toBe("❌ Cancelled");
  });

  it("a tap whose handler throws is still answered, so its button does not spin", async () => {
    const broken = new Proxy({}, { get: () => { throw new Error("database down"); } }) as unknown as Db;
    const out = await handleTelegramUpdate(broken, { update_id: upd++, callback_query: { id: "cb-broken", from: tgBen, message: { message_id: 1, date: 0, chat: chatOf(tgBen), text: "x" }, data: "j:ABCD" } }, NO_SIDE_EFFECTS);
    expect(out).toMatch(/^error:/);
    const answered = sent("answerCallbackQuery").at(-1)!;
    expect(answered.body.callback_query_id).toBe("cb-broken");
    expect(String(answered.body.text)).toBe("Something went wrong. Open the match instead.");
  });
});
