import { afterEach, describe, expect, it } from "vitest";
import { formState, registerJoinHandler, requestJoin, sendForm, type SpotState } from "@/components/joinBus";

/**
 * The fixed "Join this match" and the open spots under it (review, 15 October 2026). A player who opened
 * the second open row and typed a name, then tapped the fixed button, got a second, empty form in the
 * first row: the bus always called the first spot. And the form went out through `requestSubmit`, which
 * Safari before 16 (iOS 15) does not have, so the tap threw there.
 */
const undo: (() => void)[] = [];
afterEach(() => {
  while (undo.length) undo.pop()!();
});
const spot = (state: SpotState, ran: string[], name: string) => {
  undo.push(registerJoinHandler(() => ran.push(name), () => state));
};

describe("the fixed Join reaches the form the player opened", () => {
  it("with no form open, the first spot opens", () => {
    const ran: string[] = [];
    spot("closed", ran, "row1");
    spot("closed", ran, "row2");
    expect(requestJoin()).toBe(true);
    expect(ran).toEqual(["row1"]);
  });

  it("a name typed in the second row is sent from the second row, never a new form in the first", () => {
    const ran: string[] = [];
    spot("closed", ran, "row1");
    spot("filled", ran, "row2");
    spot("closed", ran, "row3");
    requestJoin();
    expect(ran).toEqual(["row2"]);
  });

  it("a row with a name goes before an open, empty one; an open one before a closed first row", () => {
    const ran: string[] = [];
    spot("open", ran, "row1");
    spot("filled", ran, "row2");
    requestJoin();
    expect(ran).toEqual(["row2"]);
    undo.splice(0).forEach((u) => u());
    const ran2: string[] = [];
    spot("closed", ran2, "row1");
    spot("open", ran2, "row2");
    requestJoin();
    expect(ran2).toEqual(["row2"]);
  });

  it("with no spot on the page, the caller falls back", () => {
    expect(requestJoin()).toBe(false);
  });

  it("a spot registered with no state is closed, as before", () => {
    const ran: string[] = [];
    undo.push(registerJoinHandler(() => ran.push("waitlist")));
    spot("filled", ran, "row");
    requestJoin();
    expect(ran).toEqual(["row"]);
  });
});

describe("the form goes out through its own submit button", () => {
  const form = (button: { click: () => void } | null) => ({ querySelector: (sel: string) => (sel === 'button[type="submit"]' ? button : null) }) as unknown as HTMLFormElement;
  const name = (value: string) => ({ value }) as HTMLInputElement;

  it("clicks the submit button, so every check of onSubmit runs, and needs no requestSubmit (Safari 15)", () => {
    let clicks = 0;
    const f = form({ click: () => clicks++ });
    expect("requestSubmit" in f).toBe(false);
    expect(sendForm(f)).toBe(true);
    expect(clicks).toBe(1);
  });

  it("says no when there is no form or no submit button, so the spot opens instead", () => {
    expect(sendForm(null)).toBe(false);
    expect(sendForm(form(null))).toBe(false);
  });

  it("reads the spot's state from the form and its name field", () => {
    expect(formState(null, null)).toBe("closed");
    expect(formState(form(null), name("  "))).toBe("open");
    expect(formState(form(null), name("Mia"))).toBe("filled");
    // A form that asks no name (a known player picking a level) is ready as it is.
    expect(formState(form(null), null)).toBe("filled");
  });
});
