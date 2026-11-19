import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@/db";
import { cleanPublicImage, createFeedback, decideFeedback, FEEDBACK_LIMITS, getFeedback, listBuilt, setBuiltLine, withPicture } from "@/lib/feedback/store";
import { renderDeskEmail } from "@/lib/outreach/desk";
import { createTestDb } from "./helpers/db";

// The thank-you for a note that became a change carries a picture of the change (the owner, 19 November 2026).
type Call = { url: string; body: Record<string, unknown> };
let calls: Call[] = [];
const mails = () => calls.filter((c) => c.url === "https://api.resend.com/emails");

describe("a picture of the change", () => {
  let db: Db;
  let close: () => Promise<void>;
  beforeAll(async () => {
    ({ db, close } = await createTestDb());
    process.env.RESEND_API_KEY = "re_test";
    process.env.APP_BASE_URL = "https://kicksma.sh";
  });
  afterAll(async () => close());
  beforeEach(() => {
    calls = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : {} });
        return new Response(JSON.stringify({ id: `sent_${calls.length}` }), { headers: { "content-type": "application/json" } });
      }),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it("is a plain file under /built/ of this site and nothing else", () => {
    expect(cleanPublicImage("/built/feedback-door.png")).toBe("/built/feedback-door.png");
    expect(cleanPublicImage(" /built/score-2.webp ")).toBe("/built/score-2.webp");
    // A link in a message to a person can lead nowhere but to a picture this repository ships.
    for (const bad of ["https://example.com/built/x.png", "//example.com/built/x.png", "/built/../admin.png", "/built/a/b.png", "/built/x.svg", "/built/x.png?u=1", "/other/x.png", "/built/X.png", "/built/.png", "", null, undefined])
      expect(cleanPublicImage(bad), String(bad)).toBeNull();
  });

  it("stands on a line of its own at the end of the thank-you, in the person's language", () => {
    expect(withPicture("Sam, the list now shows the price.", "/built/price.png", "en")).toBe("Sam, the list now shows the price.\n\nThis is how it looks now:\nhttps://kicksma.sh/built/price.png");
    expect(withPicture("Готово.", "/built/price.png", "ru")).toContain("Вот как это выглядит теперь:\nhttps://kicksma.sh/built/price.png");
    expect(withPicture("Hecho.", "/built/price.png", "es")).toContain("Así se ve ahora:\nhttps://kicksma.sh/built/price.png");
    // No picture, no extra line; no text, no message at all.
    expect(withPicture("Sam, done.", null, "en")).toBe("Sam, done.");
    expect(withPicture("  ", "/built/price.png", "en")).toBe("");
  });

  it("cuts a long text to make room, never the link", () => {
    const long = withPicture("x".repeat(FEEDBACK_LIMITS.messageMax + 300), "/built/price.png", "en");
    expect(long.length).toBeLessThanOrEqual(FEEDBACK_LIMITS.messageMax);
    expect(long.endsWith("\nhttps://kicksma.sh/built/price.png")).toBe(true);
  });

  it("an email shows the line as the picture and keeps the link in its plain text", () => {
    const r = renderDeskEmail("Sam, done.\n\nThis is how it looks now:\nhttps://kicksma.sh/built/price.png");
    expect(r.text).toContain("https://kicksma.sh/built/price.png");
    expect(r.html).toContain('<img src="https://kicksma.sh/built/price.png"');
    expect(r.html).toContain("This is how it looks now:");
    // A picture of another site, or a link that is not the whole line, stays text.
    const other = renderDeskEmail("Look:\nhttps://example.com/built/price.png\nsee https://kicksma.sh/built/price.png now");
    expect(other.html).not.toContain("<img");
  });

  it("goes to the person with a shipped verdict, is kept with the note, and shows on the page of what players built", async () => {
    const row = await createFeedback(db, { source: "web", text: "the list of clubs should show the price of a court", locale: "en", name: "Sam", email: "sam@example.com" });
    const r = await decideFeedback(db, row.id, { status: "shipped", message: "Sam, the list of clubs now shows the price. Thank you.", publicSummary: "The list of clubs shows the price of a court", publicImage: "/built/club-price.png" });
    expect(r.delivery).toEqual({ status: "sent" });
    const mail = mails().at(-1)!;
    expect(String(mail.body.text)).toBe("Sam, the list of clubs now shows the price. Thank you.\n\nThis is how it looks now:\nhttps://kicksma.sh/built/club-price.png");
    expect(String(mail.body.html)).toContain('<img src="https://kicksma.sh/built/club-price.png"');
    const kept = await getFeedback(db, row.id);
    expect(kept).toMatchObject({ status: "shipped", publicImage: "/built/club-price.png" });
    expect(kept?.replyText).toContain("https://kicksma.sh/built/club-price.png");
    expect(await listBuilt(db)).toEqual([expect.objectContaining({ summary: "The list of clubs shows the price of a court", image: "/built/club-price.png" })]);
    // A second message about the same note carries the picture the note already has.
    await decideFeedback(db, row.id, { status: "shipped", message: "One more thing: it is on the club page too." });
    expect(String(mails().at(-1)!.body.text)).toContain("https://kicksma.sh/built/club-price.png");
    // The desk can change the picture or take it away without a message.
    expect((await setBuiltLine(db, row.id, { image: "/built/club-price-2.png" }))?.publicImage).toBe("/built/club-price-2.png");
    expect((await setBuiltLine(db, row.id, { image: "" }))?.publicImage).toBeNull();
    expect((await listBuilt(db))[0]?.image).toBeNull();
  });

  it("does not go with any other verdict, and a path of the wrong shape is not kept", async () => {
    const row = await createFeedback(db, { source: "web", text: "please add a dark mode for the match page", locale: "en", name: "Ana", email: "ana@example.com" });
    await decideFeedback(db, row.id, { status: "declined", message: "Ana, the page follows the phone's own setting already.", publicImage: "/built/dark.png" });
    expect(String(mails().at(-1)!.body.text)).toBe("Ana, the page follows the phone's own setting already.");
    expect((await getFeedback(db, row.id))?.publicImage).toBeNull();
    const two = await createFeedback(db, { source: "web", text: "the share page should have a copy button", locale: "en", name: "Bo", email: "bo@example.com" });
    await decideFeedback(db, two.id, { status: "shipped", message: "Bo, it has one now.", publicImage: "https://example.com/x.png" });
    expect(String(mails().at(-1)!.body.text)).toBe("Bo, it has one now.");
    expect((await getFeedback(db, two.id))?.publicImage).toBeNull();
  });
});
