import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import { lessonPackages, lessons, players } from "@/db/schema";
import { NO_SIDE_EFFECTS } from "@/lib/api/operations";
import { createCoach, createPackage, getLesson, presetHours, saveOffers, setStudentStatus, updateCoach } from "@/lib/domain/coaching";
import { handleTelegramUpdate, linkTelegram } from "@/lib/telegram/bot";
import { packId, unpackId } from "@/lib/telegram/taps";
import { createTestDb, makePlayer, HOUR } from "./helpers/db";

/**
 * The assistant as taps. A coach and a student go through every flow by pressing buttons; the only
 * typed messages are a name, a time the grid does not offer, and a package line. Each test reads
 * the buttons the bot sent and presses one, the way a thumb would.
 */
const TOKEN = "123456:TESTTOKEN";
type Call = { method: string; body: Record<string, unknown> };
let calls: Call[] = [];
let nextMessageId = 100;
function stubTelegram() {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      const method = String(url).split("/").pop()!;
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      calls.push({ method, body });
      const result = method === "sendMessage" || method === "sendPhoto" ? { message_id: nextMessageId++, chat: { id: body.chat_id } } : true;
      return new Response(JSON.stringify({ ok: true, result }), { status: 200, headers: { "content-type": "application/json" } });
    }),
  );
}
type Btn = { text: string; callback_data?: string; url?: string };
/** The last message or edit the bot sent, with its buttons flattened. */
const last = () => {
  const c = [...calls].reverse().find((x) => x.method === "sendMessage" || x.method === "editMessageText" || x.method === "sendPhoto");
  const markup = (c?.body.reply_markup ?? {}) as { inline_keyboard?: Btn[][]; force_reply?: boolean };
  return { text: String(c?.body.text ?? c?.body.caption ?? ""), buttons: (markup.inline_keyboard ?? []).flat(), forceReply: Boolean(markup.force_reply), messageId: (c?.body.message_id as number | undefined) ?? nextMessageId - 1 };
};
const button = (re: RegExp) => {
  const b = last().buttons.find((x) => re.test(x.text));
  if (!b?.callback_data) throw new Error(`no button ${re} among ${last().buttons.map((x) => x.text).join(" | ")}`);
  return b.callback_data;
};

const tgCoach = { id: 7001, first_name: "Olga", username: "olga_taps", language_code: "en" };
const tgStudent = { id: 7002, first_name: "Ivan", username: "ivan_taps", language_code: "en" };
const coachChat = { id: 7001, type: "private" as const };
const studentChat = { id: 7002, type: "private" as const };
let upd = 5000;
const say = (chat: typeof coachChat, from: typeof tgCoach, text: string, replyTo?: { message_id: number; text: string }) =>
  handleTelegramUpdate(db, { update_id: upd++, message: { message_id: upd, date: 0, chat, from, text, ...(replyTo ? { reply_to_message: { message_id: replyTo.message_id, date: 0, chat, from: { id: 123456, is_bot: true, first_name: "bot" }, text: replyTo.text } } : {}) } }, NO_SIDE_EFFECTS);
const tap = (chat: typeof coachChat, from: typeof tgCoach, data: string, messageId = 999) => handleTelegramUpdate(db, { update_id: upd++, callback_query: { id: `cb${upd}`, from, message: { message_id: messageId, date: 0, chat }, data } }, NO_SIDE_EFFECTS);
/** Answer the bot's force-reply prompt: the prompt's text carries the flow's trailer. */
const reply = (chat: typeof coachChat, from: typeof tgCoach, text: string) => {
  const prompt = [...calls].reverse().find((x) => x.method === "sendMessage" && (x.body.reply_markup as { force_reply?: boolean } | undefined)?.force_reply);
  if (!prompt) throw new Error("no prompt to reply to");
  return say(chat, from, text, { message_id: nextMessageId - 1, text: String(prompt.body.text).replace(/&amp;/g, "&") });
};

