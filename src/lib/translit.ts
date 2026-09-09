/** Cyrillic to Latin, the way names are usually written on a passport. Everything else passes through. */
const CYRILLIC: Record<string, string> = { а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i", й: "y", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "kh", ц: "ts", ч: "ch", ш: "sh", щ: "sch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya" };

export function transliterate(s: string): string {
  let out = "";
  for (const ch of (s ?? "").toLowerCase()) out += CYRILLIC[ch] ?? ch;
  return out;
}

/** A URL slug from any name: transliterated, lowercase, dashes, at most `max` characters; empty when nothing survives. */
export function slugFrom(name: string, max = 60): string {
  return transliterate(name)
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, max)
    .replace(/-+$/g, "");
}
