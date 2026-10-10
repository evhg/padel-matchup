import { SETS_ONLY_RE } from "./text";

/**
 * What a line typed in a crew's chat means: a seat taken ("in", "+1", "я в деле", "me apunto"), a seat
 * given back ("out", "can't make it", "не смогу", "no puedo"), a score (left to the score reader, which
 * owns it), or a new match ("who's in Thursday 7pm Rawai?"). Anything else is null. Pure: no database,
 * no clock.
 *
 * The whole message is the word, never a part of it. "I'm in" takes a seat and "I'm in traffic" does
 * not; "+1" does and "+1 to that idea" does not. A join read out of ordinary chat is a seat taken in
 * somebody's name, which is worse than a word missed, so a phrase joins these lists only together
 * with the sentences it must not swallow (`tests/telegram-words.test.ts`). Phrases that read both
 * ways in a crew's chat stay out on purpose: "me too" and "я тоже" follow an "I'm in" as often as a
 * "can't make it", and "yo" is a greeting in English. A question is never a seat: "in?" asks, it
 * does not answer.
 */
export type Word = { kind: "join"; onlyAsReply: boolean } | { kind: "leave" } | { kind: "score" } | { kind: "ask"; text: string };

const JOIN = [
  // en
  "in", "i'm in", "im in", "i am in", "+1", "count me in", "i'm in too", "im in too",
  // ru
  "я в деле", "в деле", "я иду", "я играю",
  // es
  "me apunto", "me apunto yo", "apúntame", "apuntame", "cuenta conmigo", "dentro",
];

/**
 * Words that answer any "who …?" ("me", "я", "буду", "voy") and a bare "+", which in a Russian chat
 * agrees to anything: a seat only as a reply to the match's own card, never as a plain line in the
 * crew's chat, where the question they answer may be about dinner.
 */
const JOIN_AS_REPLY = ["me", "+", "я", "буду", "я буду", "voy", "yo voy"];

const LEAVE = [
  // en
  "out", "i'm out", "im out", "i am out", "-1", "can't make it", "cant make it", "cannot make it", "can not make it", "i can't make it", "i cant make it", "i cannot make it", "count me out", "i'm out today", "can't make it today",
  // ru
  "не смогу", "я не смогу", "минус", "не могу", "я не могу", "пас", "я пас",
  // es
  "no puedo", "yo no puedo", "me bajo", "no voy", "yo no voy", "no podré", "no podre", "bájame", "bajame", "me borro",
];

/** A word of courtesy around a phrase does not change it: "can't make it, sorry", "ребят, не смогу". */
const COURTESY = ["sorry", "sry", "guys", "folks", "сорри", "извините", "простите", "ребят", "ребята", "lo siento", "perdón", "perdon", "chicos", "gente"];

const JOIN_SET = new Set(JOIN);
const JOIN_AS_REPLY_SET = new Set(JOIN_AS_REPLY);
const LEAVE_SET = new Set(LEAVE);

/**
 * "who's in Thursday 7pm Rawai?" and its sisters: a question that asks for players at a time. The parser
 * for /new reads the same prefix (`parse.ts`), so the ask and the match it makes cannot disagree. Only
 * the question is read: what follows its first "?" is somebody talking, and is dropped unread.
 */
export const ASK_PREFIX = "who'?s in|who is in|who'?s up for|who wants to play|anyone (?:up )?for|anybody (?:up )?for|кто (?:в деле|играет|идёт|идет|хочет играть|хочет|со мной|на)|quién (?:juega|se apunta|viene|está|esta)|quien (?:juega|se apunta|viene|está|esta)|alguien (?:para|juega)";
const ASK_RE = new RegExp(`^(?:${ASK_PREFIX})(?![\\p{L}\\d])(.*)$`, "iu");

/** A message longer than this is somebody talking, not a word. */
const MAX_CHARS = 200;

/** Lower case, one kind of apostrophe and minus, no emoji, no punctuation but + and -. */
export function normalizeWords(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’ʼ`´]/g, "'")
    .replace(/[−–—]/g, "-")
    .replace(/ё/g, "е")
    .replace(/[\p{Extended_Pictographic}\u{1F3FB}-\u{1F3FF}‍️]/gu, " ")
    .replace(/[.,!?¡¿;:…"«»“”()[\]]/g, " ")
    .replace(/([+-])\s+(?=\d)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/** The phrase with one courtesy word (or two) taken off either end. */
function bare(line: string): string {
  let out = line;
  for (let i = 0; i < 2; i++) {
    for (const c of COURTESY) {
      if (out.startsWith(`${c} `)) out = out.slice(c.length + 1);
      if (out.endsWith(` ${c}`)) out = out.slice(0, -c.length - 1);
    }
  }
  return out.trim();
}

/** What a message means, or null. */
export function readWords(text: string | null | undefined): Word | null {
  if (!text || text.length > MAX_CHARS) return null;
  if (SETS_ONLY_RE.test(text)) return { kind: "score" };
  const line = normalizeWords(text);
  if (!line) return null;
  const question = text.split("?")[0].trim();
  const ask = ASK_RE.exec(normalizeWords(question));
  // A time, or at least an hour, is what makes a question into a match; "who's in?" is about the card.
  if (ask) return /\d/.test(ask[1]) ? { kind: "ask", text: question } : null;
  // "in?" asks whether somebody is in; it takes nobody's seat.
  if (/[?¿]/.test(text)) return null;
  const phrase = bare(line);
  if (JOIN_SET.has(phrase)) return { kind: "join", onlyAsReply: false };
  if (JOIN_AS_REPLY_SET.has(phrase)) return { kind: "join", onlyAsReply: true };
  if (LEAVE_SET.has(phrase)) return { kind: "leave" };
  return null;
}
