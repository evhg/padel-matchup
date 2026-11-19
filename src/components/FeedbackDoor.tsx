"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { screenOf } from "@/lib/feedback/screen";

/**
 * The way to the feedback form from the foot of every screen. It tells the form which screen the person was on:
 * a `<Link>` does not load a new document, so `document.referrer` still names the page the visit began on.
 */
export function FeedbackDoor({ label }: { label: string }) {
  const screen = screenOf(usePathname());
  const href = screen && screen !== "/feedback" ? `/feedback?from=${encodeURIComponent(screen)}` : "/feedback";
  return (
    <Link href={href} prefetch={false} data-testid="footer-feedback" className="rounded-full border border-current px-3 py-1 font-semibold text-muted hover:text-ink">
      💬 {label}
    </Link>
  );
}
