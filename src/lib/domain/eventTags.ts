/**
 * Who a match is for: a category (men, women, mixed) and an age (35+, 45+, 55+).
 *
 * The owner decided on 9 October 2026 (decision G1). The tag goes on the event, never on the
 * player: Kicksmash stores no gender and no age about a person, and nothing is checked when somebody
 * joins. A "Women · 45+" match is open to the link like any other; the tag is information that helps
 * the right players find the game, the way a title would. Filters on a listing come later.
 *
 * Both are optional and independent ("Women", "35+", "Mixed · 45+"). The columns are
 * `events.category`/`age_min`, and the same pair on `series` and `club_slots`, so a ladies' night
 * keeps its tag on every edition and a club's weekly "Ladies social" on every match it makes.
 *
 * Pure, and a leaf: the create form imports it, so it must not reach the database.
 */

export const EVENT_CATEGORIES = ["men", "women", "mixed"] as const;
export type EventCategory = (typeof EVENT_CATEGORIES)[number];

/** The youngest age a tag names. Three taps, never a typed number. */
export const AGE_MINS = [35, 45, 55] as const;
export type AgeMin = (typeof AGE_MINS)[number];

/** The tag as a row carries it; either half may be missing. */
export type EventTag = { category?: unknown; ageMin?: unknown };

/**
 * A category from a form, a request or a row: one of the three, read as a person writes it ("Women",
 * " mixed "); anything else is null. Never throws: a tag nobody understood is no tag, not an error.
 */
export function cleanCategory(v: unknown): EventCategory | null {
  if (typeof v !== "string") return null;
  const s = v.trim().toLowerCase();
  return (EVENT_CATEGORIES as readonly string[]).includes(s) ? (s as EventCategory) : null;
}

/**
 * An age from a form, a request or a row: 35, 45 or 55, as a number or its digits; anything else is
 * null. Never rounded to the nearest of the three: 40 is not 35+ or 45+, it is nothing.
 */
export function cleanAgeMin(v: unknown): AgeMin | null {
  const n = typeof v === "number" ? v : typeof v === "string" && /^\s*\d{2}\s*$/.test(v) ? Number(v) : NaN;
  return (AGE_MINS as readonly number[]).includes(n) ? (n as AgeMin) : null;
}

/** The message key each category reads as. */
export const CATEGORY_KEYS = { men: "level.tagMen", women: "level.tagWomen", mixed: "level.tagMixed" } as const satisfies Record<EventCategory, string>;

export type TagPart = { key: (typeof CATEGORY_KEYS)[EventCategory]; values?: undefined } | { key: "level.tagAge"; values: { age: AgeMin } };

/**
 * The message keys of the tag's chip, in the order it reads: the category, then the age. Every screen
 * and every channel builds its "Mixed · 45+" from this, so they cannot say it two ways. Empty for an
 * event open to anyone, and for a row holding something the rule does not know.
 */
export function tagParts(tag: EventTag | null | undefined): TagPart[] {
  const category = cleanCategory(tag?.category);
  const age = cleanAgeMin(tag?.ageMin);
  const parts: TagPart[] = [];
  if (category) parts.push({ key: CATEGORY_KEYS[category] });
  if (age) parts.push({ key: "level.tagAge", values: { age } });
  return parts;
}

export const hasTag = (tag: EventTag | null | undefined): boolean => tagParts(tag).length > 0;
