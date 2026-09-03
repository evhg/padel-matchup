import { ImageResponse } from "next/og";
import type { NextRequest } from "next/server";

export const dynamic = "force-static";

/** PNG app icon for the web manifest / home screen. ?size=192|512, &maskable=1 adds safe-zone padding. */
export function GET(req: NextRequest) {
  const size = Math.min(1024, Math.max(48, Number(req.nextUrl.searchParams.get("size") ?? 512) || 512));
  const maskable = req.nextUrl.searchParams.get("maskable") === "1";
  const pad = maskable ? size * 0.12 : 0;
  const inner = size - pad * 2;
  return new ImageResponse(
    (
      <div style={{ width: size, height: size, display: "flex", alignItems: "center", justifyContent: "center", background: maskable ? "#14161A" : "transparent" }}>
        <div style={{ width: inner, height: inner, borderRadius: maskable ? 0 : inner * 0.22, background: "#14161A", display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div style={{ width: inner * 0.56, height: inner * 0.56, borderRadius: inner, background: "#C8F135", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <div style={{ width: inner * 0.34, height: inner * 0.34, borderRadius: inner, border: `${Math.max(3, inner * 0.045)}px solid #14161A`, display: "flex" }} />
          </div>
        </div>
      </div>
    ),
    { width: size, height: size, headers: { "Cache-Control": "public, max-age=31536000, immutable" } },
  );
}
