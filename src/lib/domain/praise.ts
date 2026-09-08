import { fnv1a } from "@/lib/hash";

/**
 * One line for the winners, chosen by the match code so every channel says the same
 * thing and nobody hears the same line twice in a row. Written per language, never
 * translated word for word: each pool sounds like someone courtside in that language.
 */

const POOLS: Record<"en" | "ru" | "es", ((w: string) => string)[]> = {
  en: [
    (w) => `${w}: bandeja, víbora, done. See you at the net.`,
    (w) => `Clean win, ${w}. The glass never had a chance.`,
    (w) => `${w} took it. Lobs landed, nerves held.`,
    (w) => `That one belongs to ${w}. The rest of us take notes.`,
    (w) => `${w} closed it out. Somebody buy the next round of balls.`,
    (w) => `Match to ${w}. Losers pick the court next time.`,
    (w) => `${w}, well played: patience at the back, fire at the net.`,
    (w) => `${w} win. Rematch is the only correct response.`,
  ],
  ru: [
    (w) => `${w}: бандеха, вибора, готово. Увидимся у сетки.`,
    (w) => `Чистая победа, ${w}. У стекла не было шансов.`,
    (w) => `${w} забрали матч. Свечи легли, нервы выдержали.`,
    (w) => `Этот матч за ${w}. Остальные конспектируют.`,
    (w) => `${w} довели до конца. С проигравших новые мячи.`,
    (w) => `Победа ${w}. Проигравшие выбирают корт в следующий раз.`,
    (w) => `${w}, красиво: терпение сзади, огонь у сетки.`,
    (w) => `${w} выиграли. Единственный правильный ответ: реванш.`,
  ],
  es: [
    (w) => `${w}: bandeja, víbora, listo. Nos vemos en la red.`,
    (w) => `Victoria limpia, ${w}. El cristal no tuvo opción.`,
    (w) => `${w} se lo llevan. Los globos cayeron, los nervios aguantaron.`,
    (w) => `Ese partido es de ${w}. El resto tomamos apuntes.`,
    (w) => `${w} lo cerraron. Los que pierden traen las bolas nuevas.`,
    (w) => `Partido para ${w}. Los perdedores eligen pista la próxima.`,
    (w) => `${w}, bien jugado: paciencia atrás, fuego en la red.`,
    (w) => `${w} ganan. La única respuesta correcta: revancha.`,
  ],
};

export const praiseLocale = (l: string | null | undefined): "en" | "ru" | "es" => (l?.toLowerCase().startsWith("ru") ? "ru" : l?.toLowerCase().startsWith("es") ? "es" : "en");

/** The praise line for a match: same seed, same line, in the reader's language. */
export function praiseLine(locale: string | null | undefined, seed: string, winners: string): string {
  const pool = POOLS[praiseLocale(locale)];
  return pool[parseInt(fnv1a(seed), 16) % pool.length](winners);
}
