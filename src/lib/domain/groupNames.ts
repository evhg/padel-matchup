import { fnv1a } from "@/lib/hash";

/**
 * Default group names: a crew deserves better than the name of a car park.
 * Each language has its own jokes, written for it rather than translated.
 * The pick is stable per match (seeded by its code) and the dice rolls onward.
 */
export const GROUP_NAMES: Record<"en" | "ru" | "es", string[]> = {
  en: [
    "Padel to the Metal",
    "Wall Bouncers",
    "Smash and Giggles",
    "Court Jesters",
    "The Double Faults",
    "Glass Half Full",
    "Bandeja Brigade",
    "Net Profits",
    "Lob Squad",
    "Chiquita Banana",
    "The Víbora Vipers",
    "Out of Bounce",
  ],
  ru: [
    "Падел до упаду",
    "Смэш-бригада",
    "Шуты с корта",
    "Двойные ошибки",
    "Стекло и точка",
    "Свечи зажигают",
    "Бандеха с маслом",
    "Сетка-барсетка",
    "Тай-брейк на завтрак",
    "Ещё один сет",
    "Аут, но с душой",
    "Отскочившие",
  ],
  es: [
    "A Todo Pádel",
    "Remate y Risas",
    "Los Bufones de la Pista",
    "Dobles Faltas",
    "Globo Sonda",
    "Bandeja Paisa",
    "La Víbora Que Muerde",
    "Chiquita Pero Matona",
    "Salida de Pared",
    "Un Set Más",
    "Los del Fondo",
    "Rebote y Vino",
  ],
};

const poolFor = (locale: string) => GROUP_NAMES[locale === "ru" || locale === "es" ? locale : "en"];

/** The n-th name for this seed: n = 0 is the suggestion, each roll of the dice is the next. */
export function suggestGroupName(locale: string, seed: string, roll = 0): string {
  const pool = poolFor(locale);
  return pool[(parseInt(fnv1a(seed), 16) + roll) % pool.length];
}

/** A handful of names to cycle through in the UI, starting from the suggestion. */
export function groupNameSuggestions(locale: string, seed: string, count = 6): string[] {
  return Array.from({ length: Math.min(count, poolFor(locale).length) }, (_, i) => suggestGroupName(locale, seed, i));
}
