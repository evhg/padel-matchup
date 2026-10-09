/**
 * The width a text field needs to show its placeholder whole, as a CSS length: about 0.6em a character
 * (measured in Chromium: "you@example.com" is 0.57em a character, "tu@ejemplo.com" 0.54em), plus the
 * padding of `.input` and its border. A field beside a button takes it as its minimum width, and the
 * row wraps, so the button goes under the field when both do not fit. Without it "you@example.com"
 * read "you@example.c" beside "Send code" with Bigger text, and in Russian at the normal size.
 */
export const placeholderWidth = (placeholder: string) => `calc(${(placeholder.length * 0.6).toFixed(1)}em + 2rem + 2px)`;
