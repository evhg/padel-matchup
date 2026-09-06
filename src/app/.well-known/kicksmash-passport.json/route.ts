import { json, options } from "@/lib/api/http";
import { baseUrl } from "@/lib/config";
import { passportKeysDocument } from "@/lib/domain/passport";
import { passportKeys } from "@/lib/domain/profile";

export const dynamic = "force-dynamic";

/** The public key that signs player passports, JWKS-style, plus the exact bytes the signature covers. */
export async function GET() {
  const keys = passportKeys();
  const base = baseUrl();
  if (!keys) return json({ issuer: base, keys: [], docs: `${base}/developers#passport`, note: "This deployment signs no passports (PASSPORT_PRIVATE_KEY and PASSPORT_PUBLIC_KEY are not set)." }, { cache: "public, max-age=3600" });
  return json(passportKeysDocument(base, keys.pub), { cache: "public, max-age=3600" });
}

export async function OPTIONS() {
  return options();
}
