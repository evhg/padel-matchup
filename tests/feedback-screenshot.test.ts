import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/db";
import { cleanScreenshot, createFeedback, saveScreenshot, screenshotOf, withScreenshots, FEEDBACK_SCREENSHOT_MAX } from "@/lib/feedback/store";
import { createTestDb } from "./helpers/db";

let db: Db;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await createTestDb());
});
afterAll(async () => close());

const B64 = Buffer.from("a small picture, as far as this test is concerned ".repeat(8)).toString("base64");

describe("a screenshot with a note", () => {
  it("takes a small picture as a data URL and nothing else", () => {
    expect(cleanScreenshot(`data:image/jpeg;base64,${B64}`)).toEqual({ mime: "image/jpeg", dataBase64: B64 });
    expect(cleanScreenshot(`data:image/png;base64,${B64}`)?.mime).toBe("image/png");
    expect(cleanScreenshot(`data:text/html;base64,${B64}`)).toBeNull();
    expect(cleanScreenshot(`data:image/svg+xml;base64,${B64}`)).toBeNull();
    expect(cleanScreenshot("https://example.com/a.png")).toBeNull();
    expect(cleanScreenshot(`data:image/jpeg;base64,${"A".repeat(FEEDBACK_SCREENSHOT_MAX + 4)}`)).toBeNull();
    expect(cleanScreenshot(undefined)).toBeNull();
  });

  it("keeps it beside its note, and a list asks for all its notes in one read", async () => {
    const a = await createFeedback(db, { source: "web", text: "The score form does not save" });
    const b = await createFeedback(db, { source: "web", text: "Another note without a picture" });
    await saveScreenshot(db, a.id, { mime: "image/jpeg", dataBase64: B64 });
    const shot = await screenshotOf(db, a.id);
    expect(shot?.mime).toBe("image/jpeg");
    expect(shot?.bytes.equals(Buffer.from(B64, "base64"))).toBe(true);
    expect(await screenshotOf(db, b.id)).toBeNull();
    expect([...(await withScreenshots(db, [a.id, b.id]))]).toEqual([a.id]);
  });
});
