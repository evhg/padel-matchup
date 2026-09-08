import type { Db } from "@/db";
import type { Coach } from "@/db/schema";
import { addStudentByName, createPackage, listStudents } from "@/lib/domain/coaching";

/**
 * The coach's sheet, brought over in one paste. Coaches keep packages in a Google Sheet
 * with a column order of their own; we read what is there (a header when they have one,
 * shapes like "4/10" when they don't) and show a preview before anything is written.
 * Nothing is guessed silently: a line we cannot read is counted, not invented.
 */

export type ImportRow = {
  name: string;
  email: string | null;
  size: number;
  used: number;
  /** ISO date (YYYY-MM-DD) or null for no expiry. */
  expires: string | null;
  amount: number | null;
  paid: boolean;
};

export type ParsedSheet = { rows: ImportRow[]; skipped: number };

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PAID = /^(paid|yes|y|✓|✔|true|x|оплачен[оа]?|да|pagad[oa]|sí|si)$/i;
const UNPAID = /^(unpaid|not paid|no|n|false|pending|due|не оплачен[оа]?|нет|no pagad[oa]|pendiente)$/i;
const HEADER: Record<keyof ImportRow, RegExp> = {
  name: /^(name|student|player|client|имя|ученик|клиент|nombre|alumno|cliente)/i,
  email: /^(e-?mail|почта|correo)/i,
  size: /^(lessons|package|size|total|bought|уроков|уроки|пакет|всего|clases|paquete|total)/i,
  used: /^(used|done|taken|attended|использовано|проведено|пройдено|usadas|hechas|tomadas)/i,
  expires: /^(expir|valid|until|ends|deadline|до|срок|истекает|vence|caduca|válido|valido|hasta)/i,
  amount: /^(price|amount|paid amount|cost|thb|฿|цена|сумма|стоимость|precio|importe|coste)/i,
  paid: /^(paid\??|status|payment|оплат|статус|pagado|pago|estado)$/i,
};
const LEFT = /^(left|remaining|balance|осталось|остаток|quedan|restantes|saldo)/i;

/** Splits one line the way a sheet pastes it: tabs first, then semicolons or commas with quotes honoured. */
export function splitCells(line: string): string[] {
  if (line.includes("\t")) return line.split("\t").map((c) => c.trim());
  if (!/[,;]/.test(line)) {
    // Words only: "Anna Smith 10 4" — the name runs up to the first number, date or yes/no.
    const tokens = line.trim().split(/\s+/);
    const cut = tokens.findIndex((tk, i) => i > 0 && (/^\d/.test(tk) || EMAIL.test(tk) || PAID.test(tk) || UNPAID.test(tk)));
    if (cut === -1) return [line.trim()];
    return [tokens.slice(0, cut).join(" "), ...tokens.slice(cut)];
  }
  const sep = line.includes(";") && !line.includes(",") ? ";" : ",";
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else quoted = !quoted;
    } else if (ch === sep && !quoted) {
      out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12, янв: 1, фев: 2, мар: 3, апр: 4, мая: 5, май: 5, июн: 6, июл: 7, авг: 8, сен: 9, окт: 10, ноя: 11, дек: 12, ene: 1, abr: 4, ago: 8, dic: 12 };

/** A date the way people type it: 2026-12-01, 1/12/2026 (day first), 01.12.26, 1 Dec 2026. */
export function parseSheetDate(cell: string, now = new Date()): string | null {
  const c = cell.trim();
  let y: number, m: number, d: number;
  let r: RegExpExecArray | null;
  if ((r = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(c))) [y, m, d] = [Number(r[1]), Number(r[2]), Number(r[3])];
  else if ((r = /^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})$/.exec(c))) {
    d = Number(r[1]);
    m = Number(r[2]);
    y = Number(r[3]);
    if (y < 100) y += 2000;
    if (m > 12 && d <= 12) [d, m] = [m, d];
  } else if ((r = /^(\d{1,2})\s+([A-Za-zА-Яа-я]{3})[A-Za-zА-Яа-я.]*\s*(\d{2,4})?$/.exec(c))) {
    d = Number(r[1]);
    m = MONTHS[r[2].toLowerCase()] ?? 0;
    y = r[3] ? Number(r[3]) : now.getUTCFullYear();
    if (y < 100) y += 2000;
  } else return null;
  if (!m || m > 12 || !d || d > 31 || y < 2000 || y > 2100) return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCMonth() !== m - 1) return null;
  return date.toISOString().slice(0, 10);
}

