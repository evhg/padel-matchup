"use client";

import { useState, useTransition } from "react";
import { setAnswerPublishedAction } from "@/actions/listen";

/** One answer page on the desk: open it, or take it down (and put it back). */
export function AnswerRow({ id, slug, title, language, published }: { id: string; slug: string; title: string; language: string; published: boolean }) {
  const [on, setOn] = useState(published);
  const [pending, start] = useTransition();
  return (
    <li className="flex items-center justify-between gap-3 py-2 text-sm">
      <span className="min-w-0">
        <a href={`/answers/${slug}`} target="_blank" rel="noopener noreferrer" className={`link block truncate font-semibold ${on ? "" : "line-through opacity-60"}`}>
          {title}
        </a>
        <span className="text-xs text-faint">
          {language} · /answers/{slug}
        </span>
      </span>
      <button
        type="button"
        className={`${on ? "btn-ghost" : "btn-secondary"} btn-xs shrink-0`}
        disabled={pending}
        onClick={() =>
          start(async () => {
            const r = await setAnswerPublishedAction(id, !on);
            if (r.ok) setOn(!on);
          })
        }
      >
        {on ? "Unpublish" : "Publish"}
      </button>
    </li>
  );
}
