import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/db";
import { createAnswerPage, getPublishedAnswer, slugifyTitle } from "@/lib/listen/answers";
import { createTestDb } from "./helpers/db";

describe("answer pages written by the operator", () => {
  let db: Db;
  let close: () => Promise<void>;
  beforeAll(async () => {
    ({ db, close } = await createTestDb());
  });
  afterAll(async () => close());

  it("slugs keep Cyrillic, drop the rest, and never collide", async () => {
    expect(slugifyTitle("Где поиграть в падел на Пхукете вечером?")).toBe("где-поиграть-в-падел-на-пхукете-вечером");
    expect(slugifyTitle("  Americano for 8: the exact rotation!  ")).toBe("americano-for-8-the-exact-rotation");
    const body = "Вечером корты заняты с 18:00 до 21:00, поэтому бронируйте за день. Открытые матчи и клубы собраны на kicksma.sh/phuket; создайте свой матч и поделитесь ссылкой в чате.";
    const a = await createAnswerPage(db, { slug: "gde-poigrat-v-padel-na-phukete-vecherom", language: "ru", title: "Где поиграть в падел на Пхукете вечером", question: "Хочу поиграть вечером, никого не знаю.", answer: body });
    const b = await createAnswerPage(db, { slug: "gde-poigrat-v-padel-na-phukete-vecherom", language: "ru", title: "Где поиграть в падел на Пхукете вечером", question: "Хочу поиграть вечером, никого не знаю.", answer: body });
    expect(a.slug).toBe("gde-poigrat-v-padel-na-phukete-vecherom");
    expect(b.slug).toBe("gde-poigrat-v-padel-na-phukete-vecherom-2");
    expect(a.publishedAt).toBeInstanceOf(Date);
    expect((await getPublishedAnswer(db, a.slug))?.language).toBe("ru");
    const draft = await createAnswerPage(db, { language: "en", title: "Draft only", question: "q", answer: body, publish: false });
    expect(draft.publishedAt).toBeNull();
    await expect(createAnswerPage(db, { language: "en", title: "Too short", question: "q", answer: "short" })).rejects.toThrow("invalid_page");
  });
});
