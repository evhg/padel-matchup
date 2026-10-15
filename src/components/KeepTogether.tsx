import { Fragment } from "react";

/** A part this long or shorter is kept whole ("Court 12", "Thu, Oct 15", "WAREHAUS.club"); a longer one flows as words. */
export const KEEP_WHOLE_MAX = 16;

/**
 * One line of parts with " · " between them. A short part is one inline block, so "Court 3" never breaks
 * into "Court" and "3" at 390 px; `max-w-full` caps the block at the line, so a short part wider than a
 * narrow line wraps inside itself (the parent's `break-words`) and never runs past it. A longer part
 * (most club names: "Padel Phuket @ Blue Tree") is plain text: it wraps at its spaces, one long word
 * breaks (`break-words`), and a `line-clamp` counts its lines. An inline block keeps its widest word
 * whole and counts as one line to a clamp: as a block, "PadelhausSukhumvit39Bangkok" was cut with no
 * ellipsis on the match page, and pushed the share page past 390 px (review, 15 October 2026). The text
 * reads the same as the joined string, so a copy or a check of it sees "Club Padel Test · Court 3".
 */
export function KeepTogether({ parts }: { parts: readonly string[] }) {
  return (
    <>
      {parts
        .filter(Boolean)
        .map((part, i) => (
          <Fragment key={i}>
            {i > 0 ? " · " : null}
            {part.length <= KEEP_WHOLE_MAX ? <span className="inline-block max-w-full">{part}</span> : part}
          </Fragment>
        ))}
    </>
  );
}
