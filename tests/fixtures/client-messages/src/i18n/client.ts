// A file of our own that passes next-intl's readers on. The hook keeps its types, so nothing but the
// guard can see that a component which imports it from here translates.
export { useMessages, useTranslations, useTranslations as useT } from "next-intl";
