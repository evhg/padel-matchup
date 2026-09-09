"use client";

import { useRef, useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { addPhotoAction, removePhotoAction } from "@/actions/photos";

/**
 * "Add the court photo": the browser shrinks it to a card-sized JPEG before it leaves the
 * phone, so a 12 MB photo becomes a few hundred kilobytes. Offered once; never nagged.
 */
export function PhotoButton({ code, hasPhoto, canRemove }: { code: string; hasPhoto: boolean; canRemove: boolean }) {
  const t = useTranslations("card");
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const shrink = (file: File): Promise<string> =>
    new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        const max = 1400;
        const scale = Math.min(1, max / Math.max(img.width, img.height));
        const canvas = document.createElement("canvas");
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        const ctx = canvas.getContext("2d");
        if (!ctx) return reject(new Error("canvas"));
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        URL.revokeObjectURL(url);
        let q = 0.82;
        let out = canvas.toDataURL("image/jpeg", q);
        while (out.length > 900_000 && q > 0.4) {
          q -= 0.1;
          out = canvas.toDataURL("image/jpeg", q);
        }
        resolve(out);
      };
      img.onerror = () => reject(new Error("decode"));
      img.src = url;
    });

  const pick = (file: File | undefined) => {
    if (!file) return;
    setError(null);
    start(async () => {
      try {
        const dataUrl = await shrink(file);
        const r = await addPhotoAction(code, dataUrl);
        if (!r.ok) {
          setError(t("photoFailed"));
          return;
        }
        router.refresh();
      } catch {
        setError(t("photoFailed"));
      }
    });
  };

  if (hasPhoto) {
    if (!canRemove) return null;
    return (
      <button type="button" className="text-xs text-faint hover:text-muted" disabled={pending} onClick={() => start(async () => { await removePhotoAction(code); router.refresh(); })} data-testid="photo-remove">
        {t("removePhoto")}
      </button>
    );
  }
  return (
    <div className="flex flex-col gap-1">
      <input ref={inputRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={(e) => pick(e.target.files?.[0])} data-testid="photo-input" />
      <button type="button" className="btn-secondary w-full" disabled={pending} onClick={() => inputRef.current?.click()} data-testid="photo-add">
        {pending ? "…" : `📷 ${t("addPhoto")}`}
      </button>
      <p className="text-xs text-faint">{t("photoHelp")}</p>
      {error && <p className="text-xs font-semibold text-danger">{error}</p>}
    </div>
  );
}
