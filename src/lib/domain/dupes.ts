import type { Player } from "@/db/schema";

/**
 * When two rows are the same person.
 *
 * Identity here is a UUID in a cookie, on purpose: no accounts, no passwords. The cost is that the
 * same person typing the same name in a second browser, a private window, another phone or an in-app
 * browser becomes a second row. On 23 September 2026 the database held 56 rows for about 48 people:
 * one name had six rows, another five, and the five included the ten matches its owner had created.
 *
 * The app already folds rows together — `verifyRestoreCode` merges everybody who proves one address,
 * and `claimPartnerSpot` folds a placeholder into the claimer. What was missing is the rule those two
 * share, written once and testable: **what makes two rows safe to merge.**
 *
 * The asymmetry that decides every line below: a merge cannot be undone. Leaving one person with two
 * halves of their history costs them a little. Handing one stranger's history to another is the thing
 * this must never do. So every rule needs a key two different people would not share, and a name is
 * not one.
 *
 * The owner approved these on 23 September 2026, rule by rule, with the trade-off stated for each:
 *   - `same_email`: yes, on a shared address, verified or not. The known cost is a family or club
 *     inbox two people use, and it was accepted against the certainty this key otherwise gives.
 *   - `same_name_one_address`: yes, as written. The known cost is two real people of one name, where
 *     one of them never gave an address. Nothing else contradicts, so nothing else can catch it.
 *   - Automatically, without anybody looking: on a proved email and on a Telegram link, because both
 *     are proof. **Not** on a nightly sweep — a wrong rule running overnight does its damage before
 *     anybody reads the report.
 *
 * One line that is not a preference: **an address that was typed is not an address that was proved.**
 * `same_email` is safe for a merge somebody runs and reads the rows of. Firing it when an email is
 * merely saved would be an account takeover — type a stranger's address into the email field and
 * their matches become yours. That is why the automatic path is `restoreByEmail`, which runs only
 * after a code came back, and why `EmailField` saving an address merges nothing.
 */

export type MergeCandidate = Pick<Player, "id" | "displayName" | "email" | "telegramId">;

export type MergeVerdict = { ok: true; rule: MergeRule } | { ok: false; reason: string };

/** Each rule is a key, named so a refusal and an approval both say which one applied. */
export type MergeRule =
  /** Both rows carry the same address. The strongest key there is, and the one `verifyRestoreCode` already trusts. */
  | "same_email"
  /** Both rows carry the same Telegram account. One account, one person. */
  | "same_telegram"
  /** The same name, and at most one of the two can be reached at all. Nothing contradicts; nothing proves it either. */
  | "same_name_one_address";

/** Lower case, one space between words, trimmed. What a person types twice is rarely spaced the same. */
export const normalName = (s: string | null | undefined): string => (s ?? "").toLowerCase().replace(/\s+/g, " ").trim();

const email = (p: MergeCandidate) => (p.email ?? "").toLowerCase().trim() || null;

/**
 * Yes, and under which rule. No, and why.
 *
 * Order matters: a strong key is checked before the name, so two rows that share an address merge
 * even when one of them was typed as "jakob" and the other as "Jakob".
 */
export function safeToMerge(into: MergeCandidate, from: MergeCandidate): MergeVerdict {
  if (into.id === from.id) return { ok: false, reason: "same row" };
  const a = email(into);
  const b = email(from);
  if (a && b && a === b) return { ok: true, rule: "same_email" };
  if (into.telegramId && from.telegramId && into.telegramId === from.telegramId) return { ok: true, rule: "same_telegram" };
  // From here on the only thing left is the name, so anything that says "two people" wins.
  if (a && b) return { ok: false, reason: "two different addresses" };
  if (into.telegramId && from.telegramId) return { ok: false, reason: "two different Telegram accounts" };
  if (!normalName(into.displayName) || normalName(into.displayName) !== normalName(from.displayName)) return { ok: false, reason: "different names" };
  return { ok: true, rule: "same_name_one_address" };
}

/**
 * Does the name somebody is typing already belong to a person in this match?
 *
 * The match page is where duplicates are born. A friend's link opens in WhatsApp's or Instagram's
 * own browser, which has never seen this person; the page asks "What's your name?"; they type the
 * name they always type, and become a second row with none of their history on it. Micky was invited
 * to a match by email on 23 September, the mail did not reach her, and the next thing she would have
 * done is exactly this.
 *
 * Compared only against the names already on this match, never against the whole table. Those names
 * are printed on the page the person is looking at, so recognising one tells them nothing they
 * cannot already read. Matching against every player would answer "who else uses Kicksmash?" to
 * anybody with a link, one guess at a time.
 */
export function nameIsHere(typed: string, namesHere: readonly (string | null | undefined)[]): boolean {
  const n = normalName(typed);
  if (n.length < 2) return false;
  return namesHere.some((other) => normalName(other) === n);
}

/**
 * The row to keep out of a group: the one that can be reached, then the one with the most history,
 * then the oldest. Keeping the reachable row means the person can still prove who they are, and
 * keeping the busiest means the fewest rows have to move.
 */
export function pickSurvivor<T extends MergeCandidate & { createdAt: Date; weight?: number }>(rows: readonly T[]): T | null {
  if (rows.length === 0) return null;
  const score = (r: T) => (r.email ? 4 : 0) + (r.telegramId ? 2 : 0);
  return [...rows].sort((x, y) => score(y) - score(x) || (y.weight ?? 0) - (x.weight ?? 0) || x.createdAt.getTime() - y.createdAt.getTime())[0];
}

/**
 * The groups a nightly pass would act on: every row that `safeToMerge` says belongs with the
 * survivor. A row that contradicts the survivor is left alone rather than merged into second place,
 * because "not this person" is an answer, not a smaller group to try again on.
 */
export function mergeGroups<T extends MergeCandidate & { createdAt: Date; weight?: number }>(rows: readonly T[]): { into: T; from: T[]; rule: MergeRule }[] {
  const out: { into: T; from: T[]; rule: MergeRule }[] = [];
  const taken = new Set<string>();
  for (const row of rows) {
    if (taken.has(row.id)) continue;
    const others = rows.filter((r) => r.id !== row.id && !taken.has(r.id));
    const group = [row, ...others.filter((r) => safeToMerge(row, r).ok)];
    if (group.length < 2) continue;
    const into = pickSurvivor(group)!;
    const from = group.filter((r) => r.id !== into.id && safeToMerge(into, r).ok);
    if (from.length === 0) continue;
    const first = safeToMerge(into, from[0]);
    if (!first.ok) continue;
    for (const r of [into, ...from]) taken.add(r.id);
    out.push({ into, from, rule: first.rule });
  }
  return out;
}
