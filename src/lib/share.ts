/** Messenger deep links. The app never sends messages itself (decision 5). */

export function whatsappShareUrl(text: string, phone?: string | null): string {
  const digits = (phone ?? "").replace(/[^\d]/g, "");
  return digits ? `https://wa.me/${digits}?text=${encodeURIComponent(text)}` : `https://wa.me/?text=${encodeURIComponent(text)}`;
}

export function telegramShareUrl(url: string, text: string): string {
  return `https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(text)}`;
}

export const eventUrl = (base: string, code: string) => `${base}/${code}`;
export const inviteUrl = (base: string, code: string, inviteCode: string) => `${base}/${code}/i/${inviteCode}`;
export const manageUrl = (base: string, code: string, manageCode: string) => `${base}/${code}/manage/${manageCode}`;
