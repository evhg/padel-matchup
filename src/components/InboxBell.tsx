"use client";

import Link from "next/link";

/**
 * The header's bell: the unread notices as a number, a link to the inbox on My matches, named "2 new
 * updates". On My matches itself the link is to a place on the same page, and a same-page hash link
 * remounts nothing, so the inbox only scrolled into view and stayed shut and unread (review, 12 October
 * 2026). When the page holds the inbox, the tap opens it in place; opening it reads it (`InboxDetails`).
 */
export function InboxBell({ label, count, className }: { label: string; count: string; className: string }) {
  const openHere = (e: React.MouseEvent<HTMLAnchorElement>) => {
    const inbox = document.getElementById("inbox");
    if (!(inbox instanceof HTMLDetailsElement)) return;
    e.preventDefault();
    inbox.open = true;
    inbox.scrollIntoView({ block: "start" });
  };
  return (
    <Link href="/me#inbox" prefetch={false} onClick={openHere} aria-label={label} title={label} data-testid="nav-unread" className={className}>
      <svg aria-hidden="true" viewBox="0 0 24 24" className="h-3 w-3" fill="currentColor">
        <path d="M12 2a6 6 0 0 0-6 6v3.6l-1.7 3A1 1 0 0 0 5.2 16h13.6a1 1 0 0 0 .9-1.4l-1.7-3V8a6 6 0 0 0-6-6Zm-2.8 15.5a2.9 2.9 0 0 0 5.6 0Z" />
      </svg>
      {count}
    </Link>
  );
}
