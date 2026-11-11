import { createElement, type ReactElement } from "react";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { describe, expect, it } from "vitest";
import { CoachHome, type LessonDTO } from "@/components/coach/CoachHome";
import { DrawControls, type DrawSettingsView } from "@/components/tournament/DrawControls";
import { drawScored, type DrawView } from "@/lib/domain/competitionDraw";
import { renderIn } from "./helpers/render";

/**
 * Buttons that showed where the server refuses them (button audit, 9 November 2026): "Clear the draw"
 * after a score is in, and "On me" on a lesson the coach already marked paid. The words a screen
 * renders are a unit test; what a tap does is the browser's.
 */
const router = { back() {}, forward() {}, refresh() {}, push() {}, replace() {}, prefetch() {} };
const inApp = (el: ReactElement) => renderIn("en", createElement(AppRouterContext.Provider, { value: router as never }, el));

describe("finding 10: Clear the draw", () => {
  const settings: DrawSettingsView = { format: "knockout", groupSize: 4, groupsThrough: 2, consolation: false, qualifyingSpots: 0, scoringGroup: "set6tb", scoringKnockout: "set6tb", scoringFinal: "set6tb", goldenPoint: false, drawStatus: "published", maxPairs: 8 };
  const controls = (scored: boolean) => inApp(createElement(DrawControls, { slug: "x", categoryId: "c1", categoryName: "Gold", settings, scored }));

  it("shows while no match has a result, and goes once one has", () => {
    expect(controls(false)).toContain(">Clear the draw<");
    expect(controls(true)).not.toContain(">Clear the draw<");
  });

  it("knows a result as the server does: a score or a walkover", () => {
    const m = (scoreA: number | null, status: string) => ({ scoreA, status }) as unknown as DrawView["main"][number][number];
    const view = (main: DrawView["main"]) => ({ groups: [], qualifying: [], consolation: [], main });
    expect(drawScored(view([[m(null, "scheduled"), m(null, "pending")]]))).toBe(false);
    expect(drawScored(view([[m(null, "scheduled")], [m(6, "done")]]))).toBe(true);
    expect(drawScored(view([[m(null, "walkover")]]))).toBe(true);
  });
});

describe("finding 16: On me", () => {
  const lesson = (paid: boolean): LessonDTO => ({ id: `l-${paid}`, iso: "2026-11-11T02:00:00.000Z", day: "2026-11-11", time: "09:00", dayLabel: "Wed 11 Nov", studentName: "Ben", studentPlayerId: null, status: "booked", amount: 800, currency: "THB", paid, claimed: false, comped: null, pkg: null });
  const home = (l: LessonDTO) => inApp(createElement(CoachHome, { handle: "olga", url: "u", inviteUrl: "u", studentUrl: "u", today: "2026-11-11", welcome: false, students: [], lessons: [l], slots: [], dayLabels: { "2026-11-11": "Wed" }, days: ["2026-11-11"] }));

  it("is offered on an unpaid lesson and not on one marked paid, which the book refuses", () => {
    expect(home(lesson(false))).toContain('data-testid="comp-lesson"');
    expect(home(lesson(true))).not.toContain('data-testid="comp-lesson"');
  });
});
