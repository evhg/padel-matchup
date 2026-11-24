/**
 * The share mark as the iPhone draws it: a tray open at the top, with an arrow up out of it (the owner, 24 November
 * 2026: "use same icon as iOS"). A line drawing in the text's own colour, so it follows the button in both themes.
 */
export function ShareIcon({ className = "h-[1.1em] w-[1.1em]" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={`inline-block shrink-0 ${className}`} fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3.5v11" />
      <path d="M8 7.2 12 3.3l4 3.9" />
      <path d="M8.5 10H6.8A1.8 1.8 0 0 0 5 11.8v7.4A1.8 1.8 0 0 0 6.8 21h10.4a1.8 1.8 0 0 0 1.8-1.8v-7.4a1.8 1.8 0 0 0-1.8-1.8h-1.7" />
    </svg>
  );
}
