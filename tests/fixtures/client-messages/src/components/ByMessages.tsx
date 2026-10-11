"use client";
import { useMessages } from "../i18n/client";

export function ByMessages() {
  return <p>{Object.keys(useMessages()).length}</p>;
}
