/**
 * Cities with a page of their own (/phuket, /singapore). A venue belongs to a
 * city when its events use the city's time zone and, where the zone covers a
 * whole country, the venue slug mentions the city or one of its areas. Clubs
 * that don't match can be added to `venueSlugs` with a pull request.
 */
export type City = {
  slug: string;
  name: string;
  tz: string;
  /** Slug fragments that place a venue in the city (areas, districts, the city itself). Empty = the time zone is enough. */
  needles: readonly string[];
  /** Curated venue slugs that belong to the city even without a matching fragment. */
  venueSlugs: readonly string[];
};

export const CITIES: readonly City[] = [
  {
    slug: "phuket",
    name: "Phuket",
    tz: "Asia/Bangkok",
    needles: ["phuket", "patong", "rawai", "kata", "karon", "chalong", "bangtao", "bang-tao", "cherngtalay", "cherng-talay", "laguna", "kamala", "thalang", "nai-harn", "naiharn", "surin", "kathu", "boat-avenue", "layan", "mai-khao", "cape-panwa", "panwa"],
    venueSlugs: [],
  },
  {
    slug: "singapore",
    name: "Singapore",
    tz: "Asia/Singapore",
    needles: [],
    venueSlugs: [],
  },
];

export const cityBySlug = (slug: string): City | null => CITIES.find((c) => c.slug === slug) ?? null;

/** Does this venue slug (used with this time zone) sit in the city? */
export function venueInCity(city: City, venueSlug: string | null | undefined, tz: string): boolean {
  if (!venueSlug || tz !== city.tz) return false;
  if (city.venueSlugs.includes(venueSlug)) return true;
  if (city.needles.length === 0) return true;
  return city.needles.some((n) => venueSlug.includes(n));
}

/** The city an event sits in, by its zone and venue, or null. */
export const cityOf = (tz: string, venueSlug: string | null | undefined): City | null => CITIES.find((c) => c.tz === tz && (venueSlug ? venueInCity(c, venueSlug, tz) : c.needles.length === 0)) ?? null;

/** A city named in free text, in either alphabet, or null. */
export function cityInText(text: string): City | null {
  const lower = text.toLowerCase();
  const aliases: Record<string, string> = { пхукет: "phuket", сингапур: "singapore" };
  for (const c of CITIES) if (lower.includes(c.name.toLowerCase()) || lower.includes(c.slug)) return c;
  for (const [ru, slug] of Object.entries(aliases)) if (lower.includes(ru)) return cityBySlug(slug);
  return null;
}

