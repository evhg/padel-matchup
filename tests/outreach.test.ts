import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Db } from "@/db";
import { approveOutreach, askOwnerOutreach, createDraft, draftReplyTo, isAutomatedSender, listOutreach, notifyInbound, outreachWeek, parseAddress, recordInbound, renderDeskEmail, saveOutreachDraft, skipOutreach } from "@/lib/outreach/desk";
import { signSvix, verifySvix } from "@/lib/outreach/svix";
import { POST as inboundWebhook } from "@/app/api/inbound/resend/route";
import { createTestDb } from "./helpers/db";

const SECRET = "whsec_" + Buffer.from("a-32-byte-secret-for-the-tests!!").toString("base64");

describe("press desk", () => {
  let db: Db;
  let close: () => Promise<void>;
  const env = { ...process.env };
  beforeAll(async () => {
    ({ db, close } = await createTestDb());
    process.env.TELEGRAM_BOT_TOKEN = "123:test";
    process.env.TELEGRAM_OWNER_ID = "777";
    process.env.RESEND_API_KEY = "re_test";
    process.env.APP_BASE_URL = "https://kicksma.sh";
    process.env.RESEND_WEBHOOK_SECRET = SECRET;
    delete process.env.ANTHROPIC_API_KEY;
  });
  afterAll(async () => {
    for (const k of ["TELEGRAM_BOT_TOKEN", "TELEGRAM_OWNER_ID", "RESEND_API_KEY", "APP_BASE_URL", "RESEND_WEBHOOK_SECRET", "ANTHROPIC_API_KEY"]) {
      if (env[k] === undefined) delete process.env[k];
      else process.env[k] = env[k];
    }
    await close();
  });
  afterEach(() => vi.unstubAllGlobals());

  type Call = { url: string; body: Record<string, unknown> };
  const stubNet = (received?: Record<string, unknown>, anthropicText?: string) => {
    const calls: Call[] = [];
    vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
      calls.push({ url: u, body });
      if (u.includes("api.telegram.org")) return new Response(JSON.stringify({ ok: true, result: { message_id: calls.length } }), { headers: { "Content-Type": "application/json" } });
      if (u === "https://api.resend.com/emails") return new Response(JSON.stringify({ id: `re_${calls.length}` }), { headers: { "Content-Type": "application/json" } });
      if (u.startsWith("https://api.resend.com/emails/receiving/")) return new Response(JSON.stringify(received ?? {}), { status: received ? 200 : 404, headers: { "Content-Type": "application/json" } });
      if (u.includes("api.anthropic.com")) return new Response(JSON.stringify({ content: [{ type: "text", text: anthropicText ?? "NO_REPLY" }], usage: { input_tokens: 10, output_tokens: 5 } }), { headers: { "Content-Type": "application/json" } });
      return new Response("nope", { status: 500 });
    });
    return calls;
  };

  it("validates drafts and renders a personal, plain email", async () => {
    await expect(createDraft(db, { to: "not-an-email", subject: "x", body: "y" })).rejects.toThrow("invalid_email");
    await expect(createDraft(db, { to: "a@b.co", subject: "", body: "y" })).rejects.toThrow("invalid_subject");
    await expect(createDraft(db, { to: "a@b.co", subject: "s", body: "" })).rejects.toThrow("invalid_body");
    const r = renderDeskEmail("Hi Emma,\n\nTwo lines.\nSame paragraph.\n\nClaude, for Kicksmash");
    expect(r.text).toBe("Hi Emma,\n\nTwo lines.\nSame paragraph.\n\nClaude, for Kicksmash");
    expect(r.html).toContain("<p style=\"margin:0 0 14px 0\">Two lines.<br>Same paragraph.</p>");
    expect(parseAddress('"Emma Pooley" <emma@thebandeja.com>')).toEqual({ email: "emma@thebandeja.com", name: "Emma Pooley" });
    expect(parseAddress("EDITOR@Example.org")).toEqual({ email: "editor@example.org", name: null });
    expect(isAutomatedSender("no-reply@github.com")).toBe(true);
    expect(isAutomatedSender("mailer-daemon@googlemail.com")).toBe(true);
    expect(isAutomatedSender("emma@thebandeja.com")).toBe(false);
  });

  it("asks the owner when a draft's moment has come, a few a day, and one tap sends it from claude@", async () => {
    const calls = stubNet();
    const now = new Date("2026-09-15T08:00:00Z");
    const later = await createDraft(db, { to: "Info@ThePadelPaper.com", name: "The Padel Paper", org: "The Padel Paper", subject: "A padel organiser that lives in the chat", body: "Hi team,\n\nShort pitch.\n\nClaude, for Kicksmash", moment: "press", notBefore: new Date("2026-09-22T00:00:00Z") }, now);
    const due = await createDraft(db, { to: "emma@thebandeja.com", name: "Emma", org: "The Bandeja", subject: "Hello from Kicksmash", body: "Hi Emma,\n\nA pitch.\n\nClaude, for Kicksmash", moment: "press" }, now);
    expect(later.counterpartEmail).toBe("info@thepadelpaper.com");
    expect(await askOwnerOutreach(db, now)).toBe(1);
    const dm = calls.find((c) => c.url.includes("sendMessage"));
    expect(dm?.body.chat_id).toBe(777);
    expect(String(dm?.body.text)).toContain("Emma · The Bandeja");
    expect(JSON.stringify(dm?.body.reply_markup)).toContain(`oa:${due.id}`);
    // Asked once only.
    expect(await askOwnerOutreach(db, new Date(now.getTime() + 3600_000))).toBe(0);
    // The tap.
    const edited = await saveOutreachDraft(db, due.id, { body: "Hi Emma,\n\nA better pitch.\n\nClaude, for Kicksmash" });
    expect(edited?.body).toContain("better");
    const sent = await approveOutreach(db, due.id, new Date(now.getTime() + 7200_000));
    expect(sent.status).toBe("sent");
    const mail = calls.find((c) => c.url === "https://api.resend.com/emails");
    expect(mail?.body).toMatchObject({ from: "Claude at Kicksmash <claude@kicksma.sh>", to: ["emma@thebandeja.com"], reply_to: "claude@kicksma.sh", subject: "Hello from Kicksmash" });
    expect(String(mail?.body.text)).toContain("A better pitch.");
    expect(mail?.body.headers).toBeUndefined();
    expect((await approveOutreach(db, due.id)).status).toBe("already");
    // Skip the other one; skipping twice is a no-op.
    expect((await skipOutreach(db, later.id))?.status).toBe("skipped");
    expect(await skipOutreach(db, later.id)).toBeNull();
    const week = await outreachWeek(db, new Date("2026-09-14T00:00:00Z"));
    expect(week).toEqual({ sent: 1, received: 0, waiting: 0 });
  });

  it("records what comes back, threads it to the pitch, tells the owner about humans only, and drafts a reply when a key exists", async () => {
    const calls = stubNet();
    const now = new Date("2026-09-16T09:00:00Z");
    const { row, fresh } = await recordInbound(db, { emailId: "rcv_1", from: "Emma Pooley <emma@thebandeja.com>", to: ["claude@kicksma.sh"], subject: "Re: Hello from Kicksmash", text: "Sounds interesting, can you send numbers?", html: null, messageId: "<m1@bandeja>", inReplyTo: null }, now);
    expect(fresh).toBe(true);
    expect(row).toMatchObject({ kind: "inbound", status: "received", counterpartEmail: "emma@thebandeja.com", counterpartName: "Emma Pooley", org: "The Bandeja", moment: "press", threadKey: "emma@thebandeja.com" });
    expect((await recordInbound(db, { emailId: "rcv_1", from: "emma@thebandeja.com", to: [], subject: "dup", text: "x", html: null, messageId: null, inReplyTo: null }, now)).fresh).toBe(false);
    expect(await notifyInbound(row)).toBe(true);
    expect(String(calls.at(-1)?.body.text)).toContain("Emma Pooley · The Bandeja");
    // Machines: stored, nobody woken, no reply drafted.
    const bot = await recordInbound(db, { emailId: "rcv_2", from: "Mail Delivery <mailer-daemon@googlemail.com>", to: ["claude@kicksma.sh"], subject: "Undeliverable", text: null, html: "<p>Address <b>not found</b></p>", messageId: null, inReplyTo: null }, now);
    expect(bot.row.body).toBe("Address not found");
    expect(await notifyInbound(bot.row)).toBe(false);
    // No Anthropic key: no draft. With one: a reply draft in the queue, threaded.
    expect(await draftReplyTo(db, row, now)).toBeNull();
    process.env.ANTHROPIC_API_KEY = "sk-test";
    stubNet(undefined, "Hi Emma,\n\nHere are the numbers.\n\nClaude, for Kicksmash");
    const reply = await draftReplyTo(db, row, now);
    expect(reply).toMatchObject({ kind: "reply", status: "draft", subject: "Re: Hello from Kicksmash", counterpartEmail: "emma@thebandeja.com", inReplyTo: "<m1@bandeja>" });
    expect(await draftReplyTo(db, bot.row, now)).toBeNull();
    const calls2 = stubNet();
    expect((await approveOutreach(db, reply!.id, now)).status).toBe("sent");
    const mail = calls2.find((c) => c.url === "https://api.resend.com/emails");
    expect(mail?.body.headers).toEqual({ "In-Reply-To": "<m1@bandeja>", References: "<m1@bandeja>" });
    delete process.env.ANTHROPIC_API_KEY;
    expect((await listOutreach(db, ["received"])).length).toBe(2);
  });

  it("verifies Resend's signature and turns an email.received event into a desk row", async () => {
    // The route talks to the app's own database (embedded, persistent between runs), so the id must be new each run.
    const emailId = `rcv_${Date.now()}`;
    const body = JSON.stringify({ type: "email.received", data: { email_id: emailId, from: "Sam <sam@padelmag.example>", to: ["claude@kicksma.sh"], subject: "Question" } });
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = signSvix(SECRET, "msg_1", ts, body);
    expect(verifySvix(SECRET, { id: "msg_1", timestamp: ts, signature: sig }, body)).toBe(true);
    expect(verifySvix(SECRET, { id: "msg_1", timestamp: ts, signature: "v1,AAAA" }, body)).toBe(false);
    expect(verifySvix(SECRET, { id: "msg_1", timestamp: String(Number(ts) - 3600), signature: signSvix(SECRET, "msg_1", String(Number(ts) - 3600), body) }, body)).toBe(false);
    expect(verifySvix(SECRET, { id: "msg_1", timestamp: ts, signature: `v0,x ${sig}` }, body)).toBe(true);
    stubNet({ id: emailId, from: "Sam <sam@padelmag.example>", to: ["claude@kicksma.sh"], subject: "Question", text: "How many players use it?", html: null, message_id: "<q1@padelmag>", headers: { "In-Reply-To": "<our-1@kicksma.sh>" } });
    const mk = (b: string, headers: Record<string, string>) => new Request("https://kicksma.sh/api/inbound/resend", { method: "POST", body: b, headers });
    expect((await inboundWebhook(mk(body, { "svix-id": "msg_1", "svix-timestamp": ts, "svix-signature": "v1,bad" }))).status).toBe(401);
    const ok = await inboundWebhook(mk(body, { "svix-id": "msg_1", "svix-timestamp": ts, "svix-signature": sig }));
    expect(ok.status).toBe(200);
    const json = (await ok.json()) as { ok: boolean; fresh: boolean };
    expect(json).toMatchObject({ ok: true, fresh: true });
    const { getDb } = await import("@/db");
    const rows = await listOutreach(await getDb(), ["received"]);
    const sam = rows.find((r) => r.resendId === emailId);
    expect(sam).toMatchObject({ counterpartName: "Sam", body: "How many players use it?", messageId: "<q1@padelmag>", inReplyTo: "<our-1@kicksma.sh>" });
    // Other event types are acknowledged and ignored.
    const other = JSON.stringify({ type: "email.sent", data: { email_id: "x" } });
    const r2 = await inboundWebhook(mk(other, { "svix-id": "msg_2", "svix-timestamp": ts, "svix-signature": signSvix(SECRET, "msg_2", ts, other) }));
    expect(await r2.json()).toMatchObject({ ok: true, ignored: "email.sent" });
  });
});