const num = (cell: string): number | null => {
  const m = /-?\d[\d,. ]*/.exec(cell.replace(/[฿$€£]|thb|eur|usd/gi, ""));
  if (!m) return null;
  const n = Number(m[0].replace(/[ ,]/g, "").replace(/\.(?=.*\.)/g, ""));
  return Number.isFinite(n) ? n : null;
};
const isNumberCell = (cell: string) => /^[฿$€£]?\s*-?\d[\d,. ]*\s*(thb|eur|usd|฿)?$/i.test(cell.trim());

function detectHeader(cells: string[]): Partial<Record<keyof ImportRow | "left", number>> | null {
  if (cells.some(isNumberCell)) return null;
  const map: Partial<Record<keyof ImportRow | "left", number>> = {};
  cells.forEach((c, i) => {
    const cell = c.trim();
    if (!cell) return;
    if (LEFT.test(cell)) map.left ??= i;
    else for (const key of Object.keys(HEADER) as (keyof ImportRow)[]) if (HEADER[key].test(cell)) return void (map[key] ??= i);
  });
  return map.name !== undefined || map.size !== undefined ? map : null;
}

function readRow(cells: string[], header: Partial<Record<keyof ImportRow | "left", number>> | null, now: Date): ImportRow | null {
  const cellAt = (i: number | undefined) => (i === undefined ? undefined : cells[i]?.trim());
  let name = cellAt(header?.name) ?? "";
  let email = cellAt(header?.email) ?? null;
  let size: number | null = null;
  let used: number | null = null;
  let left: number | null = null;
  let expires: string | null = null;
  let amount: number | null = null;
  let paid: boolean | null = null;
  if (header) {
    const s = cellAt(header.size);
    const frac = s && /^(\d+)\s*(?:\/|of|из|de)\s*(\d+)$/i.exec(s);
    if (frac) [used, size] = [Number(frac[1]), Number(frac[2])];
    else if (s) size = num(s);
    const u = cellAt(header.used);
    if (u) used = num(u);
    const l = cellAt(header.left);
    if (l) left = num(l);
    const e = cellAt(header.expires);
    if (e) expires = parseSheetDate(e, now);
    const a = cellAt(header.amount);
    if (a) amount = num(a);
    const p = cellAt(header.paid);
    if (p) paid = PAID.test(p) ? true : UNPAID.test(p) ? false : null;
  }
  const taken = new Set(Object.values(header ?? {}));
  const free = cells.map((c, i) => [c.trim(), i] as const).filter(([c, i]) => c && !taken.has(i));
  const numbers: number[] = [];
  for (const [c] of free) {
    const frac = /^(\d+)\s*(?:\/|of|из|de)\s*(\d+)$/i.exec(c);
    if (frac && size === null) {
      [used, size] = [Number(frac[1]), Number(frac[2])];
      continue;
    }
    if (EMAIL.test(c)) {
      email ??= c;
      continue;
    }
    if (expires === null && !/^\d+$/.test(c)) {
      const d = parseSheetDate(c, now);
      if (d) {
        expires = d;
        continue;
      }
    }
    if (paid === null && PAID.test(c)) {
      paid = true;
      continue;
    }
    if (paid === null && UNPAID.test(c)) {
      paid = false;
      continue;
    }
    if (isNumberCell(c)) {
      numbers.push(num(c) ?? 0);
      continue;
    }
    if (!name && /\p{L}/u.test(c)) name = c;
  }
  for (const n of numbers) {
    if (size === null && n >= 1 && n <= 200) size = n;
    else if (used === null && left === null && size !== null && n >= 0 && n <= size) used = n;
    else if (amount === null && n > 200) amount = n;
  }
  if (!name || size === null || !Number.isFinite(size) || size < 1 || size > 200) return null;
  size = Math.round(size);
  if (used === null && left !== null) used = size - Math.round(left);
  return {
    name: name.replace(/\s+/g, " ").slice(0, 40),
    email: email && EMAIL.test(email) ? email.toLowerCase() : null,
    size,
    used: Math.min(size, Math.max(0, Math.round(used ?? 0))),
    expires,
    amount: amount !== null && amount > 0 ? Math.round(amount) : null,
    paid: paid ?? true,
  };
}

