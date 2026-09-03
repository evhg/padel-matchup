import { customAlphabet } from "nanoid";

/** Unambiguous alphabet: no 0/O/1/l/I. */
export const CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

const gen4 = customAlphabet(CODE_ALPHABET, 4);
const gen6 = customAlphabet(CODE_ALPHABET, 6);
const gen10 = customAlphabet(CODE_ALPHABET, 10);

/** Public share code — /{code} */
export const newShareCode = () => gen4();
/** Personal invite code — /{code}/i/{invite} */
export const newInviteCode = () => gen6();
/** Organizer secret — /{code}/manage/{manage}. Never shorter than 10. */
export const newManageCode = () => gen10();

const codeRe = new RegExp(`^[${CODE_ALPHABET}]+$`);
export const isValidShareCode = (s: string) => s.length === 4 && codeRe.test(s);
export const isValidInviteCode = (s: string) => s.length === 6 && codeRe.test(s);
export const isValidManageCode = (s: string) => s.length === 10 && codeRe.test(s);
