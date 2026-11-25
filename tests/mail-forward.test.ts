import { describe, expect, it } from "vitest";
import { forwardBody, forwardInbound, forwardTarget } from "@/lib/outreach/forward";
import type { InboundMail } from "@/lib/outreach/desk";
import { apexHost } from "@/lib/config";

/**
 * A copy of every mail at our domain to the owner's inbox (the owner, 25 November 2026: "forward every email sent
 * to @kicksma.sh to <their address> for now"). Driven with a fake `fetch` that records what Resend would send.
 */
const MAIL: InboundMail = {
  emailId: "e1",
  from: "Ana Example <ana@example.org>",
  to: ["hello@kicksma.sh"],
  subject: "A question <about> courts",
  text: "Hi, is court 3 free on Sunday?",
  html: null,
  messageId: "<m1@example.org>",
  inReplyTo: null,
  receivedAt: new Date("2026-11-25T13:00:00Z"),
};

function recorder() {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init?.body ?? "{}")) });
    return new Response(JSON.stringify({ id: "sent-1" }), { status: 200 });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

describe("the mail forward", () => {
  it("is on only for a real address outside our own domain", () => {
    expect(forwardTarget(undefined, "kicksma.sh")).toBeNull();
    expect(forwardTarget("not an address", "kicksma.sh")).toBeNull();
    // a forward to our own domain would come back through the same webhook, for ever
    expect(forwardTarget("owner@KICKSMA.SH", "kicksma.sh")).toBeNull();
    expect(forwardTarget(" owner@example.com ", "kicksma.sh")).toBe("owner@example.com");
  });

  it("sends a copy with the original's facts on top, and a reply goes to the sender", async () => {
    const { calls, fetchImpl } = recorder();
    const out = await forwardInbound(MAIL, fetchImpl, { to: "owner@example.com", key: "re_test" });
    expect(out).toBe("sent");
    expect(calls).toHaveLength(1);
    const b = calls[0].body;
    expect(calls[0].url).toBe("https://api.resend.com/emails");
    expect(b.to).toEqual(["owner@example.com"]);
    expect(b.reply_to).toBe("ana@example.org");
    expect(b.subject).toBe("Fwd: A question <about> courts");
    expect(String(b.text)).toContain("From: Ana Example <ana@example.org>");
    expect(String(b.text)).toContain("To: hello@kicksma.sh");
    expect(String(b.text)).toContain("is court 3 free on Sunday?");
    // the stranger's words are escaped in the facts block of the HTML part
    expect(String(b.html)).toContain("A question &lt;about&gt; courts");
  });

  it("sends nothing when it is off, and nothing for a mail from our own domain", async () => {
    const { calls, fetchImpl } = recorder();
    expect(await forwardInbound(MAIL, fetchImpl, { key: "re_test" })).toBe("off");
    expect(await forwardInbound({ ...MAIL, from: `Claude <claude@${apexHost()}>` }, fetchImpl, { to: "owner@example.com", key: "re_test" })).toBe("own");
    expect(calls).toHaveLength(0);
  });

  it("keeps an HTML mail's own HTML under the facts", () => {
    const f = forwardBody({ ...MAIL, text: null, html: "<p>Hello <b>there</b></p>" });
    expect(f.html.endsWith("<p>Hello <b>there</b></p>")).toBe(true);
    expect(f.text).toContain("Hello there");
  });

  it("never throws when Resend fails", async () => {
    const fetchImpl = (async () => {
      throw new Error("network");
    }) as unknown as typeof fetch;
    expect(await forwardInbound(MAIL, fetchImpl, { to: "owner@example.com", key: "re_test" })).toBe("failed");
  });
});
