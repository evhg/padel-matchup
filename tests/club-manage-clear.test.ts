import { beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { getDb, type Db } from "@/db";
import { clubs } from "@/db/schema";
import { updateClubAction } from "@/actions/clubs";
import { clubFormPayload, type ClubFormValues } from "@/components/ClubManageForm";
import { asAction } from "./helpers/action";
import { freezeClock } from "./helpers/clock";

/**
 * The club's manage page, Save with a field emptied (button audit, 9 November 2026, finding F1). The
 * form sent `v.website || undefined`, and React's reply decoder deletes a key whose value is undefined,
 * so `cleanClubInput` never saw the key and the old link stayed: the screen said "Saved", and the public
 * "Book on …" button still opened the wrong link. Each test sends what the browser sends: the form's
 * payload through JSON, which drops an `undefined` key exactly as the decoder does.
 *
 * NOW is Monday 9 November 2026, 10:00 UTC.
 */
const NOW = new Date(Date.UTC(2026, 10, 9, 10, 0));
freezeClock(NOW);

/** What the browser hands the server action: undefined keys gone, the rest as sent. */
const overTheWire = <T,>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

const EMPTY: ClubFormValues = { website: "", bookingUrl: "", mapUrl: "", courts: "", courtsIndoor: "", courtsOutdoor: "", about: "", place: "", country: "", opensAt: "", closesAt: "", availabilityUrl: "", availabilityKind: "" };

describe("the club's manage form clears an emptied field", () => {
  let app: Db;
  beforeAll(async () => {
    app = await getDb();
  });
  let n = 0;
  /** A club with every field the form shows filled in, and its own manage token. */
  const seed = async () => {
    const id = `clear-${++n}-${NOW.getTime()}`;
    await app.insert(clubs).values({
      slug: `manage-${id}`,
      name: `Manage ${id}`,
      source: "claim",
      manageToken: `tok-${id}`,
      website: "https://wrong.example",
      bookingUrl: "https://www.matchi.se/facilities/wrong",
      mapUrl: "https://maps.example/wrong",
      courts: 4,
      courtsIndoor: 2,
      courtsOutdoor: 2,
      about: "Old words",
      province: "Phuket",
      city: "phuket",
      country: "TH",
      opensAt: "07:00",
      closesAt: "23:00",
      availabilityUrl: "https://wrong.example/free.ics",
      availabilityKind: "ics_bookings",
      tz: "Asia/Bangkok",
      createdAt: NOW,
      claimedAt: NOW,
    });
    return `tok-${id}`;
  };
  const row = async (token: string) => (await app.select().from(clubs).where(eq(clubs.manageToken, token)).limit(1))[0]!;

  it("Save with every field emptied clears each of them, the booking link and the feed too", async () => {
    const token = await seed();
    const { result } = await asAction({}, () => updateClubAction(token, overTheWire(clubFormPayload(EMPTY, true))));
    expect(result.ok).toBe(true);
    expect(await row(token)).toMatchObject({
      website: null,
      bookingUrl: null,
      bookingPlatform: null,
      mapUrl: null,
      courts: null,
      courtsIndoor: null,
      courtsOutdoor: null,
      about: null,
      province: null,
      city: null,
      country: null,
      opensAt: null,
      closesAt: null,
      availabilityUrl: null,
      availabilityKind: null,
    });
  });

  it("a closed feed section keeps the feed, and an emptied booking link still goes", async () => {
    const token = await seed();
    const kept = { ...EMPTY, website: "https://right.example", place: "Phuket", country: "TH", courts: "4" };
    // The kept feed is read again after the save: that read answers here, never on the network.
    const asked: string[] = [];
    vi.stubGlobal("fetch", async (u: string) => (asked.push(String(u)), new Response("BEGIN:VCALENDAR\nEND:VCALENDAR", { status: 200 })));
    try {
      const { result } = await asAction({}, () => updateClubAction(token, overTheWire(clubFormPayload(kept, false))));
      expect(result.ok).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
    expect(asked).toEqual(["https://wrong.example/free.ics"]);
    expect(await row(token)).toMatchObject({ website: "https://right.example/", bookingUrl: null, country: "TH", courts: 4, availabilityUrl: "https://wrong.example/free.ics", availabilityKind: "ics_bookings" });
  });
});
