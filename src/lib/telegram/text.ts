import { isValidShareCode } from "@/lib/codes";
import { baseUrl } from "@/lib/config";
import { MAX_SETS, type SetScore } from "@/lib/domain/scores";

/** Reading a message: a command and its words, the codes in a pasted link, a score. No database. */

/**
 * "6-3 6-4", "6:3, 6:4". It reads one set more than `MAX_SETS`, so a sixth set reaches the handler and
 * is refused there ("Up to 5 sets"). Cutting at five saved the first five without a word, which is how
 * a fourth set used to vanish (the owner's note 25d412f7).
 */
export function parseSets(text: string): SetScore[] {
  const out: SetScore[] = [];
  for (const m of text.matchAll(/(?<!\d)(\d{1,2})\s*[-:]\s*(\d{1,2})(?!\d)/g)) {
    if (out.length > MAX_SETS) break;
    out.push({ setNumber: out.length + 1, sideA: Number(m[1]), sideB: Number(m[2]) });
  }
  return out;
}

/**
 * A message that is a score and nothing else: "6-4 6-3", "6:4, 3:6, 7-5". The score reader and the word reader both ask this one.
 * Any number of sets: six or more reach `scoreFromChat`, which refuses them in words, rather than falling through as if the
 * message were not a score at all.
 */
export const SETS_ONLY_RE = /^\s*\d{1,2}\s*[-:]\s*\d{1,2}(?:[\s,;/]+\d{1,2}\s*[-:]\s*\d{1,2})*\s*$/;

export
const CODE_RE = /(?:^|\/|\s)([A-Za-z0-9]{4})(?=$|[\s/?#])/;
const LINK_RE = /https?:\/\/[^\s/]+\/([A-Za-z0-9]{4})(?=$|[\s/?#])/g;

export
function parseCommand(text: string | undefined): { command: string; args: string } | null {
  if (!text || !text.startsWith("/")) return null;
  const [head, ...rest] = text.trim().split(/\s+/);
  const command = head.slice(1).split("@")[0].toLowerCase();
  return { command, args: rest.join(" ") };
}

/** Codes of kicksma.sh links in a message (own host or the short domain). */
export function codesInText(text: string | undefined, base = baseUrl()): string[] {
  if (!text) return [];
  const host = new URL(base).host;
  const out: string[] = [];
  for (const m of text.matchAll(LINK_RE)) {
    const linkHost = m[0].split("/")[2];
    if ((linkHost === host || linkHost === "kicksma.sh") && isValidShareCode(m[1])) out.push(m[1]);
  }
  return [...new Set(out)];
}