let db: Db;
let close: () => Promise<void>;
let coachId = "";
let studentId = "";
beforeAll(async () => {
  ({ db, close } = await createTestDb());
  process.env.TELEGRAM_BOT_TOKEN = TOKEN;
  const cp = await makePlayer(db, "Olga");
  const made = await createCoach(db, { playerId: cp.id, displayName: "Olga", tz: "Asia/Bangkok", hours: presetHours("both") });
  // Benji's card: two lengths, a pair price, an extra outside the hours, a package on the page.
  await updateCoach(db, made.id, { priceSingle: 800, priceTwo: 500, secondMinutes: 90, priceSecondSingle: 1200, priceSecondTwo: 900, outsideHoursFee: 300, promptpayId: "0899999999" });
  await saveOffers(db, made.id, [{ size: 10, minutes: 60, heads: 1, price: 7000, validDays: 70 }]);
  coachId = made.id;
  await linkTelegram(db, cp.id, tgCoach);
  const sp = await makePlayer(db, "Ivan");
  await setStudentStatus(db, made.id, sp.id, "accepted");
  await linkTelegram(db, sp.id, tgStudent);
  studentId = sp.id;
});
afterAll(async () => close());
beforeEach(() => stubTelegram());
afterEach(() => vi.unstubAllGlobals());

describe("ids in a button", () => {
  it("packs a uuid into 22 characters and back", () => {
    const id = "0f4a2b1c-3d5e-4f60-8a9b-0c1d2e3f4a5b";
    expect(packId(id)).toHaveLength(22);
    expect(unpackId(packId(id))).toBe(id);
    expect(unpackId("not-an-id")).toBeNull();
  });
});

