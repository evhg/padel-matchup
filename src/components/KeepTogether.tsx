import { Fragment } from "react";

/**
 * One line of parts with " · " between them, each part kept whole where it fits, so "Court 3" never
 * breaks into "Court" and "3" at 390 px; a part wider than the line still wraps inside itself. The text
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
            <span className="inline-block">{part}</span>
          </Fragment>
        ))}
    </>
  );
}
