import { describe, expect, it } from "vitest";
import { byNameOver, predatesSignOut, RENEW_EVERY_DAYS, renewDue, renewedOnOf, utcDay } from "@/lib/domain/browserSession";
import { deletionRefusal } from "@/lib/domain/thatsMe";
import { freezeClock } from "./helpers/clock";

/**
 * How long a browser's sign-in lives and what ends it, as pure rules (the owner, 28 October 2026):
 * a full sign-in lasts a year after the last visit, renewed at most once in 30 days; a sign-in by name
 * ends a year after it began; "Not you? Sign out" makes every older credential of the browser open
 * nothing; and a session by name may not delete the account.
 */
const NOW = new Date("2026-10-28T09:00:00Z");
freezeClock(NOW);
const today = utcDay(NOW);
/** The UTC day `n` days before NOW. */
const daysAgo = (n: number) => utcDay(new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000));

describe("the day km_has_id carries", () => {
  it("reads a day, and nothing else", () => {
    expect(today).toBe("2026-10-28");
    expect(renewedOnOf("2026-10-28")).toBe("2026-10-28");
    // "1" is the value every browser held before this rule: no day, so the next visit renews it.
    for (const v of ["1", "", null, undefined, "2026-13-45", "28-10-2026", "2026-10-28x", "2026-10-28; km_player=x"]) expect(renewedOnOf(v), String(v)).toBeNull();
  });
});

describe("a full sign-in gets a new year at most once in 30 days", () => {
  const full = (renewedOn: string | null) => renewDue({ signedIn: true, byName: false, renewedOn, today });

  it("renews a year that began 30 days ago or more, never sooner", () => {
    expect(RENEW_EVERY_DAYS).toBe(30);
    expect(full(today)).toBe(false);
    expect(full(daysAgo(1))).toBe(false);
    expect(full(daysAgo(29))).toBe(false);
    expect(full(daysAgo(30))).toBe(true);
    expect(full(daysAgo(200))).toBe(true);
  });

  it("renews a browser whose cookie carries no day (the value before this rule), or a day still to come", () => {
    expect(full(null)).toBe(true);
    expect(full("2026-11-30")).toBe(true);
  });

  it("never renews a sign-in by name, or a browser signed in as nobody", () => {
    for (const renewedOn of [null, daysAgo(30), daysAgo(400)]) {
      expect(renewDue({ signedIn: true, byName: true, renewedOn, today }), String(renewedOn)).toBe(false);
      expect(renewDue({ signedIn: false, byName: false, renewedOn, today }), String(renewedOn)).toBe(false);
    }
  });
});

describe("a sign-in by name ends a year after it began", () => {
  it("is over at its end, and not before", () => {
    const now = NOW.getTime();
    expect(byNameOver(now + 1, now)).toBe(false);
    expect(byNameOver(now, now)).toBe(true);
    expect(byNameOver(now - 1, now)).toBe(true);
    // A seal with no end (made before 28 October 2026) keeps the rule it had.
    expect(byNameOver(0, now)).toBe(false);
  });
});

describe("a credential from before the browser's last sign-out opens nothing", () => {
  it("refuses what came before the sign-out, and takes what came after it", () => {
    const out = NOW.getTime();
    expect(predatesSignOut(0, out)).toBe(true);
    expect(predatesSignOut(out - 1, out)).toBe(true);
    expect(predatesSignOut(out, out)).toBe(false);
    expect(predatesSignOut(out + 5_000, out)).toBe(false);
  });

  it("takes everything in a browser that never signed out, or that lost the mark with its cookies", () => {
    expect(predatesSignOut(0, 0)).toBe(false);
    expect(predatesSignOut(NOW.getTime(), 0)).toBe(false);
  });
});

describe("a session by name may not delete the account", () => {
  const record = { emailVerifiedAt: null, telegramId: null, discordId: null, lineId: null, phone: null };

  it("refuses a session by name whose record proves nothing", () => {
    expect(deletionRefusal(true, record)).toBe("proof_required");
  });

  it("lets a full session delete, and a session by name once its record proved itself", () => {
    expect(deletionRefusal(false, record)).toBeNull();
    expect(deletionRefusal(true, { ...record, emailVerifiedAt: NOW })).toBeNull();
    expect(deletionRefusal(true, { ...record, telegramId: 7 as never })).toBeNull();
    expect(deletionRefusal(false, null)).toBeNull();
  });
});
