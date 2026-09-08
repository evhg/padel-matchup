/** FNV-1a over a string, as eight hex characters: a cheap content version for URLs and picks. */
export function fnv1a(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
  return h.toString(16).padStart(8, "0");
}
