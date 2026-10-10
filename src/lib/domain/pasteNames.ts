import { nameIsHere, normalName } from "./dupes";

/**
 * "Paste the names from the group": the organiser copies the replies from the crew's WhatsApp group
 * and each name becomes a reserved spot, so a player who said "in" there never has to leave it (the
 * owner, 10 October 2026: "you have to leave the chat group"). No API can read a WhatsApp group, so a
 * person carries the names across once; `reserveAction` holds each spot, with its own rate limit.
 *
 * Chat is free text, and a reader of free text refuses what it does not recognise rather than keeping
 * whatever is left (the crew group's lesson: "who's in for beers at 8?" once made a match at "for
 * beers"). So a piece of a line is a name only when, with its list marker, its "+1" and its emoji
 * taken off, what is left is one to three words of letters, and none of them is a word people write in
 * a chat ("in", "maybe", "can't", "буду", "не", "voy", "puedo"…). Everything else is dropped, and the
 * organiser sees the names before anything is held. What it reads:
 *
 *   - one name per line, with or without "1.", "1)", "-", "•", an emoji or "+1" around it;
 *   - a numbered list on one line ("1. Ana 2. Bo 3. Cy") and a list with commas ("Ana, Bo, Cy");
 *   - copied messages ("[10/10/26, 18:02] Ana: +1", "10/10/26, 18:02 - Ana: in"): the sender, when
 *     the message says yes; the names in it, when it is a list.
 *
 * Pure. At most `PASTE_NAMES_MAX` names, the first spelling of each.
 */
export const PASTE_NAMES_MAX = 24;

/** Words a chat line is made of and a name is not, in English, Russian and Spanish. A piece with any of them is not a name. */
const CHAT_WORDS = new Set(
  [
    // en
    "in", "out", "me", "i", "i'm", "im", "yes", "yep", "yeah", "no", "nope", "maybe", "ok", "okay", "sure", "cant", "can't", "cannot", "sorry", "who", "who's",
    "whos", "what", "when", "where", "why", "how", "the", "a", "an", "and", "or", "for", "at", "to", "of", "on", "is", "are", "am", "be", "we", "you", "us",
    "play", "playing", "game", "games", "match", "court", "courts", "tonight", "today", "tomorrow", "count", "plus", "also", "too", "please", "thanks",
    "thank", "hi", "hey", "hello", "all", "anyone", "someone", "more", "one", "two", "spot", "spots", "free", "full", "booked", "book", "here", "there", "late",
    "make", "it", "not", "will", "won't", "dont", "don't", "out.", "if",
    // ru
    "я", "мы", "ты", "вы", "он", "она", "они", "кто", "что", "где", "когда", "да", "нет", "не", "может", "буду", "будем", "смогу", "могу", "играю", "играем",
    "иду", "идём", "идем", "тоже", "плюс", "ещё", "еще", "все", "всем", "привет", "спасибо", "сегодня", "завтра", "в", "на", "и", "или", "корт", "игра",
    "матч", "место", "мест", "минус", "пас",
    // es
    "yo", "tú", "tu", "sí", "si", "quizás", "quizas", "voy", "vamos", "juego", "jugar", "jugamos", "puedo", "también", "tambien", "hoy", "mañana", "manana",
    "quién", "quien", "qué", "que", "el", "la", "los", "las", "de", "del", "y", "o", "para", "en", "con", "por", "hola", "gracias", "pista", "partido",
    "plaza", "plazas", "alguien", "todos", "más", "mas", "apunto", "apúntame", "apuntame", "dentro", "fuera",
  ],
);

/** What a copied message says when it means "I'm in": the sender is the name. */
const YES = new Set(["+", "+1", "in", "i'm in", "im in", "me", "me too", "yes", "count me in", "я", "я в деле", "буду", "иду", "в деле", "yo", "voy", "me apunto", "apúntame", "apuntame", "dentro"]);
/** The emoji people answer "in" with, kept apart because every emoji is taken off a name. */
const YES_EMOJI = /[✅👍🙋🙌💪🎾✋☝]/u;

const EMOJI = /[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{1F3FB}-\u{1F3FF}‍️⃣]/gu;
const NAME = /^[\p{L}][\p{L}\p{M}'’.-]*(?: [\p{L}][\p{L}\p{M}'’.-]*){0,2}$/u;
/** "[10/10/26, 18:02:11] Ana: +1" (a phone's copy) and "10/10/26, 18:02 - Ana: in" (an export). */
const COPIED = [/^\s*\[[^\]]{4,40}\]\s*([^:]{1,40}):\s*(.*)$/u, /^\s*\d{1,4}[./-]\d{1,2}[./-]\d{1,4},?\s+\d{1,2}[:.]\d{2}(?:[:.]\d{2})?(?:\s*[aApP]\.?\s?[mM]\.?)?\s+[-–]\s+([^:]{1,40}):\s*(.*)$/u];

/** One piece, cleaned to a name or refused. */
function asName(piece: string): string | null {
  const s = piece
    .replace(EMOJI, " ")
    .replace(/^\s*(?:[-–—•*·>]+|\d{1,2}[.)])\s*/u, "")
    .replace(/(^|\s)\+\s?1?(?=\s|$)/gu, " ")
    .replace(/\+1$/u, "")
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/[.,!;:]+$/u, "")
    .trim();
  if (s.length < 2 || s.length > 40 || !NAME.test(s)) return null;
  if (s.split(" ").some((w) => CHAT_WORDS.has(w.toLowerCase()))) return null;
  return s;
}

/** A line's pieces: a numbered list on one line, a list with commas, or the line itself. */
const piecesOf = (line: string): string[] => line.split(/(?:^|\s)\d{1,2}[.)]\s+|[,;]/u).filter((p) => p.trim());

const saysYes = (message: string): boolean => {
  const plain = message.replace(EMOJI, " ").replace(/\s+/gu, " ").trim().toLowerCase().replace(/[.!]+$/u, "");
  return YES.has(plain) || (plain === "" && YES_EMOJI.test(message));
};

export function namesFromChat(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const keep = (name: string | null) => {
    if (!name || out.length >= PASTE_NAMES_MAX) return;
    const key = normalName(name);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(name);
  };
  for (const raw of text.replace(/\r/g, "").replace(/ /g, " ").split("\n")) {
    const copied = COPIED.map((re) => re.exec(raw)).find(Boolean);
    if (copied) {
      if (saysYes(copied[2])) keep(asName(copied[1]));
      else for (const p of piecesOf(copied[2])) keep(asName(p));
      continue;
    }
    for (const p of piecesOf(raw)) keep(asName(p));
  }
  return out;
}

/** What the box will do with the names: hold a spot for each while spots last, skip a name already in the match, and say who found no spot. Pure. */
export function planPaste(names: readonly string[], namesHere: readonly string[], spots: number): { hold: string[]; already: string[]; noSpot: string[] } {
  const already = names.filter((n) => nameIsHere(n, namesHere));
  const fresh = names.filter((n) => !nameIsHere(n, namesHere));
  const room = Math.max(0, spots);
  return { hold: fresh.slice(0, room), already, noSpot: fresh.slice(room) };
}
