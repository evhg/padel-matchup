import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement, type ReactElement } from "react";
import { renderToString } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";

/** One locale's whole catalogue, read from the file the app ships. */
export const catalogue = (locale: "en" | "ru" | "es") => JSON.parse(readFileSync(path.resolve(process.cwd(), "messages", `${locale}.json`), "utf8")) as Record<string, unknown>;

/**
 * A component's HTML as the server renders it, inside the provider a page gives its client components.
 * For the words and the markup a screen shows; the browser suites prove what a tap does.
 */
export const renderIn = (locale: "en" | "ru" | "es", element: ReactElement): string => renderToString(createElement(NextIntlClientProvider, { locale, messages: catalogue(locale), children: element }));
