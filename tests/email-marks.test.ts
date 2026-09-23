import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { emailMarks } from "@/db/schema";
import { clearMark, liftOnConsent, markFromEvent, markOf, markedAmong, marksSince, recordMark, SOFT_BOUNCES_TO_MARK } from "@/lib/domain/emailMarks";
import { consumeEmailCode, issueEmailCode } from "@/lib/domain/identity";
import { signSvix } from "@/lib/outreach/svix";
import { POST as inboundWebhook } from "@/app/api/inbound/resend/route";
import { createTestDb } from "./helpers/db";

/**
 * Bounces and complaints (src/lib/domain/emailMarks.ts). Before 23 September 2026 the app handled
 * neither: a dead address counted as reachable, and Resend's suppression list refused each new
 * attempt quietly. These hold the rules: when an address is marked, what writing to it does, and
 * the one proof that clears it.
 */

const at = (day: number) => new Date(Date.UTC(2026, 8, day, 12));

describe("reading Resend's events", () => {
  it("tells a hard bounce from a soft one, and a complaint from both", () => {
    const to = ["Henk <Henk@Example.com>"];
    expect(markFromEvent({ type: "email.bounced", data: { to, bounce: { type: "Permanent", subType: "General" } } })).toMatchObject({ addresses: ["henk@example.com"], kind: "hard" });
    expect(markFromEvent({ type: "email.bounced", data: { to, bounce: { type: "Transient", subType: "MailboxFull" } } })?.kind).toBe("soft");
    expect(markFromEvent({ type: "email.bounced", data: { to } })?.kind).toBe("soft"); // no verdict is not a verdict of "gone"
    expect(markFromEvent({ type: "email.complained", data: { to } })?.kind).toBe("complaint");
    expect(markFromEvent({ type: "email.suppressed", data: { to } })?.kind).toBe("hard");
    expect(markFromEvent({ type: "email.delivered", data: { to } })).toBeNull();
    expect(markFromEvent({ type: "email.bounced", data: { to: [] } })).toBeNull();
  });
});

describe("marking an address", () => {
  it("marks a hard bounce and a complaint at once, and a full mailbox only after three", async () => {
    const { db } = await createTestDb();
    expect(await recordMark(db, "gone@example.com", "hard", "Permanent", at(17))).toBe(true);
    expect(await recordMark(db, "spam@example.com", "complaint", "marked as spam", at(17))).toBe(true);
    for (let i = 1; i < SOFT_BOUNCES_TO_MARK; i++) expect(await recordMark(db, "full@example.com", "soft", "MailboxFull", at(17 + i))).toBe(false);
    expect(await recordMark(db, "full@example.com", "soft", "MailboxFull", at(20))).toBe(true);
    expect([...(await markedAmong(db, ["GONE@example.com", "full@example.com", "fine@example.com", null]))].sort()).toEqual(["full@example.com", "gone@example.com"]);
    // A soft bounce after a complaint is still a complaint.
    await recordMark(db, "spam@example.com", "soft", "MailboxFull", at(21));
    expect((await markOf(db, "spam@example.com"))?.kind).toBe("complaint");
    expect(await marksSince(db, at(1))).toEqual({ bounced: 2, complained: 1 });
  });

  it("clears on proof, and on consent for everything but an address that does not exist", async () => {
    const { db } = await createTestDb();
    await recordMark(db, "gone@example.com", "hard", "Permanent", at(17));
    await recordMark(db, "spam@example.com", "complaint", "marked as spam", at(17));
    await liftOnConsent(db, "spam@example.com");
    await liftOnConsent(db, "gone@example.com");
    expect(await markOf(db, "spam@example.com")).toBeNull();
    expect((await markOf(db, "gone@example.com"))?.kind).toBe("hard");
    await clearMark(db, "Gone@Example.com");
    expect(await markOf(db, "gone@example.com")).toBeNull();
  });

  it("a code typed back from the address is the proof that clears it", async () => {
    const { db } = await createTestDb();
    await recordMark(db, "back@example.com", "hard", "Permanent", at(17));
    const issued = await issueEmailCode(db, "back@example.com");
    expect(issued).not.toBeNull();
    await consumeEmailCode(db, "back@example.com", issued!.code);
    expect(await markOf(db, "back@example.com")).toBeNull();
  });
});

describe("the webhook and the sender", () => {
  it("records a signed bounce, and nothing more goes to that address except a code", async () => {
    process.env.RESEND_WEBHOOK_SECRET = "whsec_" + Buffer.from("bounce-secret").toString("base64");
    const body = JSON.stringify({ type: "email.bounced", data: { email_id: "e1", to: ["henk@example.com"], bounce: { type: "Permanent", subType: "General", message: "no such user" } } });
    const ts = String(Math.floor(Date.now() / 1000));
    const res = await inboundWebhook(new Request("https://kicksma.sh/api/inbound/resend", { method: "POST", body, headers: { "svix-id": "msg_b1", "svix-timestamp": ts, "svix-signature": signSvix(process.env.RESEND_WEBHOOK_SECRET, "msg_b1", ts, body) } }));
    expect(await res.json()).toMatchObject({ ok: true, kind: "hard", marked: 1 });
    const unsigned = await inboundWebhook(new Request("https://kicksma.sh/api/inbound/resend", { method: "POST", body, headers: { "svix-id": "msg_b2", "svix-timestamp": ts, "svix-signature": "v1,bad" } }));
    expect(unsigned.status).toBe(401);

    const { getDb } = await import("@/db");
    const appDb = await getDb();
    expect((await appDb.select().from(emailMarks).where(eq(emailMarks.address, "henk@example.com")))[0]?.reason).toContain("no such user");

    // The sender, through the local sink so nothing leaves the machine.
    const sinkFile = path.join(mkdtempSync(path.join(tmpdir(), "marks-")), "mail.jsonl");
    process.env.RESEND_API_KEY = "re_test_only";
    process.env.EMAIL_SINK_FILE = sinkFile;
    const { sendEmail } = await import("@/lib/email/send");
    expect(await sendEmail({ to: "henk@example.com", subject: "Line-up complete", html: "<p>x</p>", text: "x" })).toBe(false);
    expect(existsSync(sinkFile)).toBe(false);
    expect(await sendEmail({ to: "henk@example.com", subject: "Your code", html: "<p>123456</p>", text: "123456", proof: true })).toBe(true);
    expect(await sendEmail({ to: "ana@example.com", subject: "Line-up complete", html: "<p>x</p>", text: "x" })).toBe(true);
    expect(readFileSync(sinkFile, "utf8").trim().split("\n").map((l) => JSON.parse(l).to)).toEqual(["henk@example.com", "ana@example.com"]);
  });
});
