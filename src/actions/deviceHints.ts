"use server";

import { revalidatePath } from "next/cache";
import { getDb, type Db } from "@/db";
import { isValidShareCode } from "@/lib/codes";
import { emailEnabled } from "@/lib/config";
import { telegramBotId } from "@/lib/telegram/api";
import { askKeyOf, saveHintLater } from "@/lib/deviceHint";
import { hintAnswerOf, hintCounters, hintMatch, hintOpen, readHint, type HintAnswer, type HintMatch, type HintOutcome } from "@/lib/domain/deviceHintAsk";
import { forgetDeviceHints, forgetHintRow, setHintsOff } from "@/lib/domain/deviceHints";
import { bumpMetric, bumpMetrics } from "@/lib/domain/metrics";
import { LIMITS, takeRate } from "@/lib/domain/ratelimit";
import { countSignIn } from "@/lib/domain/signins";
import { commitThatsMe, decideThatsMe } from "@/lib/domain/thatsMe";
import { later } from "@/lib/later";
import { mergesLater } from "@/lib/mergeCount";
import { getSessionPlayer, markSignedInByName, setSessionPlayer } from "@/lib/session";
import { ActionFailure, clientKey, nameOnly, runA, userAgent, type ActionResult } from "./shared";

/**
 * "Forget this phone" on My matches (device hints, the owner's decision of 28 October 2026): one row of
 * the session's own record, by the row's id, never another player's. Any session of the record may forget
 * one, a session by name too: forgetting only takes a question away, and grants nothing.
 */
export async function forgetHintAction(id: string): Promise<ActionResult<null>> {
  return runA(async () => {
    const db = await getDb();
    const me = await getSessionPlayer(db);
    if (!me) throw new ActionFailure("no_identity");
    if (!(await forgetHintRow(db, me.id, id))) throw new ActionFailure("invalid");
    revalidatePath("/me");
    return null;
  });
}

/**
 * "Don't recognise my phones" on My matches: the player's lasting objection to the device key (Thai PDPA
 * s.32; the session decided it under standing order 3 on 28 October 2026, DECIDING rule 40). On, every row
 * of the record goes and no door keeps a key; off, the next join or sign-in keeps one again
 * (`setHintsOff`). A session by name that proved nothing may change it neither way: it proved nothing
 * (rule 34), and the switch speaks for the person. It gets `forbidden`, and My matches says why.
 */
export async function hintsOffAction(off: boolean): Promise<ActionResult<{ off: boolean }>> {
  return runA(async () => {
    const db = await getDb();
    const me = await getSessionPlayer(db);
    if (!me) throw new ActionFailure("no_identity");
    if (await nameOnly(me)) throw new ActionFailure("forbidden");
    await setHintsOff(db, me.id, off === true);
    revalidatePath("/me");
    return { off: off === true };
  });
}

/** The doors this deployment runs, as the seated question reads them. */
const runs = () => ({ email: emailEnabled(), telegram: Boolean(telegramBotId()) });

/**
 * What every step of the question starts from, or null (nothing to ask): a match code, the switch at
 * `ask`, the browser's values good and outside Europe (the key, made here), a browser that knows nobody,
 * and a match that is not called off and has not started.
 */
async function questionOf(db: Db, code: unknown, values: unknown, now: Date): Promise<{ key: string; ev: HintMatch } | null> {
  if (typeof code !== "string" || !isValidShareCode(code)) return null;
  const key = askKeyOf(values);
  if (!key) return null;
  if (await getSessionPlayer(db)) return null;
  const ev = await hintMatch(db, code);
  return ev && hintOpen(ev, now) ? { key, ev } : null;
}

/**
 * "Welcome back, Tim?" (design B, part 2; the owner's decision of 28 October 2026, DECIDING rule 40). The
 * match page mounts the part that calls this only where its one read said a record in scope has a hint
 * (`anyHintAmong`); the browser sends its values once per match in a tab. Twenty a day for one address,
 * as "That's me", and `hintAsksPerMatchPerDay` for one match. The server makes the key, reads the scope
 * again itself, and answers a first name, with the record's own doors for a record that can prove itself;
 * nothing for no record, for two, for the second Tim or for a record with no way in. Never an id, a key
 * or which value matched. The day's counters move after the answer.
 */
export async function deviceHintAction(code: string, values: unknown): Promise<ActionResult<HintAnswer | null>> {
  return runA(async () => {
    const db = await getDb();
    const now = new Date();
    if (typeof code !== "string" || !isValidShareCode(code) || !askKeyOf(values)) return null;
    if (!(await takeRate(db, "hint", await clientKey(), LIMITS.hintAsksPerIpPerDay, "day", now))) throw new ActionFailure("too_many");
    const q = await questionOf(db, code, values, now);
    if (!q) return null;
    if (!(await takeRate(db, "hint_match", q.ev.id, LIMITS.hintAsksPerMatchPerDay, "day", now))) return null;
    const outcome = await readHint(db, q.ev, q.key, runs(), now);
    await countLater(db, outcome);
    return hintAnswerOf(outcome);
  });
}