/** Pasted rows or a downloaded CSV, into rows we can show back. */
export function parsePackageSheet(text: string, now = new Date()): ParsedSheet {
  const lines = text.replace(/\r/g, "").split("\n").map((l) => l.trimEnd()).filter((l) => l.trim().length > 0);
  const rows: ImportRow[] = [];
  let skipped = 0;
  let header: ReturnType<typeof detectHeader> = null;
  lines.forEach((line, i) => {
    const cells = splitCells(line);
    if (i === 0) {
      header = detectHeader(cells);
      if (header) return;
    }
    const row = readRow(cells, header, now);
    if (row) rows.push(row);
    else skipped++;
  });
  return { rows: rows.slice(0, 200), skipped };
}

/** A Google Sheet link (or any CSV address) turned into something we can download. */
export function sheetCsvUrl(input: string): string | null {
  const s = input.trim();
  const g = /^https:\/\/docs\.google\.com\/spreadsheets\/d\/([A-Za-z0-9_-]+)/.exec(s);
  if (g) {
    const gid = /[#&?]gid=(\d+)/.exec(s)?.[1] ?? "0";
    return `https://docs.google.com/spreadsheets/d/${g[1]}/export?format=csv&gid=${gid}`;
  }
  if (/^https:\/\/\S+\.csv(\?\S*)?$/i.test(s) || /output=csv/.test(s)) return s;
  return null;
}

export const looksLikeLink = (text: string) => /^https?:\/\/\S+$/i.test(text.trim());

export async function fetchSheet(url: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const res = await fetchImpl(url, { redirect: "follow", signal: AbortSignal.timeout(12_000), headers: { "user-agent": "Kicksmash sheet import (https://kicksma.sh)" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  if (/<html/i.test(text.slice(0, 500))) throw new Error("not shared");
  return text.slice(0, 200_000);
}

export type ImportOutcome = { created: number; newStudents: number; matched: number };

/** Writes the rows: students by name (an existing one is reused, case aside), one open package each. */
export async function importPackages(db: Db, coach: Coach, rows: ImportRow[], locale: string, now = new Date()): Promise<ImportOutcome> {
  const existing = await listStudents(db, coach.id, now);
  const byName = new Map(existing.map((s) => [s.player.displayName.trim().toLowerCase(), s.player]));
  const out: ImportOutcome = { created: 0, newStudents: 0, matched: 0 };
  for (const row of rows.slice(0, 200)) {
    const key = row.name.trim().toLowerCase();
    let player = byName.get(key) ?? null;
    if (player) out.matched++;
    else {
      player = await addStudentByName(db, coach.id, row.name, locale, row.email);
      byName.set(key, player);
      out.newStudents++;
    }
    await createPackage(
      db,
      { coachId: coach.id, studentPlayerId: player.id, size: row.size, used: row.used, expiresAt: row.expires ? new Date(`${row.expires}T23:59:59.000Z`) : null, amount: row.amount, currency: "THB", paid: row.paid, note: "sheet" },
      now,
    );
    out.created++;
  }
  return out;
}
