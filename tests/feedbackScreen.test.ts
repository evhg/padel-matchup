import { describe, expect, it } from "vitest";
import { screenOf } from "@/lib/feedback/screen";

describe("the screen a note came from", () => {
  it("keeps an ordinary path as it is", () => {
    expect(screenOf("/clubs")).toBe("/clubs");
    expect(screenOf("/v/warehaus")).toBe("/v/warehaus");
    expect(screenOf("/AB12")).toBe("/AB12");
    expect(screenOf("/c/coach-sam")).toBe("/c/coach-sam");
  });

  it("takes the key out of every route that carries one", () => {
    // A row of notes is read by more people than the player: a key there is a way into the account.
    expect(screenOf("/p/s3cr3t-token")).toBe("/p/[token]");
    expect(screenOf("/p/s3cr3t-token/AB12")).toBe("/p/[token]/AB12");
    expect(screenOf("/AB12/i/inv1te")).toBe("/AB12/i/[invite]");
    expect(screenOf("/AB12/manage/k3y")).toBe("/AB12/manage/[manage]");
    expect(screenOf("/v/warehaus/manage/k3y")).toBe("/v/warehaus/manage/[token]");
  });

  it("drops a query string and a fragment", () => {
    expect(screenOf("/c/coach-sam?i=inv1te")).toBe("/c/coach-sam");
    expect(screenOf("/play?city=phuket#games")).toBe("/play");
  });

  it("refuses what is not a path of this site", () => {
    expect(screenOf("https://example.com/x")).toBeNull();
    expect(screenOf("//example.com/x")).toBeNull();
    expect(screenOf("")).toBeNull();
    expect(screenOf(null)).toBeNull();
  });

  it("stops at 200 characters", () => {
    expect(screenOf("/" + "a".repeat(400))!.length).toBe(200);
  });
});
