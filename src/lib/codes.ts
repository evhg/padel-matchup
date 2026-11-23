import { customAlphabet } from "nanoid";

/** Unambiguous alphabet: no 0/O/1/l/I. */
export const CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

const gen4 = customAlphabet(CODE_ALPHABET, 4);
const gen6 = customAlphabet(CODE_ALPHABET, 6);
const gen8 = customAlphabet(CODE_ALPHABET, 8);
const gen10 = customAlphabet(CODE_ALPHABET, 10);

/** Public share code — /{code} */
export const newShareCode = () => gen4();
/** Personal invite code — /{code}/i/{invite} */
export const newInviteCode = () => gen6();
/** Organizer secret — /{code}/manage/{manage}. Never shorter than 10. */
export const newManageCode = () => gen10();
/** A coach's student link — /c/{handle}?i={code} */
export const newCoachCode = () => gen8();
/** A coach's manager link, lowercase because it is compared lowercased when claimed — /coach/manage/{code} */
export const newManagerCode = customAlphabet("abcdefghjkmnpqrstuvwxyz23456789", 8);

/** The only key to a match's reel and to its upload on the reel host — never in a URL of this app. 32 characters. */
export const newReelToken = customAlphabet("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz", 32);

const codeRe = new RegExp(`^[${CODE_ALPHABET}]+$`);
export const isValidShareCode = (s: string) => s.length === 4 && codeRe.test(s);
export const isValidInviteCode = (s: string) => s.length === 6 && codeRe.test(s);
export const isValidManageCode = (s: string) => s.length === 10 && codeRe.test(s);
