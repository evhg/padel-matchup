/**
 * What the Rally Finder lab page (kicksma.sh/lab/rally-finder.html) may leave with Kicksmash, and for
 * how long. /privacy reads the figures from here (src/lib/legal.ts), so the page and the code cannot
 * disagree.
 *
 * The numbers of a run (`lab_runs`, stages read, cut and who) are kept LAB_RUNS_KEEP_DAYS: long enough
 * to tune on a season of matches. The pictures (stage `pic`) are the owner's decision of 14 November
 * 2026, "Send automatically": the player finder lost players in Erik's match three times while every
 * synthetic test passed, and only real frames show why. Each finder run sends LAB_PICTURES_PER_RUN still
 * frames of the match, never the video. They go after LAB_PICTURE_KEEP_DAYS, at most LAB_PICTURES_MAX
 * are kept at once, and they never enter the nightly backup (src/lib/backup.ts).
 */
export const LAB_RUNS_KEEP_DAYS = 180;
export const LAB_PICTURE_KEEP_DAYS = 30;
export const LAB_PICTURES_MAX = 100;
export const LAB_PICTURES_PER_RUN = 4;
/** The stages a lab report can have; `pic` is one still frame with what the finder saw in it. */
export const LAB_STAGES: ReadonlySet<string> = new Set(["read", "cut", "who", "pic"]);
/** A JPEG in base64 starts with these characters (the bytes FF D8 FF). */
export const isJpegBase64 = (s: unknown): s is string => typeof s === "string" && s.startsWith("/9j/") && /^[A-Za-z0-9+/=]+$/.test(s);
