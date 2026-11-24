import { describe, expect, it } from "vitest";
import { filmStart } from "@/components/reelFast";

// 24 November 2026, 18:00 in Bangkok.
const NOW = Date.UTC(2026, 10, 24, 11, 0, 0);

describe("when the film began, for the heart rate of a watch", () => {
  it("takes the film's own clock when it is a date", () => {
    const made = Date.UTC(2026, 10, 24, 2, 30, 0) / 1000;
    expect(filmStart(made, NOW, 5400, NOW)).toEqual({ at: "2026-11-24T02:30:00.000Z", from: "film" });
  });

  it("takes the file's last change less the film's length when the film's clock says nothing or nonsense", () => {
    expect(filmStart(0, NOW, 3600, NOW)).toEqual({ at: "2026-11-24T10:00:00.000Z", from: "file" });
    // A camera with no clock writes 1 January 1970 or a year far ahead.
    expect(filmStart(1, NOW, 3600, NOW).from).toBe("file");
    expect(filmStart(Date.UTC(2031, 0, 1) / 1000, NOW, 3600, NOW).from).toBe("file");
  });

  it("says nothing when neither is a date", () => {
    expect(filmStart(undefined, 0, 60, NOW)).toEqual({ at: null, from: "file" });
  });
});
