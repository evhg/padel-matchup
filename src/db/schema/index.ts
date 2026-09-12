/**
 * The schema, split by domain. Every table, enum and row type is re-exported here, so
 * `@/db/schema` means what it always did and no import in the app had to change. A new
 * table goes in the file for its domain (or a new file named after it, listed below);
 * `drizzle.config.ts` reads this file.
 */
export * from "./enums";
export * from "./players";
export * from "./events";
export * from "./groups";
export * from "./clubs";
export * from "./coaching";
export * from "./channels";
export * from "./api";
export * from "./ops";
