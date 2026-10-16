import { createElement, type ReactElement } from "react";
import { describe, expect, it } from "vitest";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { CalendarEmail } from "@/components/CalendarEmail";
import { StayUpdated } from "@/components/StayUpdated";
import { renderIn } from "./helpers/render";

/**
 * The two cards that take an address say only what went (15 October 2026, review): the "Stay updated"
 * card on the match page, and `CalendarEmail` on the invitation page. Before, the waiting list and a
 * session by name read "Calendar invite sent" with "Send it again", while no invitation went and the
 * tap could only fail. The pure rule is `mailLine` (tests/stay-updated.test.ts); these read the screen
 * each card renders before any tap. What a tap shows after the save is in e2e/core.mjs.
 */
const router = { back() {}, forward() {}, refresh() {}, push() {}, replace() {}, prefetch() {} };
/** The match page's card needs the app router (`useRouter`), as a page gives it. */
const inApp = (el: ReactElement) => renderIn("en", createElement(AppRouterContext.Provider, { value: router as never }, el));

const INVITE_SENT = "Calendar invite sent";
const RESEND = "Not in your calendar? Send it again";

describe("the Stay updated card says only what went", () => {
  const reached = { kind: "reached" as const, via: ["email" as const], calendar: "invite" as const };
  const card = (o: { member: boolean; invited: boolean; email: string | null; ask?: boolean; byName?: boolean; request?: boolean }) =>
    inApp(
      createElement(StayUpdated, {
        code: "TDSV",
        member: o.member,
        invited: o.invited,
        byName: o.byName,
        request: o.request,
        email: o.email,
        state: o.ask ? { kind: "ask", choices: ["email"] } : reached,
        links: { whatsapp: null, telegram: null },
        feed: null,
      }),
    );

  it("a seat whose address brought the invitation: the invitation line and \"Send it again\"", () => {
    const html = card({ member: true, invited: true, email: "nia@example.com" });
    expect(html).toContain("Updates reach you by email ✓");
    expect(html).toContain(`${INVITE_SENT} to nia@example.com`);
    expect(html).toContain(RESEND);
  });

  it("the waiting list, with an address on file: reached, and no word of an invitation", () => {
    const html = card({ member: false, invited: false, email: "wes@example.com" });
    expect(html).toContain("Updates reach you by email ✓");
    expect(html).not.toContain(INVITE_SENT);
    expect(html).not.toContain(RESEND);
  });

  it("a seat in a session by name (invited false): no invitation line, and no \"Send it again\", which the server refuses", () => {
    const html = card({ member: true, invited: false, email: "bea@example.com" });
    expect(html).toContain("Updates reach you by email ✓");
    expect(html).not.toContain(INVITE_SENT);
    expect(html).not.toContain(RESEND);
  });

  it("the ask: \"Send invite\" only where an invitation goes, else \"Save\"", () => {
    const button = (html: string) => html.match(/<button type="submit"[^>]*>([^<]*)<\/button>/)?.[1];
    expect(button(card({ member: true, invited: true, email: null, ask: true }))).toBe("Send invite");
    expect(button(card({ member: false, invited: false, email: null, ask: true }))).toBe("Save");
    expect(button(card({ member: true, invited: false, email: null, ask: true }))).toBe("Save");
  });

  // The owner's decision of 16 October 2026 (D3): an address from a session by name waits for its code.
  it("the ask in a session by name says a code goes first, and its button sends the code", () => {
    const button = (html: string) => html.match(/<button type="submit"[^>]*>([^<]*)<\/button>/)?.[1];
    const html = card({ member: true, invited: false, email: null, ask: true, byName: true });
    expect(button(html)).toBe("Send code");
    expect(html).toContain("We send a 6-digit code to this address first. The address is saved when you enter the code.");
    expect(card({ member: true, invited: false, email: null, ask: true })).not.toContain("6-digit code");
  });

  // The owner's decision of 16 October 2026 (D5): the card shows to a player whose join request waits, and
  // promises no calendar invitation there.
  it("a join request that waits: the organiser's answer is what reaches the player, and no word of the calendar", () => {
    const html = card({ member: false, invited: false, email: null, ask: true, request: true });
    expect(html).toContain("Pick what you already use. The organiser&#x27;s answer reaches you there.");
    expect(html).not.toMatch(/calendar/i);
    expect(html).toMatch(/<button type="submit"[^>]*>Save<\/button>/);
  });
});

describe("the invitation page's form says only what went", () => {
  // The form needs the app router too since 16 October 2026: the code a session by name proves its address with refreshes the page (D3).
  const form = (o: { member: boolean; invited: boolean; email: string | null; byName?: boolean }) => inApp(createElement(CalendarEmail, { code: "TDSV", emailEnabled: true, ...o }));

  it("a seat whose address brought the invitation: as before, the invitation line and \"Send it again\"", () => {
    const html = form({ member: true, invited: true, email: "jordi@example.com" });
    expect(html).toContain(`${INVITE_SENT} to jordi@example.com`);
    expect(html).toContain(RESEND);
  });

  it("a session by name that confirmed through a held link, or a pair on the waiting list, with an address: no invitation line, no \"Send it again\"", () => {
    for (const member of [true, false]) {
      const html = form({ member, invited: false, email: "maria@example.com" });
      expect(html).toContain("Updates reach you by email ✓");
      expect(html).not.toContain(INVITE_SENT);
      expect(html).not.toContain(RESEND);
    }
  });

  it("the form: the calendar's promise and \"Send invite\" only where an invitation goes; else \"Stay updated\" and \"Save\"", () => {
    const invited = form({ member: true, invited: true, email: null });
    expect(invited).toContain("Add to your calendar");
    expect(invited).toContain("send a real calendar invite");
    expect(invited).toMatch(/<button type="submit"[^>]*>Send invite<\/button>/);
    for (const member of [true, false]) {
      const not = form({ member, invited: false, email: null });
      expect(not).toContain("Stay updated");
      expect(not).toContain("the changes to this match reach you there");
      expect(not).not.toContain("calendar invite");
      expect(not).toMatch(/<button type="submit"[^>]*>Save<\/button>/);
    }
  });

  it("the form in a session by name says a code goes first, and its button sends the code (D3)", () => {
    const html = form({ member: true, invited: false, email: null, byName: true });
    expect(html).toContain("We send a 6-digit code to this address first.");
    expect(html).toMatch(/<button type="submit"[^>]*>Send code<\/button>/);
  });
});
