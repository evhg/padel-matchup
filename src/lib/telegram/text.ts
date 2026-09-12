import { isValidShareCode } from "@/lib/codes";
import { baseUrl } from "@/lib/config";
import type { SetScore } from "@/lib/domain/scores";

/** Reading a message: a command and its words, the codes in a pasted link, a score. No database. */

/** "6-3 6-4", "6:3, 6:4": up to three sets. */
export function parseSets(text: string): SetScore[] {
  const out: SetScore[] = [];
  for (const m of text.matchAll(/(?<!\d)(\d{1,2})\s*[-:]\s*(\d{1,2})(?!\d)/g)) {
    if (out.length === 3) break;
    out.push({ setNumber: out.length + 1, sideA: Number(m[1]), sideB: Number(m[2]) });
  }
  return out;
}

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
