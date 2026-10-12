import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, like } from "drizzle-orm";
import type { Db } from "@/db";
import { clubs, emailMarks, events, feedback, metricsDaily, outreach, players, slots } from "@/db/schema";
import { POST as inboundWebhook } from "@/app/api/inbound/resend/route";
import { readBooking } from "@/lib/domain/bookingPaste";
import { machineMail, mailText, ownDomain } from "@/lib/domain/bookMail";
import { dayKey } from "@/lib/domain/metrics";
import { LIMITS, takeRate } from "@/lib/domain/ratelimit";
import { addressKey } from "@/lib/ipKey";
import { signSvix } from "@/lib/outreach/svix";
import { freezeClock } from "./helpers/clock";

/**
 * book@<apex> (the owner, 11 October 2026: "A new address answers by itself with the filled form
 * link, and with nothing else. It never makes a match from the sender's address, because a sender's
 * address can be faked. It keeps no email body."). The webhook is driven as Resend drives it: a signed
 * event, the mail fetched from the Received Emails API, and the answer sent to Resend's send API, all
 * through a fake `fetch` that records every call. NOW is Sunday 11 October 2026, 13:00 in Phuket.
 */
const NOW = new Date("2026-10-11T06:00:00Z");
freezeClock(NOW);
const SECRET = "whsec_" + Buffer.from("book-mail-secret-for-the-tests!!").toString("base64");
const LINK = "https://thepadelsociety.app.link/AbCdEf12345";
const OWNER_TEXT = `Warehaus Mon 12 Oct 18:00-19:30 court 3 with Danny, Alberto ${LINK}?_p=c21`;

type Sent = { url: string; body: Record<string, unknown> };
let sent: Sent[] = [];
let outside: string[] = [];
let mailbox: Record<string, Record<string, unknown>> = {};
let n = 0;
/** Resend refuses the next sends (a 500), as during an outage. */
let failSend = false;

function stubResend() {
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const u = String(input);
    if (u === "https://api.resend.com/emails") {
      if (failSend) return new Response(JSON.stringify({ message: "internal error" }), { status: 500, headers: { "Content-Type": "application/json" } });
      sent.push({ url: u, body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
      return new Response(JSON.stringify({ id: `re_${sent.length}` }), { headers: { "Content-Type": "application/json" } });
    }
    const id = u.startsWith("https://api.resend.com/emails/receiving/") ? decodeURIComponent(u.split("/").pop()!) : null;
    if (id && mailbox[id]) return new Response(JSON.stringify(mailbox[id]), { headers: { "Content-Type": "application/json" } });
    // Nothing else may be reached: a pasted link here would be the preview's one read.
    outside.push(u);
    return new Response("nope", { status: 500 });
  });
}

/** One mail as Resend delivers it: the signed event, then the body behind it. */
async function deliver(mail: { from: string; to?: string[]; subject?: string | null; text?: string | null; html?: string | null; headers?: Record<string, string>; id?: string }) {
  const emailId = mail.id ?? `bm_${++n}`;
  const to = mail.to ?? ["book@kicksma.sh"];
  mailbox[emailId] = { id: emailId, from: mail.from, to, subject: mail.subject ?? null, text: mail.text ?? null, html: mail.html ?? null, message_id: `<${emailId}@mail.example>`, headers: mail.headers ?? {} };
  const body = JSON.stringify({ type: "email.received", data: { email_id: emailId, from: mail.from, to } });
  const ts = String(Math.floor(Date.now() / 1000));
  const svixId = `msg_${emailId}_${Math.random().toString(36).slice(2)}`;
  const res = await inboundWebhook(new Request("https://kicksma.sh/api/inbound/resend", { method: "POST", body, headers: { "svix-id": svixId, "svix-timestamp": ts, "svix-signature": signSvix(SECRET, svixId, ts, body) } }));
  return (await res.json()) as { ok: boolean; book?: string; feedback?: boolean; fresh?: boolean };
}

