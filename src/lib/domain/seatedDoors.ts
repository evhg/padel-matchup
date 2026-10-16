/**
 * The doors "Danny is in this match. Sign in as Danny?" shows for a seated record that "That's me"
 * refuses. The owner's decision of 16 October 2026 (D4, DECIDING rule 34). The question was: ""Sign in
 * as Danny?" now shows every sign-in door: Face ID, the email code, Telegram. Telegram can make a second
 * Danny, and Face ID opens an empty sheet for most players. Which doors should it show?" The answer was
 * "Only Danny's doors (Recommended)": "The email code if Danny has an address, Telegram if linked, Face
 * ID if he has a passkey; email first. Pro: every door works, no second Danny. Con: a stranger learns
 * which kinds of proof Danny has (never the address)."
 *
 * So the question shows the record's own doors and never the deployment's whole set: the email code
 * where the record has an address (its own or the one kept for recovery, as the restore reads both) and
 * the deployment sends mail; Telegram where the record has a linked Telegram and the deployment runs the
 * sign-in; Face ID or a fingerprint where the record has a passkey. With none of them (a record "That's
 * me" refuses for another reason: a phone, a coach's book, an upcoming match it organises), no door, and
 * the question offers "I'm a different Danny" alone.
 *
 * The browser gets three booleans, and only for the name it typed, in the join's own refusal
 * (`name_seated`, `doorsDetail`): never an address, an id or anything about another record. Pure, and
 * safe in a browser.
 */
export type OwnDoors = { email: boolean; telegram: boolean; passkey: boolean };

export const NO_DOORS: OwnDoors = { email: false, telegram: false, passkey: false };

/** The doors of the seated records of one name (two of one name each bring theirs: every door shown opens one of them). Pure. */
export function seatedDoors(records: readonly { email: string | null; recoveryEmail: string | null; telegramId: string | number | bigint | null; passkey: boolean }[], runs: { email: boolean; telegram: boolean }): OwnDoors {
  return {
    email: runs.email && records.some((r) => Boolean(r.email || r.recoveryEmail)),
    telegram: runs.telegram && records.some((r) => r.telegramId != null),
    passkey: records.some((r) => r.passkey),
  };
}

const PREFIX = "doors:";

/** The doors as the refusal's `detail` carries them: `doors:email,telegram,passkey`, or `doors:` for none. */
export const doorsDetail = (d: OwnDoors): string => PREFIX + (["email", "telegram", "passkey"] as const).filter((k) => d[k]).join(",");

/** The doors back from a refusal's `detail`; none for anything else (an older server, a missing detail). */
export function readDoors(detail: string | null | undefined): OwnDoors {
  if (!detail?.startsWith(PREFIX)) return NO_DOORS;
  const on = new Set(detail.slice(PREFIX.length).split(","));
  return { email: on.has("email"), telegram: on.has("telegram"), passkey: on.has("passkey") };
}

/** Whether any door stands. */
export const anyDoor = (d: OwnDoors): boolean => d.email || d.telegram || d.passkey;
