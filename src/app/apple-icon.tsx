import { ImageResponse } from "next/og";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
  return new ImageResponse(
    (
      <div style={{ width: 180, height: 180, display: "flex", alignItems: "center", justifyContent: "center", background: "#14161A" }}>
        <div style={{ width: 100, height: 100, borderRadius: 100, background: "#C8F135", display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div style={{ width: 60, height: 60, borderRadius: 60, border: "8px solid #14161A", display: "flex" }} />
        </div>
      </div>
    ),
    size,
  );
}