/** How many matches, seats, players and desk rows there are: the app's own database starts with its demo matches, so a test compares before and after. */
const census = async (db: Db) => ({
  events: (await db.select({ id: events.id }).from(events)).length,
  slots: (await db.select({ id: slots.id }).from(slots)).length,
  players: (await db.select({ id: players.id }).from(players)).length,
  outreach: (await db.select({ id: outreach.id }).from(outreach)).length,
});

const counter = async (db: Db, key: string) => (await db.select().from(metricsDaily).where(eq(metricsDaily.key, key))).find((r) => r.day === dayKey(NOW))?.value ?? 0;

describe("book@: a booking by email gets the filled form, and nothing else", () => {
  let db: Db;
  beforeAll(async () => {
    process.env.RESEND_API_KEY = "re_test";
    process.env.APP_BASE_URL = "https://kicksma.sh";
    process.env.RESEND_WEBHOOK_SECRET = SECRET;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.TELEGRAM_BOT_TOKEN;
    db = await (await import("@/db")).getDb();
    await db.insert(clubs).values({ slug: "warehaus", name: "WAREHAUS.club", manageToken: "tok-warehaus-book-mail-abcdefghijklmnop", source: "directory", tz: "Asia/Bangkok" });
  });
  afterAll(() => vi.unstubAllGlobals());
  afterEach(() => {
    sent = [];
    outside = [];
  });
  beforeAll(stubResend);

  it("answers the owner's case once, from book@, with what it read and the filled form's https link", async () => {
    const before = await census(db);
    const r = await deliver({ from: "Cath Tunti <cath@gmail.example>", subject: "Fwd: Padel booking", text: OWNER_TEXT });
    expect(r).toEqual({ ok: true, book: "answered" });
    expect(sent).toHaveLength(1);
    const mail = sent[0].body;
    expect(mail).toMatchObject({ from: "Kicksmash <book@kicksma.sh>", to: ["cath@gmail.example"], reply_to: "book@kicksma.sh", subject: "Your match form is ready" });
    expect(mail.headers).toMatchObject({ "In-Reply-To": "<bm_1@mail.example>", "Auto-Submitted": "auto-replied" });
    const text = String(mail.text);
    for (const line of ["Club: WAREHAUS.club", "Day: Mon, Oct 12", "Time: 18:00–19:30", "Length: 90 minutes"]) expect(text).toContain(line);
    const url = text.split("\n").find((l) => l.startsWith("https://"))!;
    // The free-text fields (the court, the price, the players) ride in the form's link only, never in the words of the mail.
    expect(text.replace(url, "")).not.toMatch(/Court:|Price:|Players:|Danny|Not in your booking/);
    const form = new URL(url);
    expect(form.origin).toBe("https://kicksma.sh");
    expect(Object.fromEntries(form.searchParams)).toEqual({ src: "paste", venue: "WAREHAUS.club", date: "2026-10-12", time: "18:00", tz: "Asia/Bangkok", len: "90", court: "3", names: "Danny,Alberto", booked: "1", invite: LINK });
    // One link in the whole answer, and it is the form: no sign-in link, no personal link, no match link.
    expect(text.match(/https?:\/\//g)).toHaveLength(1);
    // The words said everything, so the pasted link was never opened.
    expect(outside).toEqual([]);
    // Nothing made, nobody created, nothing kept: no match, no seat, no player, no desk row.
    expect(await census(db)).toEqual(before);
    expect(await counter(db, "book_mail_answered")).toBe(1);
    // No address in any counter's key: the sender's limit is a hash.
    const keys = (await db.select({ key: metricsDaily.key }).from(metricsDaily)).map((r) => r.key);
    expect(keys.some((k) => /cath|gmail/i.test(k))).toBe(false);
    expect(keys).toContain(`rl:paste:mail:${addressKey("cath@gmail.example")}`);
  });

  it("answers a delivery made twice once", async () => {
    await deliver({ from: "ana@mail.example", text: OWNER_TEXT, id: "bm_twice" });
    expect(await deliver({ from: "ana@mail.example", text: OWNER_TEXT, id: "bm_twice" })).toEqual({ ok: true, book: "skipped:again" });
    expect(sent).toHaveLength(1);
  });

  it("a forged From still gets only the link: no match, no held name, no change to the player it names", async () => {
    const [victim] = await db.insert(players).values({ displayName: "Vic", email: "vic@club.example", locale: "en" }).returning();
    const before = await census(db);
    const r = await deliver({ from: "Vic <vic@club.example>", text: OWNER_TEXT });
    expect(r.book).toBe("answered");
    expect(await census(db)).toEqual(before);
    const [after] = await db.select().from(players).where(eq(players.id, victim.id));
    expect(after).toEqual(victim);
    // Nothing in the answer signs anybody in: no personal path, no token.
    expect(String(sent[0].body.text)).not.toMatch(/\/p\/|token|tg=/);
  });

  it("a forged From cannot make book@ say the sender's words: names, a court and a price stay out of the mail", async () => {
    const r = await deliver({ from: "Victim <victim@stranger.example>", text: "Warehaus Mon 12 Oct 18:00-19:30 court 3 ฿1,600\nPlayers: Ana, Visit claimprize.example now, Kicksmash-refund.example, Danny" });
    expect(r.book).toBe("answered");
    const text = String(sent[0].body.text);
    const url = text.split("\n").find((l) => l.startsWith("https://"))!;
    // The words of the mail: the fixed shapes only (the club from the clubs table, the day, the time, the length).
    const words = text.replace(url, "");
    expect(words).not.toMatch(/claimprize|refund\.example|Danny|Ana\b|฿|1,600|Court|Players/);
    expect(words).toContain("Club: WAREHAUS.club");
    // The form still carries what was read, for whoever opens it to check.
    expect(new URL(url).searchParams.get("court")).toBe("3");
  });

  it("opens no link of a mail: a forwarded button that carries a token is never fetched", async () => {
    const html = `<p>Mon 12 Oct 18:00 - 19:30</p><a href="https://app.playtomic.io/bookings/confirm-attendance?token=SECRET123">Confirm attendance</a>`;
    const r = await deliver({ from: "Cath <cath.html@gmail.example>", subject: "Fwd: Your booking", html });
    expect(r.book).toBe("answered");
    expect(outside).toEqual([]);
    expect(String(sent[0].body.text)).not.toMatch(/SECRET123|token|confirm-attendance/);
  });

  it("answers a mail with only a platform's link with the form, and says it found the link", async () => {
    expect((await deliver({ from: "pl@mail.example", subject: "Our game", text: LINK })).book).toBe("answered");
    const text = String(sent[0].body.text);
    expect(text.startsWith("Kicksmash found the link of your booking")).toBe(true);
    expect(text).not.toMatch(/read this in your booking|Not in your booking/);
  });

  it("opens the form in the person's own zone when the mail names no club, never in UTC", async () => {
    // A mail says no zone. With no club to give one, the form's link carries none, and the form takes
    // the zone of the person who opens it. Until 11 October 2026 it carried tz=UTC, and the form kept
    // it: 11:00 read in Phuket became a match at 18:00 Phuket time.
    expect((await deliver({ from: "nz@mail.example", subject: "Padel", text: `Mon 12 Oct 11:00-12:30 ${LINK}` })).book).toBe("answered");
    const url = String(sent[0].body.text).split("\n").find((l) => l.startsWith("https://"))!;
    expect(Object.fromEntries(new URL(url).searchParams)).toEqual({ src: "paste", date: "2026-10-12", time: "11:00", len: "90", booked: "1", invite: LINK });
  });

  it("never prints a length the form cannot take: 75 minutes shows the start alone, and the form keeps its own", async () => {
    expect((await deliver({ from: "len@mail.example", text: "Warehaus Mon 12 Oct 18:00-19:15 court 2" })).book).toBe("answered");
    const text = String(sent[0].body.text);
    expect(text).toContain("Time: 18:00\n");
    expect(text).not.toMatch(/19:15|75 minutes|Length/);
    // The booking gave a length, so the mail does not call it missing either.
    expect(text).not.toMatch(/Not in your booking/);
    const url = text.split("\n").find((l) => l.startsWith("https://"))!;
    expect(new URL(url).searchParams.get("len")).toBeNull();
    // A length the form takes is printed, as before.
    sent = [];
    expect((await deliver({ from: "len2@mail.example", text: "Warehaus Mon 12 Oct 18:00-20:00" })).book).toBe("answered");
    expect(String(sent[0].body.text)).toMatch(/Time: 18:00–20:00\nLength: 120 minutes/);
  });

  it("never answers its own answer when a reply quotes it (Outlook), so a robot that quotes cannot loop", async () => {
    expect((await deliver({ from: "ol@mail.example", text: OWNER_TEXT })).book).toBe("answered");
    const ours = String(sent[0].body.text);
    const reply = `Thanks a lot!\n\n________________________________\nFrom: Kicksmash <book@kicksma.sh>\nSent: Sunday, October 11, 2026 1:00 PM\nTo: ol@mail.example\nSubject: Your match form is ready\n\n${ours}`;
    expect((await deliver({ from: "ol@mail.example", subject: "RE: Your match form is ready", text: reply })).book).toBe("skipped:quote");
    expect(sent).toHaveLength(1);
  });

  it("reads a forwarded confirmation whose first lines start with a header word (Date, Fecha)", async () => {
    const gmail = "Can you make the match?\n\n---------- Forwarded message ---------\nFrom: Playtomic <no-reply@playtomic.io>\nDate: Sat, 10 Oct 2026 at 14:02\nSubject: Booking confirmed\nTo: <gm@mail.example>\n\n\nDate: Monday 12 October 2026\nTime: 18:00 - 19:30\nCourt: 3\nClub: WAREHAUS.club";
    const outlook = "¿Me haces el partido?\n\n________________________________\nDe: Playtomic <no-reply@playtomic.io>\nEnviado: sábado, 10 de octubre de 2026 14:02\nPara: es@mail.example\nAsunto: Reserva confirmada\n\nFecha: lunes 12 de octubre\nHora: 18:00 - 19:30\nClub: WAREHAUS.club";
    expect((await deliver({ from: "gm@mail.example", subject: "Fwd: Booking confirmed", text: gmail })).book).toBe("answered");
    expect((await deliver({ from: "es@mail.example", subject: "RV: Reserva confirmada", text: outlook })).book).toBe("answered");
    const dates = sent.map((s) => new URL(String(s.body.text).split("\n").find((l) => l.startsWith("https://"))!).searchParams.get("date"));
    expect(dates).toEqual(["2026-10-12", "2026-10-12"]);
  });

  it("answers one address three times a day at most, whatever the sender claims", async () => {
    const capRow = async () => (await db.select().from(metricsDaily).where(eq(metricsDaily.key, "rl:bookmail:day"))).find((r) => r.day === dayKey(NOW))?.value ?? 0;
    const used = await capRow();
    const got = [];
    for (let i = 0; i < 4; i++) got.push((await deliver({ from: `Anyone ${i} <target@victim.example>`, text: OWNER_TEXT })).book);
    expect(got).toEqual(["answered", "answered", "answered", "skipped:limit"]);
    expect(sent).toHaveLength(3);
    // The refused fourth takes no place under the day's cap, and no address is in the limit's key.
    expect(await capRow()).toBe(used + 3);
    const keys = (await db.select({ key: metricsDaily.key }).from(metricsDaily)).map((r) => r.key);
    expect(keys).toContain(`rl:bookmail_to:${addressKey("target@victim.example")}`);
    expect(keys.some((k) => /victim/i.test(k))).toBe(false);
  });

  it("counts each answer as a sent email, so the service board's Resend lines see book@", async () => {
    const before = await counter(db, "emails_sent");
    expect((await deliver({ from: "count@mail.example", text: OWNER_TEXT })).book).toBe("answered");
    expect(await counter(db, "emails_sent")).toBe(before + 1);
    expect((await deliver({ from: "count2@mail.example", subject: "Hi", text: "No booking here." })).book).toBe("skipped:nothing");
    expect(await counter(db, "emails_sent")).toBe(before + 1);
  });

  it("gives its place under the day's cap back when Resend refuses the send", async () => {
    const capRow = async () => (await db.select().from(metricsDaily).where(eq(metricsDaily.key, "rl:bookmail:day"))).find((r) => r.day === dayKey(NOW))?.value ?? 0;
    const used = await capRow();
    failSend = true;
    try {
      expect((await deliver({ from: "outage@mail.example", text: OWNER_TEXT })).book).toBe("skipped:send");
    } finally {
      failSend = false;
    }
    expect(await capRow()).toBe(used);
  });

  it("writes the outcome to the function log, with no address in it", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    try {
      await deliver({ from: "Log <log@mail.example>", subject: "Hi", text: "Nothing to read here." });
      expect(info).toHaveBeenCalledWith("book_mail", "skipped:nothing");
      expect(JSON.stringify(info.mock.calls)).not.toMatch(/@/);
    } finally {
      info.mockRestore();
    }
  });

  it("answers in Russian or Spanish when the mail is written in it, else in English", async () => {
    await deliver({ from: "oleg@mail.example", text: `Бронь: Warehaus 12 октября 18:00-19:30 корт 3 ${LINK}` });
    await deliver({ from: "marta@mail.example", text: `Reserva para jugar el partido de pádel: Warehaus 12 de octubre 18:00-19:30 pista 3 ${LINK}` });
    // The sender's own words decide, not the forwarded confirmation's club ("Las" and "á" read as Spanish).
    const rozas = `Can you set this up?\n\n---------- Forwarded message ---------\nFrom: Playtomic <no-reply@playtomic.io>\nDate: Sat, 10 Oct 2026 at 14:02\nSubject: Your booking at Club de Pádel Las Rozas\nTo: <ann@mail.example>\n\nClub de Pádel Las Rozas\nMon 12 Oct, 18:00 - 19:30\nCourt 3\n${LINK}`;
    await deliver({ from: "ann@mail.example", subject: "Fwd: Your booking at Club de Pádel Las Rozas", text: rozas });
    expect(sent.map((s) => s.body.subject)).toEqual(["Форма матча готова", "Tu formulario de partido está listo", "Your match form is ready"]);
    expect(String(sent[0].body.text)).toContain("Клуб: WAREHAUS.club");
    expect(String(sent[1].body.text)).toContain("Hora: 18:00–19:30");
  });

  it("never answers an auto-reply, a bounce, a list, our own domain, or a mail with no booking in it", async () => {
    const cases: [string, Parameters<typeof deliver>[0]][] = [
      ["skipped:machine", { from: "ana@mail.example", text: OWNER_TEXT, headers: { "Auto-Submitted": "auto-replied" } }],
      ["skipped:machine", { from: "ana@mail.example", text: OWNER_TEXT, headers: { Precedence: "bulk" } }],
      ["skipped:machine", { from: "ana@mail.example", text: OWNER_TEXT, headers: { "List-Id": "<padel.lists.example>" } }],
      ["skipped:machine", { from: "MAILER-DAEMON@mx.mail.example", text: `Undelivered: ${OWNER_TEXT}` }],
      ["skipped:machine", { from: "postmaster@mail.example", text: OWNER_TEXT }],
      ["skipped:machine", { from: "Playtomic <no-reply@playtomic.io>", text: OWNER_TEXT }],
      ["skipped:machine", { from: "noreply@mail.example", text: OWNER_TEXT }],
      ["skipped:own", { from: "Kicksmash <book@kicksma.sh>", text: OWNER_TEXT }],
      ["skipped:own", { from: "someone@mail.kicksma.sh", text: OWNER_TEXT }],
      ["skipped:nothing", { from: "ana@mail.example", subject: "Hello", text: "Hi! What is this address for? Do you run padel nights?" }],
      // A reply to our answer: the booking is only in the quoted part.
      ["skipped:nothing", { from: "ana@mail.example", subject: "Re: Your match form is ready", text: `Thanks!\n\nOn Sun, 11 Oct 2026 at 13:00, Kicksmash <book@kicksma.sh> wrote:\n> ${OWNER_TEXT}` }],
      // A club named and nothing else: no platform's link, no day and time.
      ["skipped:nothing", { from: "ana@mail.example", text: "Warehaus is a nice club" }],
      ["skipped:sender", { from: "not an address", text: OWNER_TEXT }],
    ];
    const skippedBefore = await counter(db, "book_mail_skipped");
    for (const [want, mail] of cases) expect([mail.from, mail.headers, (await deliver(mail)).book]).toEqual([mail.from, mail.headers, want]);
    expect(sent).toEqual([]);
    expect(outside).toEqual([]);
    expect(await counter(db, "book_mail_skipped")).toBe(skippedBefore + cases.length);
  });

  it("stops at the sender's paste limit, keyed on the address in any spelling, and at the day's cap", async () => {
    // The sender's limit is the paste box's, thirty a day, on a hash of the normalised address.
    for (let i = 0; i < LIMITS.bookingPastesPerIpPerDay; i++) await takeRate(db, "paste", `mail:${addressKey("bo@mail.example")}`, LIMITS.bookingPastesPerIpPerDay, "day", NOW);
    const capRow = async () => (await db.select().from(metricsDaily).where(eq(metricsDaily.key, "rl:bookmail:day"))).find((r) => r.day === dayKey(NOW))?.value ?? 0;
    const used = await capRow();
    expect((await deliver({ from: "Bo <Bo+padel@Mail.Example>", text: OWNER_TEXT })).book).toBe("skipped:limit");
    expect(sent).toEqual([]);
    // A refused mail gives its place under the day's cap back; an answer keeps one.
    expect(await capRow()).toBe(used);
    expect((await deliver({ from: "cy@mail.example", text: OWNER_TEXT })).book).toBe("answered");
    expect(await capRow()).toBe(used + 1);
    // The day's cap holds for everybody together, whatever address each mail claims.
    await db.update(metricsDaily).set({ value: LIMITS.bookMailAnswersPerDay }).where(eq(metricsDaily.key, "rl:bookmail:day"));
    sent = [];
    expect((await deliver({ from: "di@mail.example", text: OWNER_TEXT })).book).toBe("skipped:cap");
    expect((await deliver({ from: "ed@other.example", text: OWNER_TEXT })).book).toBe("skipped:cap");
    expect(sent).toEqual([]);
    await db.update(metricsDaily).set({ value: 0 }).where(eq(metricsDaily.key, "rl:bookmail:day"));
  });

  it("never writes to an address that bounced or complained", async () => {
    await db.insert(emailMarks).values({ address: "gone@mail.example", kind: "hard", reason: "test", markedAt: NOW });
    expect((await deliver({ from: "gone@mail.example", text: OWNER_TEXT })).book).toBe("skipped:marked");
    expect(sent).toEqual([]);
  });

  it("claude@ and feedback@ behave as before: the desk records, the note is stored, book@ answers neither", async () => {
    const desk = await deliver({ from: "Sam <sam@padelmag.example>", to: ["claude@kicksma.sh"], subject: "Question", text: OWNER_TEXT });
    expect(desk).toMatchObject({ ok: true, fresh: true });
    expect(desk.book).toBeUndefined();
    expect((await db.select().from(outreach).where(eq(outreach.counterpartEmail, "sam@padelmag.example"))).length).toBe(1);
    const note = await deliver({ from: "Marta <marta@club.example>", to: ["feedback@kicksma.sh"], subject: "Idea", text: "Please put the court number on the card." });
    expect(note).toMatchObject({ ok: true, feedback: true });
    expect((await db.select().from(feedback).where(like(feedback.text, "%court number%"))).length).toBe(1);
    // Neither got an answer from book@.
    expect(sent.some((s) => String(s.body.from).includes("book@"))).toBe(false);
  });

  it("only book@ and feedback@ at our own domain leave the desk, and a mail that also goes to claude@ stays on the desk", async () => {
    const press = "Hello, I write for a padel magazine. Could we talk about Kicksmash this week?";
    const cases: { from: string; to: string[]; text: string }[] = [
      // Another domain's book@ and feedback@ are not ours.
      { from: "Ines <ines@hotel.example>", to: ["Hotel desk <book@hotel.example>", "claude@kicksma.sh"], text: press },
      { from: "Jon <jon@hotel.example>", to: ["Hotel <feedback@hotel.example>", "claude@kicksma.sh"], text: press },
      // Our own book@ copied on a mail to claude@: the desk keeps it, and book@ does not answer it.
      { from: "Kai <kai@padelmag.example>", to: ["claude@kicksma.sh", "book@kicksma.sh"], text: OWNER_TEXT },
    ];
    for (const mail of cases) {
      const r = await deliver({ ...mail, subject: "Press question" });
      expect([mail.from, r.book, r.feedback, r.fresh]).toEqual([mail.from, undefined, undefined, true]);
      expect((await db.select().from(outreach).where(eq(outreach.counterpartEmail, mail.from.match(/<(.+)>/)![1]))).length).toBe(1);
    }
    expect(sent.some((s) => String(s.body.from).includes("book@"))).toBe(false);
  });
});

describe("book@'s rules, pure", () => {
  it("reads a robot by its headers", () => {
    expect(machineMail({ "auto-submitted": "auto-replied" })).toBe(true);
    expect(machineMail({ "auto-submitted": "auto-generated" })).toBe(true);
    expect(machineMail({ "auto-submitted": "no" })).toBe(false);
    expect(machineMail({ precedence: "junk" })).toBe(true);
    expect(machineMail({ precedence: "first-class" })).toBe(false);
    expect(machineMail({ "list-id": "<x.example>" })).toBe(true);
    expect(machineMail({ "x-autoreply": "yes" })).toBe(true);
    expect(machineMail({ "content-type": "multipart/report; report-type=delivery-status" })).toBe(true);
    expect(machineMail({ "content-type": "text/plain" })).toBe(false);
    expect(machineMail({})).toBe(false);
  });

  it("knows our own domain and every host under it, and nothing that only looks like it", () => {
    expect(ownDomain("book@kicksma.sh", "kicksma.sh")).toBe(true);
    expect(ownDomain("x@mail.kicksma.sh", "kicksma.sh")).toBe(true);
    expect(ownDomain("x@notkicksma.sh", "kicksma.sh")).toBe(false);
    expect(ownDomain("x@kicksma.sh.example", "kicksma.sh")).toBe(false);
  });

  it("keeps a forwarded confirmation and drops the forward's own date, a reply's quote and a signature", () => {
    const forwarded = [
      "Here is my booking, can you make the match?",
      "",
      "-- ",
      "Cath",
      "Sent from my iPhone",
      "",
      "---------- Forwarded message ---------",
      "From: Playtomic <no-reply@playtomic.io>",
      "Date: Sat, 10 Oct 2026 at 14:02",
      "Subject: Booking confirmed at WAREHAUS.club",
      "To: <cath@gmail.example>",
      "",
      "Mon 12 Oct 18:00-19:30, court 3",
    ].join("\n");
    const r = mailText("Fwd: Booking confirmed", forwarded, null);
    expect(r.text).toContain("Booking confirmed at WAREHAUS.club");
    expect(r.text).toContain("Mon 12 Oct 18:00-19:30, court 3");
    expect(r.text).toContain("Here is my booking");
    expect(r.text).not.toMatch(/Sat, 10 Oct|14:02|no-reply|cath@|Sent from|^Cath$/m);
    expect(r.text.startsWith("Booking confirmed")).toBe(true);
    // A reply: the quote and the line that introduces it go.
    const reply = mailText("Re: Your match form is ready", "Thanks!\n\nOn Sun, 11 Oct 2026 at 13:00, Kicksmash <book@kicksma.sh> wrote:\n> Day: Mon, Oct 12", null);
    expect(reply.text).toBe("Your match form is ready\nThanks!");
    // A forward some clients quote keeps its words, without the quote marks.
    expect(mailText(null, "Begin forwarded message:\n\n> From: x@y.example\n> Mon 12 Oct 18:00", null).text).toContain("Mon 12 Oct 18:00");
  });

  it("reads an HTML-only mail and the platform's link behind its button, bounded to a paste", () => {
    const html = `<html><head><style>.x{color:red}</style></head><body><p>Your court is booked</p><p>Mon 12 Oct<br>18:00 - 19:30</p><a href="https://thepadelsociety.app.link/AbCdEf12345?_p=1&amp;x=2">Open</a><a href="https://tracker.example/c?u=1">Unsubscribe</a></body></html>`;
    const r = mailText("Booking", null, html);
    expect(r.text).toContain("Your court is booked");
    expect(r.text).toContain("18:00 - 19:30");
    expect(r.text).not.toContain("color:red");
    expect(r.links).toEqual(["https://thepadelsociety.app.link/AbCdEf12345?_p=1&x=2"]);
    expect(mailText("x", "a".repeat(50_000), null).text.length).toBeLessThanOrEqual(4000);
  });

  it("reads the entities an HTML-only mail writes: figures, dashes and accented letters", () => {
    const read = (html: string) => readBooking({ text: mailText(null, null, html).text, clubs: [], now: NOW, tz: "UTC" });
    const figures = read("<p>Mon 12 Oct</p><p>18:00&#160;-&#160;19:30</p><p>Court&#160;3</p>");
    expect([figures.minutes, figures.court]).toEqual([90, "3"]);
    expect(read("<p>Mon 12 Oct 18:00&nbsp;&ndash;&nbsp;19:30</p>").minutes).toBe(90);
    expect(read("<p>Mon 12 Oct 18:00&#x2013;19:30</p>").minutes).toBe(90);
    expect(mailText(null, null, "<p>S&aacute;bado &amp; Espa&ntilde;a &mdash; &#1044;&#1072;</p>").text).toBe("Sábado & España — Да");
    // An entity out of bounds reads as nothing, and an escaped one stays escaped.
    expect(mailText(null, null, "<p>a&#0;b&#x110000;c &amp;#160;</p>").text).toBe("a b c &#160;");
  });

  it("keeps the sender's own words apart from what they forwarded, for the answer's language", () => {
    expect(mailText("Fwd: Reserva en Club de Pádel Las Rozas", "Can you set this up?\n\n---------- Forwarded message ---------\nFrom: x@y.example\n\nClub de Pádel Las Rozas", null).own).toBe("Can you set this up?");
    expect(mailText("Reserva para el partido", "https://thepadelsociety.app.link/AbCdEf12345", null).own).toBe("Reserva para el partido\nhttps://thepadelsociety.app.link/AbCdEf12345");
    expect(mailText("Fwd: Reserva", "---------- Forwarded message ---------\nFrom: x@y.example\n\nPista 3", null).own).toBe("");
  });

  it("never stalls on a mail built to stall a pattern", () => {
    const pages = [
      "<".repeat(200_000),
      `<a href="https://${"a".repeat(199_000)}`,
      "<style>".repeat(28_000),
      `<p>${"-".repeat(100_000)}</p>`,
    ];
    for (const html of pages) {
      const t0 = performance.now();
      mailText("x", null, html);
      expect(performance.now() - t0).toBeLessThan(1000);
    }
    const t0 = performance.now();
    mailText("x", `${"-".repeat(999)}\n`.repeat(20) + `${"> ".repeat(500)}\n`.repeat(20) + `On ${"x ".repeat(490)}\n`.repeat(20), null);
    expect(performance.now() - t0).toBeLessThan(1000);
  });
});
