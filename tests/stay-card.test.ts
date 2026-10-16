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
  const card = (o: { member: boolean; invited: boolean; email: string | null; ask?: boolean }) =>
    inApp(
      createElement(StayUpdated, {
        code: "TDSV",
        member: o.member,
        invited: o.invited,
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
});

describe("the invitation page's form says only what went", () => {
  const form = (o: { member: boolean; invited: boolean; email: string | null }) => renderIn("en", createElement(CalendarEmail, { code: "TDSV", emailEnabled: true, ...o }));

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
});
