import { tagParts } from "@/lib/domain/eventTags";
import { formatRange, hasRange, presetFor, type LevelRange } from "@/lib/domain/levels";

/** Any next-intl translator (server or client); keys are checked at the call sites' message types. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type T = (key: any, values?: any) => string;

/** "3.0–4.5", "4.5+", "up to 2.5" in the viewer's language. */
export function rangeText(t: T, r: LevelRange): string {
  return formatRange(r, {
    between: (min, max) => t("level.between", { min, max }),
    plus: (min) => t("level.plus", { min }),
    upTo: (max) => t("level.upTo", { max }),
  });
}

/** "Gold · 3.0–4.5" or "Level 2.0–3.0"; null for open events. */
export function rangeChip(t: T, r: LevelRange | null | undefined): string | null {
  if (!hasRange(r)) return null;
  const preset = presetFor(r);
  const range = rangeText(t, r);
  return preset && preset !== "custom" ? t("level.chip", { preset: t(`level.${preset}`), range }) : t("level.chipCustom", { range });
}

/**
 * "Women", "Mixed · 45+", "35+": who the event is for, in the viewer's language, from the same parts
 * every channel reads (`tagParts`). Null for an event open to anyone. Shown beside the level chip,
 * never instead of it: a tag is information, and nobody is checked against it. It asks for both
 * fields by type, so a read that selected a row without them fails the typecheck rather than
 * showing no chip.
 */
export function tagChip(t: T, tag: { category: string | null; ageMin: number | null } | null | undefined): string | null {
  const parts = tagParts(tag);
  return parts.length ? parts.map((p) => t(p.key, p.values)).join(" · ") : null;
}
