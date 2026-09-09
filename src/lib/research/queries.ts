import type { ResearchRun } from "@/db/schema";
import type { TimeRange } from "./tavily";

/**
 * What the desk searches for. Listening queries find fresh threads where a reply
 * would help (they feed the listening desk and the owner's tap). Find queries map
 * the clubs, coaches, tournaments and communities of the cities we care about.
 */
export type Lang = "en" | "ru" | "es";
export type FindKind = "club" | "coach" | "tournament" | "community";
export type Query = { key: string; q: string; lang: Lang; kind: "listen" | "find"; find?: FindKind; city?: string; everyHours: number; timeRange?: TimeRange; country?: string };

const listen = (lang: Lang, slug: string, q: string): Query => ({ key: `listen:${lang}:${slug}`, q, lang, kind: "listen", everyHours: 24, timeRange: "week" });
const find = (city: string, kind: FindKind, q: string): Query => ({ key: `find:${city.toLowerCase().replace(/\s+/g, "-")}:${kind}`, q, lang: "en", kind: "find", find: kind, city, everyHours: 240 });

export const LISTEN_QUERIES: readonly Query[] = [
  listen("en", "app-organise", "app to organise padel matches with friends"),
  listen("en", "americano-how", "how to organise an americano padel tournament"),
  listen("en", "mexicano-8", "padel mexicano format 8 players 2 courts"),
  listen("en", "level-35", "padel level 3.5 what does it mean"),
  listen("en", "find-players", "find padel players near me app"),
  listen("en", "whatsapp-group", "padel whatsapp group organising games"),
  listen("en", "league-app", "padel league app for a small group of friends"),
  listen("en", "phuket", "padel Phuket where to play join a game"),
  listen("en", "singapore", "padel Singapore social games join"),
  listen("en", "coach-booking", "padel coach booking lessons packages app"),
  listen("en", "king-court", "king of the court padel format rules"),
  listen("en", "matchmaking", "best padel matchmaking app"),
  listen("ru", "prilozhenie", "приложение для организации игры в падел"),
  listen("ru", "amerikano", "как организовать американо по паделу"),
  listen("ru", "phuket", "падел Пхукет где поиграть"),
  listen("ru", "uroven", "уровень игры в падел 3.5 что значит"),
  listen("ru", "partnery", "найти партнёров для игры в падел"),
  listen("ru", "meksikano", "падел мексикано формат"),
  listen("ru", "turnir", "как провести турнир по паделу"),
  listen("ru", "chat", "падел чат whatsapp telegram организация игр"),
  listen("ru", "bangkok", "падел Бангкок где поиграть"),
  listen("ru", "trener", "падел тренер записаться на урок"),
  listen("es", "app-organizar", "app para organizar partidos de pádel con amigos"),
  listen("es", "americano", "cómo organizar un americano de pádel"),
  listen("es", "mexicano", "formato mexicano pádel 8 jugadores"),
  listen("es", "nivel", "nivel 3.5 pádel qué significa"),
  listen("es", "jugadores", "encontrar jugadores de pádel cerca app"),
  listen("es", "whatsapp", "grupo whatsapp pádel organizar partidos"),
  listen("es", "torneo-app", "app torneo pádel gratis"),
  listen("es", "rey-pista", "rey de la pista pádel formato"),
];

export const CITIES = ["Phuket", "Bangkok", "Pattaya", "Koh Samui", "Hua Hin", "Chiang Mai", "Singapore", "Kuala Lumpur", "Bali", "Ho Chi Minh City"] as const;

export const FIND_QUERIES: readonly Query[] = [
  ...CITIES.flatMap((c) => [find(c, "club", `padel club ${c} courts booking contact`), find(c, "coach", `padel coach ${c} lessons`), find(c, "tournament", `padel tournament ${c} 2026 americano open`)]),
  ...["Phuket", "Singapore", "Bangkok"].map((c) => find(c, "community", `padel ${c} community group telegram whatsapp facebook`)),
];

export const QUERIES: readonly Query[] = [...LISTEN_QUERIES, ...FIND_QUERIES];

/** A query that keeps finding nothing new waits longer: two, three, four times its interval, no more. */
export const intervalHours = (q: Query, run?: Pick<ResearchRun, "emptyStreak"> | null) => q.everyHours * (1 + Math.min(3, run?.emptyStreak ?? 0));

/** Due queries, most overdue first; never-run ones lead. */
export function dueQueries(now: Date, runs: ResearchRun[], queries: readonly Query[] = QUERIES): Query[] {
  const byKey = new Map(runs.map((r) => [r.key, r]));
  return queries
    .map((q) => {
      const r = byKey.get(q.key);
      const overdue = r ? (now.getTime() - r.lastRunAt.getTime()) / (intervalHours(q, r) * 3_600_000) : Number.POSITIVE_INFINITY;
      return { q, overdue };
    })
    .filter((x) => x.overdue >= 1)
    .sort((a, b) => b.overdue - a.overdue || a.q.key.localeCompare(b.q.key))
    .map((x) => x.q);
}
