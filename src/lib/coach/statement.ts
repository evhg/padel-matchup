import { and, eq, gte, inArray, lt } from "drizzle-orm";
import type { Db } from "@/db";
import { lessonPackages, lessons, players, type Coach } from "@/db/schema";

/**
 * A coach's month as an accountant would want it: per student, the lessons that happened, the ones
 * that were missed or cancelled late and counted, the ones given away, and the money — lessons paid
 * and unpaid, packages bought, paid and unpaid. The amount edit on the row was the entry; this is
 * the exit. Pure sums over two bounded queries; the CSV and the chat text are rendered from the same
 * rows, so the file and the message can never disagree.
 */

export type StatementRow = {
  playerId: string;
  name: string;
  done: number;
  noShows: number;
  lateCounted: number;
  comped: number;
  lessonsPaid: number;
  lessonsUnpaid: number;
  packagesBought: number;
  packagesPaid: number;
  packagesUnpaid: number;
};

export type Statement = { currency: string; rows: StatementRow[]; totals: Omit<StatementRow, "playerId" | "name"> };

const empty = (): Omit<StatementRow, "playerId" | "name"> => ({ done: 0, noShows: 0, lateCounted: 0, comped: 0, lessonsPaid: 0, lessonsUnpaid: 0, packagesBought: 0, packagesPaid: 0, packagesUnpaid: 0 });

/** The month [from, to) for one coach. Lessons still to come are not in it; a package counts in the month it was started. */
export async function coachStatement(db: Db, coach: Pick<Coach, "id" | "currency">, from: Date, to: Date): Promise<Statement> {
  const ls = await db
    .select({ studentPlayerId: lessons.studentPlayerId, name: players.displayName, status: lessons.status, amount: lessons.amount, paidAt: lessons.paidAt, compedAt: lessons.compedAt })
    .from(lessons)
    .leftJoin(players, eq(players.id, lessons.studentPlayerId))
    .where(and(eq(lessons.coachId, coach.id), gte(lessons.startsAt, from), lt(lessons.startsAt, to), inArray(lessons.status, ["done", "no_show", "late_cancelled"])))
    .limit(2000);
  const ps = await db
    .select({ studentPlayerId: lessonPackages.studentPlayerId, name: players.displayName, amount: lessonPackages.amount, paidAt: lessonPackages.paidAt })
    .from(lessonPackages)
    .innerJoin(players, eq(players.id, lessonPackages.studentPlayerId))
    .where(and(eq(lessonPackages.coachId, coach.id), gte(lessonPackages.createdAt, from), lt(lessonPackages.createdAt, to)))
    .limit(500);
  const byStudent = new Map<string, StatementRow>();
  const row = (id: string | null, name: string | null): StatementRow => {
    const key = id ?? "?";
    let r = byStudent.get(key);
    if (!r) {
      r = { playerId: key, name: name ?? "?", ...empty() };
      byStudent.set(key, r);
    }
    return r;
  };
  for (const l of ls) {
    const r = row(l.studentPlayerId, l.name);
    if (l.status === "done") r.done++;
    else if (l.status === "no_show") r.noShows++;
    else r.lateCounted++;
    if (l.compedAt) r.comped++;
    else if ((l.amount ?? 0) > 0) {
      if (l.paidAt) r.lessonsPaid += l.amount!;
      else r.lessonsUnpaid += l.amount!;
    }
  }
  for (const p of ps) {
    const r = row(p.studentPlayerId, p.name);
    r.packagesBought++;
    if (p.paidAt) r.packagesPaid += p.amount ?? 0;
    else r.packagesUnpaid += p.amount ?? 0;
  }
  const rows = [...byStudent.values()].sort((a, b) => a.name.localeCompare(b.name));
  const totals = empty();
  for (const r of rows) for (const k of Object.keys(totals) as (keyof typeof totals)[]) totals[k] += r[k];
  return { currency: coach.currency, rows, totals };
}

export type StatementLabels = { student: string; done: string; noShows: string; late: string; comped: string; lessonsPaid: string; lessonsUnpaid: string; packages: string; packagesPaid: string; packagesUnpaid: string; total: string };

const csvCell = (v: string | number) => {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** The same rows as a file a spreadsheet opens. Amounts are whole currency units, the currency in the header. */
export function statementCsv(st: Statement, l: StatementLabels): string {
  const head = [l.student, l.done, l.noShows, l.late, l.comped, `${l.lessonsPaid} (${st.currency})`, `${l.lessonsUnpaid} (${st.currency})`, l.packages, `${l.packagesPaid} (${st.currency})`, `${l.packagesUnpaid} (${st.currency})`];
  const line = (name: string, r: Omit<StatementRow, "playerId" | "name">) => [name, r.done, r.noShows, r.lateCounted, r.comped, r.lessonsPaid, r.lessonsUnpaid, r.packagesBought, r.packagesPaid, r.packagesUnpaid].map(csvCell).join(",");
  return [head.map(csvCell).join(","), ...st.rows.map((r) => line(r.name, r)), line(l.total, st.totals)].join("\n") + "\n";
}

/** The same rows as a chat message: one line per student, the totals last. */
export function statementText(st: Statement, title: string, l: StatementLabels, money: (n: number) => string): string {
  const part = (r: Omit<StatementRow, "playerId" | "name">) => {
    const bits: string[] = [];
    if (r.done) bits.push(`${r.done} ${l.done}`);
    if (r.noShows) bits.push(`${r.noShows} ${l.noShows}`);
    if (r.lateCounted) bits.push(`${r.lateCounted} ${l.late}`);
    if (r.comped) bits.push(`${r.comped} ${l.comped}`);
    if (r.packagesBought) bits.push(`${r.packagesBought} ${l.packages}`);
    const paid = r.lessonsPaid + r.packagesPaid;
    const unpaid = r.lessonsUnpaid + r.packagesUnpaid;
    if (paid) bits.push(`${l.lessonsPaid} ${money(paid)}`);
    if (unpaid) bits.push(`${l.lessonsUnpaid} ${money(unpaid)}`);
    return bits.join(" · ");
  };
  const lines = st.rows.map((r) => `${r.name}: ${part(r) || "—"}`);
  return `${title}\n${lines.join("\n")}\n${l.total}: ${part(st.totals) || "—"}`;
}