describe("the coach books, cancels, moves and settles with taps", () => {
  it("books a lesson: who, how long, which day, what time, how many — every step a button", async () => {
    expect(await say(coachChat, tgCoach, "＋ Book")).toBe("coach:tap:who");
    expect(last().buttons.some((b) => b.text === "Ivan")).toBe(true);
    expect(await tap(coachChat, tgCoach, button(/^Ivan$/))).toBe("coach:tap:length");
    expect(await tap(coachChat, tgCoach, button(/90 min/))).toBe("coach:tap:day");
    // Seven days, two per row, and the week after behind one more tap.
    expect(last().buttons.filter((b) => b.callback_data?.startsWith("kt:")).length).toBe(7);
    // Today may be over in Bangkok by the time this runs: the day after tomorrow always has its hours.
    const day = last().buttons.filter((b) => b.callback_data?.startsWith("kt:"))[2].callback_data!;
    expect(await tap(coachChat, tgCoach, day)).toBe("coach:tap:time");
    const time = last().buttons.find((b) => b.callback_data?.startsWith("kh:"))!.callback_data!;
    expect(await tap(coachChat, tgCoach, time)).toBe("coach:tap:heads");
    expect(await tap(coachChat, tgCoach, button(/^2$/))).toBe("coach:booked");
    const [lesson] = await db.select().from(lessons).where(eq(lessons.coachId, coachId));
    expect(lesson.minutes).toBe(90);
    expect(lesson.heads).toBe(2);
    expect(lesson.amount).toBe(900);
    expect(last().text).toMatch(/Booked Ivan/);
  });

  it("adds a new student by asking one name, then goes on to the day", async () => {
    await say(coachChat, tgCoach, "＋ Book");
    expect(await tap(coachChat, tgCoach, button(/New student/))).toBe("coach:tap:ask_name");
    expect(last().forceReply).toBe(true);
    expect(await reply(coachChat, tgCoach, "Priya")).toBe("coach:tap:length");
    const [p] = await db.select().from(players).where(eq(players.displayName, "Priya"));
    expect(p).toBeTruthy();
  });

  it("takes an hour and a quarter as taps when the grid has none, and books outside the hours with the extra", async () => {
    await say(coachChat, tgCoach, "＋ Book");
    await tap(coachChat, tgCoach, button(/^Ivan$/));
    await tap(coachChat, tgCoach, button(/60 min/));
    const day = last().buttons[3].callback_data!;
    await tap(coachChat, tgCoach, day);
    expect(await tap(coachChat, tgCoach, button(/Another time/))).toBe("coach:tap:hour");
    expect(last().buttons.filter((b) => /^\d\d:00$/.test(b.text)).length).toBe(18);
    expect(await tap(coachChat, tgCoach, button(/^22:00$/))).toBe("coach:tap:minute");
    expect(await tap(coachChat, tgCoach, button(/^22:30$/))).toBe("coach:tap:heads");
    expect(await tap(coachChat, tgCoach, button(/^1$/))).toBe("coach:booked");
    const late = (await db.select().from(lessons).where(eq(lessons.coachId, coachId))).find((l) => l.minutes === 60 && l.heads === 1);
    expect(late?.amount).toBe(800 + 300);
  });

  it("cancels only after asking, and keeps the lesson on 'Keep it'", async () => {
    expect(await say(coachChat, tgCoach, "✕ Cancel")).toBe("coach:tap:cancel_list");
    const first = last().buttons[0].callback_data!;
    expect(await tap(coachChat, tgCoach, first)).toBe("coach:tap:cancel_ask");
    expect(last().text).toMatch(/^Cancel Ivan/);
    expect(await tap(coachChat, tgCoach, button(/Keep it/))).toBe("coach:tap:dismissed");
    expect((await db.select().from(lessons).where(eq(lessons.coachId, coachId))).every((l) => l.status === "booked")).toBe(true);
    await say(coachChat, tgCoach, "✕ Cancel");
    await tap(coachChat, tgCoach, last().buttons[0].callback_data!);
    expect(await tap(coachChat, tgCoach, button(/Yes, cancel/))).toBe("coach:undo");
    expect((await db.select().from(lessons).where(eq(lessons.coachId, coachId))).some((l) => l.status === "cancelled")).toBe(true);
  });

  it("moves a lesson: which one, which day, which free time", async () => {
    expect(await say(coachChat, tgCoach, "↔ Move")).toBe("coach:tap:move_list");
    const which = last().buttons[0].callback_data!;
    expect(await tap(coachChat, tgCoach, which)).toBe("coach:tap:move_day");
    const day = last().buttons[4].callback_data!;
    expect(await tap(coachChat, tgCoach, day)).toBe("coach:tap:move_time");
    const time = last().buttons.find((b) => b.callback_data?.split(":").length === 4)!.callback_data!;
    expect(await tap(coachChat, tgCoach, time)).toBe("coach:moved");
    expect(last().text).toMatch(/^Moved Ivan/);
  });

  it("opens a lesson from the agenda, marks a no-show and takes it back", async () => {
    // A lesson this morning, already done: the agenda lists it with a button into its card.
    const now = new Date();
    const at = new Date(now.getTime() - 3 * HOUR);
    const [done] = await db.insert(lessons).values({ coachId, studentPlayerId: studentId, startsAt: at, minutes: 60, status: "done", amount: 800, createdAt: now }).returning();
    await say(coachChat, tgCoach, "📅 Today");
    const card = last().buttons.find((b) => b.callback_data === `kl:${packId(done.id)}`);
    // Depending on the hour this runs, "this morning" may be yesterday in Bangkok; open the card directly then.
    expect(await tap(coachChat, tgCoach, card?.callback_data ?? `kl:${packId(done.id)}`)).toBe("coach:tap:lesson");
    expect(last().text).toMatch(/800 THB · not paid/);
    expect(await tap(coachChat, tgCoach, button(/No-show/))).toBe("coach:tap:no_show");
    expect((await getLesson(db, done.id))?.status).toBe("no_show");
    expect(await tap(coachChat, tgCoach, button(/came after all/))).toBe("coach:tap:came");
    expect((await getLesson(db, done.id))?.status).toBe("done");
    // On me: the price goes, the student owes nothing.
    await tap(coachChat, tgCoach, `kl:${packId(done.id)}`);
    expect(await tap(coachChat, tgCoach, button(/On me/))).toBe("coach:tap:comped");
    expect((await getLesson(db, done.id))?.amount).toBe(0);
  });

  it("lists students with a card each, and starts a package from an offer with one tap", async () => {
    expect(await say(coachChat, tgCoach, "👥 Students")).toBe("coach:tap:students");
    expect(last().text).toMatch(/Ivan · No package/);
    expect(await tap(coachChat, tgCoach, button(/^Ivan$/))).toBe("coach:tap:student");
    expect(await tap(coachChat, tgCoach, button(/Package/))).toBe("coach:tap:package_pick");
    expect(last().buttons.some((b) => /10 × 60 min · 7000 THB/.test(b.text))).toBe(true);
    expect(await tap(coachChat, tgCoach, button(/10 × 60 min/))).toBe("coach:package");
    const [pkg] = await db.select().from(lessonPackages).where(eq(lessonPackages.studentPlayerId, studentId));
    expect(pkg.size).toBe(10);
    expect(pkg.amount).toBe(7000);
    expect(pkg.paidAt).toBeNull();
    // The QR photo, with the paid button under it.
    expect(calls.some((c) => c.method === "sendPhoto")).toBe(true);
    expect(last().buttons.some((b) => b.callback_data === `cp:${pkg.id}`)).toBe(true);
  });

  it("starts any other package with three taps and a keypad, never a typed line", async () => {
    await say(coachChat, tgCoach, "👥 Students");
    await tap(coachChat, tgCoach, button(/^Ivan$/));
    await tap(coachChat, tgCoach, button(/Package/));
    expect(await tap(coachChat, tgCoach, button(/Another package/))).toBe("coach:tap:package_size");
    expect(await tap(coachChat, tgCoach, button(/^5$/))).toBe("coach:tap:package_days");
    expect(await tap(coachChat, tgCoach, button(/^30 d$/))).toBe("coach:tap:package_price");
    // The keypad: 3, 5, 0, 0, then a slip and its ⌫, then done.
    expect(last().text).toMatch(/5 × 800 = 4000 THB/);
    for (const d of ["3", "5", "0", "0", "9"]) await tap(coachChat, tgCoach, button(new RegExp(`^${d}$`)));
    expect(last().text).toMatch(/35009$/);
    await tap(coachChat, tgCoach, button(/^⌫$/));
    expect(last().text).toMatch(/3500$/);
    expect(await tap(coachChat, tgCoach, button(/Done/))).toBe("coach:package");
    const pkgs = await db.select().from(lessonPackages).where(eq(lessonPackages.studentPlayerId, studentId));
    expect(pkgs.some((p) => p.size === 5 && p.amount === 3500 && p.expiresAt !== null)).toBe(true);
    // The typed line still works for a coach who likes it.
    expect(await say(coachChat, tgCoach, "ivan +8 60d 5000")).toBe("coach:package");
    await db.update(lessonPackages).set({ closedAt: new Date() }).where(eq(lessonPackages.studentPlayerId, studentId));
    await createPackage(db, { coachId, studentPlayerId: studentId, size: 10, amount: 7000 });
  });

  it("shows the money with a paid button on every open figure", async () => {
    expect(await say(coachChat, tgCoach, "💰 Money")).toBe("coach:tap:money");
    expect(last().text).toMatch(/Ivan · package of 10 · 7000 THB/);
    expect(last().buttons.some((b) => b.callback_data?.startsWith("cp:"))).toBe(true);
    expect(last().buttons.some((b) => b.callback_data?.startsWith("cq:"))).toBe(true);
    expect(await tap(coachChat, tgCoach, last().buttons.find((b) => b.callback_data?.startsWith("cp:"))!.callback_data!)).toBe("coach:paid");
    // The month as an accountant wants it, in the chat, from the same screen.
    await say(coachChat, tgCoach, "💰 Money");
    expect(await tap(coachChat, tgCoach, button(/Statement: this month/))).toBe("coach:tap:statement");
    expect(last().text).toMatch(/^Statement, /);
    expect(last().text).toMatch(/Ivan: .*packages/);
    expect(last().text).toMatch(/Total: /);
  });

  it("changes the rules with taps and marks the one in force", async () => {
    expect(await say(coachChat, tgCoach, "⚙️ Settings")).toBe("coach:tap:settings");
    expect(last().buttons.some((b) => b.text === "✓ 60 min")).toBe(true);
    expect(await tap(coachChat, tgCoach, "ke:cutoff:24")).toBe("coach:set:cutoff");
    expect(last().buttons.some((b) => /✓ .*24 h/.test(b.text))).toBe(true);
    expect(last().buttons.some((b) => b.url?.includes("/coach/settings"))).toBe(true);
    expect(await tap(coachChat, tgCoach, "ke:lesson:45")).toBe("coach:set:lesson");
    await tap(coachChat, tgCoach, "ke:lesson:60");
  });

  it("sets a price on the keypad, the second length with a tap, and its prices on the keypad", async () => {
    await say(coachChat, tgCoach, "⚙️ Settings");
    expect(await tap(coachChat, tgCoach, button(/^Price: 800 THB$/))).toBe("coach:tap:keypad");
    for (const d of ["9", "0", "0"]) await tap(coachChat, tgCoach, button(new RegExp(`^${d}$`)));
    expect(await tap(coachChat, tgCoach, button(/Done/))).toBe("coach:set:p1");
    expect(last().buttons.some((b) => b.text === "Price: 900 THB")).toBe(true);
    expect(await tap(coachChat, tgCoach, "ke:second:0")).toBe("coach:set:second");
    expect(last().buttons.some((b) => /Second length, one person/.test(b.text))).toBe(false);
    expect(await tap(coachChat, tgCoach, "ke:second:90")).toBe("coach:set:second");
    expect(await tap(coachChat, tgCoach, button(/Second length, pair each/))).toBe("coach:tap:keypad");
    for (const d of ["9", "5", "0"]) await tap(coachChat, tgCoach, button(new RegExp(`^${d}$`)));
    expect(await tap(coachChat, tgCoach, button(/Done/))).toBe("coach:set:s2");
    expect(last().buttons.some((b) => b.text === "Second length, pair each: 950 THB")).toBe(true);
    // Back to 800, so the rest of the file reads the numbers it was written for.
    await tap(coachChat, tgCoach, "kv:p1:800:ok");
  });

  it("manages the packages on the page in the chat: list, remove, add in four taps and a keypad", async () => {
    await say(coachChat, tgCoach, "⚙️ Settings");
    expect(await tap(coachChat, tgCoach, button(/Packages on your page/))).toBe("coach:tap:offers");
    expect(last().buttons.some((b) => /✕ 10 × 60 min · 7000 THB · 70 d/.test(b.text))).toBe(true);
    expect(await tap(coachChat, tgCoach, button(/Add a package/))).toBe("coach:tap:offer_size");
    expect(await tap(coachChat, tgCoach, button(/^20$/))).toBe("coach:tap:offer_length");
    expect(await tap(coachChat, tgCoach, button(/90 min/))).toBe("coach:tap:offer_heads");
    expect(await tap(coachChat, tgCoach, button(/^2$/))).toBe("coach:tap:offer_days");
    expect(await tap(coachChat, tgCoach, button(/No expiry/))).toBe("coach:tap:offer_price");
    for (const d of ["8", "0", "0"]) await tap(coachChat, tgCoach, button(new RegExp(`^${d}$`)));
    expect(await tap(coachChat, tgCoach, button(/Done/))).toBe("coach:tap:offers");
    expect(last().buttons.some((b) => /✕ 20 × 90 min · 2 · 800 THB$/.test(b.text))).toBe(true);
    const removeNew = last().buttons.find((b) => /20 × 90/.test(b.text))!.callback_data!;
    expect(await tap(coachChat, tgCoach, removeNew)).toBe("coach:tap:offers");
    expect(last().buttons.some((b) => /20 × 90/.test(b.text))).toBe(false);
    expect(await tap(coachChat, tgCoach, button(/Back/))).toBe("coach:tap:settings");
  });

  it("blocks a day or one of its hours with taps, and names the lessons in the way", async () => {
    expect(await say(coachChat, tgCoach, "🚫 Block time")).toBe("coach:tap:block_day");
    const day = last().buttons[6].callback_data!;
    expect(await tap(coachChat, tgCoach, day)).toBe("coach:tap:block_what");
    expect(last().buttons.some((b) => b.text === "All day")).toBe(true);
    const hour = last().buttons.find((b) => /^\d\d:\d\d$/.test(b.text))!.callback_data!;
    expect(await tap(coachChat, tgCoach, hour)).toBe("coach:block");
    expect(last().text).toMatch(/^Blocked/);
  });

  it("still reads the one-line grammar for a coach who types it", async () => {
    expect(await say(coachChat, tgCoach, "unpaid")).toMatch(/^coach:owed/);
    expect(await say(coachChat, tgCoach, "tomorrow")).toBe("coach:agenda");
  });
});