/**
 * "It's me": signs in exactly as "That's me" does. The server finds the record again from the values (the
 * browser sends no id and no name), and only a question that stands now is answered: then `decideThatsMe`
 * for that record's name (the address's "That's me" rate, the verdict, the record's rate) must name the
 * same record, and `commitThatsMe` signs it in. The session is by name, as every sign-in by name
 * (`markSignedInByName`); `signin_thats_me` counts it with `hint_yes` beside it, and the key is seen again.
 *
 * A tap is a question too, so it takes the question's rates first, as `deviceHintAction` does: the
 * address's 20 a day before any read, and the match's daily cap before the candidates' read. A script
 * that tries values here meets the same bounds as one that asks (review, 28 October 2026). A tap that
 * finds no question costs a "That's me" attempt too, so the tap is no free way to try values.
 */
export async function deviceHintYesAction(code: string, values: unknown): Promise<ActionResult<{ name: string }>> {
  return runA(async () => {
    const db = await getDb();
    const now = new Date();
    const rateKey = await clientKey();
    if (!(await takeRate(db, "hint", rateKey, LIMITS.hintAsksPerIpPerDay, "day", now))) throw new ActionFailure("too_many");
    const q = await questionOf(db, code, values, now);
    if (q && !(await takeRate(db, "hint_match", q.ev.id, LIMITS.hintAsksPerMatchPerDay, "day", now))) throw new ActionFailure("too_many");
    const outcome: HintOutcome = q ? await readHint(db, q.ev, q.key, runs(), now) : { kind: "none" };
    if (!q || outcome.kind !== "ask") {
      if (!(await takeRate(db, "thatsme", rateKey, LIMITS.thatsMePerIpPerDay, "day", now))) throw new ActionFailure("too_many");
      throw new ActionFailure("invalid");
    }
    const d = await decideThatsMe(db, { code: q.ev.code, name: outcome.name, viewerId: null, rateKey, now });
    if (!d.ok) throw new ActionFailure(d.reason === "too_many" ? "too_many" : "invalid");
    if (d.id !== outcome.id || d.fold) throw new ActionFailure("invalid");
    const res = await commitThatsMe(db, d, { viewerId: null, now, counter: mergesLater(db) });
    if (!res.ok) throw new ActionFailure("invalid");
    await setSessionPlayer(res.player.id);
    // Marked until the record proves something: no personal link for a sign-in by name (DECIDING rule 34).
    await markSignedInByName(res.player.id);
    // One statement after the answer: the sign-in, its browser and `hint_yes` beside it (`countSignIn`).
    const ua = await userAgent();
    await later(() => countSignIn(db, "thats_me", ua, ["hint_yes"]));
    await saveHintLater(db, res.player.id, values, { eventId: q.ev.id }, now);
    revalidatePath("/", "layout");
    return { name: res.player.displayName };
  });
}

/**
 * "Not me": the record's row of this key goes (`forgetDeviceHints`), and `hint_no` counts it. Only for a
 * question that stands now (the same read as the ask), and on the address's question rate. The record's
 * other phones stay. This is no lasting "no": the record's own next join or sign-in from any phone that
 * gives the same key (its owner's phone of the same model, say) keeps the key again, and then this phone
 * can be asked about that record again, as after "Forget this phone". DECIDING rule 40 says so, and
 * `tests/device-hint-ask.test.ts` proves it. A lasting refusal waits for `hint_no` against `hint_asked` (a session's
 * decision of 28 October 2026, DECIDING rule 40; the owner can ask for it).
 */
export async function deviceHintNotMeAction(code: string, values: unknown): Promise<ActionResult<null>> {
  return runA(async () => {
    const db = await getDb();
    const now = new Date();
    if (typeof code !== "string" || !isValidShareCode(code) || !askKeyOf(values)) return null;
    if (!(await takeRate(db, "hint", await clientKey(), LIMITS.hintAsksPerIpPerDay, "day", now))) throw new ActionFailure("too_many");
    const q = await questionOf(db, code, values, now);
    if (!q) return null;
    const outcome = await readHint(db, q.ev, q.key, runs(), now);
    if (outcome.kind === "ask" || outcome.kind === "doors") {
      await forgetDeviceHints(db, outcome.id, q.key);
      await later(() => bumpMetric(db, "hint_no"));
    }
    return null;
  });
}

/** The counters of one answer, after it (`hintCounters`): one upsert for all of them (`bumpMetrics`), never in the way of the answer. */
async function countLater(db: Db, outcome: HintOutcome): Promise<void> {
  const keys = hintCounters(outcome);
  if (keys.length === 0) return;
  await later(() => bumpMetrics(db, keys).catch(() => undefined));
}
