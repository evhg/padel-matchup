import "server-only";
import type { Db } from "@/db";
import type { Player } from "@/db/schema";
import { emailEnabled } from "@/lib/config";
import { issueEmailCode } from "@/lib/domain/identity";
import { LIMITS } from "@/lib/domain/ratelimit";
import { sendEmailCode } from "@/lib/notify";
import { ActionFailure, assertRate, clientKey } from "./shared";

/**
 * An address typed by a session by name that proved nothing (`nameOnly`). The owner's decision of 16
 * October 2026 (D3, DECIDING rule 34), "Code first": "Ask for the existing 6-digit email code before the
 * address is saved." Until then such an address was saved at once, and the next match email to it
 * carried the record's personal link, which is a permanent sign-in (ROADMAP.md, "Open, small", item 7).
 *
 * Nothing is saved here. The existing code goes to the address, through the restore's own path and
 * limits: twenty codes a day from one address (`restoreCodesPerIpPerDay`), five an hour to one address
 * (`issueEmailCode`), and the record's own limit on changes of address. The answer is the same whether
 * or not another record holds the address, so it tells the typer nothing about anybody. The code
 * proves the address, and `proveMyEmail` (src/actions/identity.ts) then saves it as proved and ends
 * the mark. Every door that saves an address for the session's own record asks this first:
 * `updateMyEmail` (the "Stay updated" card, the invitation page's `CalendarEmail`, `EmailField` on the
 * match page, My matches and the coach's channel step) and `setCreatorEmailAction` (the organiser's
 * own address). `confirmInviteAction` keeps no address from such a session.
 */
export async function askForProof(db: Db, me: Pick<Player, "id" | "locale">, address: string): Promise<void> {
  if (!emailEnabled()) throw new ActionFailure("email_disabled");
  await assertRate(db, "email", me.id, LIMITS.emailChangesPerPlayerPerDay);
  await assertRate(db, "restore", await clientKey(), LIMITS.restoreCodesPerIpPerDay);
  const issued = await issueEmailCode(db, address);
  if (!issued) throw new ActionFailure("too_many");
  if (!(await sendEmailCode(issued.email, issued.code, me.locale, { prove: true }))) throw new ActionFailure("generic");
}
