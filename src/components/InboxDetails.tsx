"use client";

import Link from "next/link";
import { useState } from "react";
import { markNoticesReadAction } from "@/actions/notices";

type Item = { id: string; text: string; when: string; unread: boolean; href: string | null };

/** The inbox's one line and its list. Opening it reads it: one call marks every notice read, and the new marks go at once. */
export function InboxDetails({ title, newLabel, unreadLabel, help, items }: { title: string; newLabel: string | null; unreadLabel: string; help: string; items: Item[] }) {
  const [read, setRead] = useState(false);
  const open = (e: React.SyntheticEvent<HTMLDetailsElement>) => {
    if (!e.currentTarget.open || read || !newLabel) return;
    setRead(true);
    void markNoticesReadAction();
  };
  return (
    <details id="inbox" className="card" data-testid="inbox" onToggle={open}>
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3">
        <span className="font-bold">{title}</span>
        {newLabel && !read && (
          <span className="chip-open shrink-0" data-testid="inbox-new">
            {newLabel}
          </span>
        )}
      </summary>
      <p className="mt-2 text-xs text-faint">{help}</p>
      <ul className="mt-3 flex flex-col gap-2">
        {items.map((n) => {
          const fresh = n.unread && !read;
          const body = (
            <>
              <span className={`block text-sm ${fresh ? "font-bold" : ""}`}>
                {fresh && (
                  <span className="mr-1 inline-block h-2 w-2 rounded-full bg-accent align-middle" role="img" aria-label={unreadLabel} />
                )}
                {n.text}
              </span>
              <span className="block text-xs text-faint">{n.when}</span>
            </>
          );
          return (
            <li key={n.id} className="rounded-xl border border-line px-3 py-2" data-unread={fresh ? "1" : undefined}>
              {n.href ? (
                <Link href={n.href} prefetch={false} className="block">
                  {body}
                </Link>
              ) : (
                body
              )}
            </li>
          );
        })}
      </ul>
    </details>
  );
}