describe("the student books, moves, pays and takes a package with taps", () => {
  it("books: how long, which day, what time — and a package holder is not asked how many", async () => {
    await createPackage(db, { coachId, studentPlayerId: studentId, size: 5, amount: 3500, paid: true, note: "second" });
    expect(await say(studentChat, tgStudent, "＋ Book")).toBe("student:tap:day");
    const day = last().buttons[5].callback_data!;
    expect(await tap(studentChat, tgStudent, day)).toBe("student:tap:time");
    const time = last().buttons.find((b) => b.callback_data?.startsWith("sh:"))!.callback_data!;
    expect(await tap(studentChat, tgStudent, time)).toBe("student:booked");
    expect(last().text).toMatch(/^Booked:/);
  });

  it("moves their own lesson with three taps", async () => {
    expect(await say(studentChat, tgStudent, "↔ Move")).toBe("student:tap:move_list");
    const which = last().buttons.find((b) => b.callback_data?.startsWith("sm:"))!.callback_data!;
    expect(await tap(studentChat, tgStudent, which)).toBe("student:tap:move_day");
    const day = last().buttons[6].callback_data!;
    expect(await tap(studentChat, tgStudent, day)).toBe("student:tap:move_time");
    const time = last().buttons.find((b) => b.callback_data?.split(":").length === 4)!.callback_data!;
    expect(await tap(studentChat, tgStudent, time)).toBe("student:moved");
  });

  it("asks the coach for a time outside the hours, with the hour and the minutes as taps", async () => {
    await say(studentChat, tgStudent, "＋ Book");
    const day = last().buttons[2].callback_data!;
    await tap(studentChat, tgStudent, day);
    expect(await tap(studentChat, tgStudent, button(/Ask for another time/))).toBe("student:tap:hour");
    expect(await tap(studentChat, tgStudent, button(/^23:00$/))).toBe("student:tap:minute");
    expect(await tap(studentChat, tgStudent, button(/^23:30$/))).toBe("student:tap:requested");
    expect(last().text).toMatch(/^Asked Olga for/);
  });

  it("shows what is owed with 'I paid' per lesson, and takes a package from the page in one tap once the old one is used up", async () => {
    // The coach takes PromptPay and something is owed: the list rides as the caption of the QR photo with the sum in it.
    expect(await say(studentChat, tgStudent, "💳 Pay & package")).toBe("student:tap:pay_qr");
    expect(last().text).toMatch(/With Olga/);
    expect(String(calls.findLast((c) => c.method === "sendPhoto")?.body.photo)).toMatch(/\/pay\/owed\//);
    // The packages already held keep the offer off the screen; close them and the offer appears.
    await db.update(lessonPackages).set({ closedAt: new Date() }).where(eq(lessonPackages.studentPlayerId, studentId));
    await say(studentChat, tgStudent, "💳 Pay & package");
    expect(await tap(studentChat, tgStudent, button(/Take a package/))).toBe("student:tap:packages");
    expect(await tap(studentChat, tgStudent, button(/10 × 60 min/))).toBe("student:tap:package_taken");
    expect(last().text).toMatch(/Your package has started: 10 lessons\. Pay 7000 THB to Olga/);
    expect(last().text).toMatch(/PromptPay/);
    // The coach heard.
    expect(calls.some((c) => c.method === "sendMessage" && /took a package from your page/.test(String(c.body.text)))).toBe(true);
    // A second tap while lessons are left is refused in words.
    await say(studentChat, tgStudent, "💳 Pay & package");
    expect(last().buttons.some((b) => /Take a package/.test(b.text))).toBe(false);
  });

  it("'✕ Cancel' is the lessons list with a ✕ on each", async () => {
    expect(await say(studentChat, tgStudent, "✕ Cancel")).toBe("student:lessons");
    expect(last().buttons.some((b) => b.callback_data?.startsWith("lc:"))).toBe(true);
  });
});
