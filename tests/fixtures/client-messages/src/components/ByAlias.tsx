"use client";
import { useT } from "../i18n/client";

export function ByAlias() {
  const t = useT("feedback");
  return <p>{t("title")}</p>;
}
