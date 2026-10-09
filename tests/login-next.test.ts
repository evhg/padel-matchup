import { describe, expect, it } from "vitest";
import { LOGIN_NEXT_MAX, loginNext } from "@/lib/telegram/login";

// Where a Telegram sign-in lands. Everything that is not a path on this site goes to My matches.
describe("loginNext", () => {
  it("keeps a path on this site", () => {
    expect(loginNext("/AB12")).toBe("/AB12");
    expect(loginNext("/g/QWERTY")).toBe("/g/QWERTY");
    expect(loginNext("/coaches/phuket?level=3")).toBe("/coaches/phuket?level=3");
    expect(loginNext("/AB12#score")).toBe("/AB12#score");
  });

  it("falls back to My matches when there is nothing to go back to", () => {
    // The landing page is the create form: a sign-in there came for the player's own matches.
    expect(loginNext("/")).toBe("/me");
    expect(loginNext("/?source=homescreen")).toBe("/me");
    expect(loginNext(null)).toBe("/me");
    expect(loginNext(undefined)).toBe("/me");
    expect(loginNext("")).toBe("/me");
  });

  it("refuses another host, however it is spelled", () => {
    for (const bad of [
      "https://evil.example/",
      "http://evil.example",
      "javascript:alert(1)",
      "data:text/html,hi",
      "evil.example/AB12",
      "AB12",
      "//evil.example",
      "//evil.example/AB12",
      "/\\evil.example",
      "/\\/evil.example",
      "/AB12\\..\\",
      "/\t/evil.example",
      "/\n/evil.example",
      "/\r\n/evil.example",
      " /AB12",
      "/AB12 ",
      "/\u0000",
    ]) {
      expect(loginNext(bad), JSON.stringify(bad)).toBe("/me");
    }
  });

  it("refuses anything longer than a page we mint", () => {
    const long = `/${"a".repeat(LOGIN_NEXT_MAX)}`;
    expect(long.length).toBe(LOGIN_NEXT_MAX + 1);
    expect(loginNext(long)).toBe("/me");
    expect(loginNext(long.slice(0, LOGIN_NEXT_MAX))).toBe(long.slice(0, LOGIN_NEXT_MAX));
  });

  it("never carries a personal link, because a token does not travel in a query", () => {
    expect(loginNext("/p/abcdefghijklmnop")).toBe("/me");
    expect(loginNext("/p/abcdefghijklmnop/AB12")).toBe("/me");
    expect(loginNext("/P/abc")).toBe("/me");
    expect(loginNext("/p")).toBe("/me");
    // A page whose name only starts with a p is a page like any other.
    expect(loginNext("/play")).toBe("/play");
  });
});
