import { useEffect, useState } from "react";

export interface TokenBadgeProps {
  code: string;
  icon?: string | undefined;
  size?: number | undefined;
  trustStatus?: "official" | "scam_spoof" | "unverified" | undefined;
}

/**
 * Renders an official SEP-42 / SEP-1 stellar.toml HTTPS token logo, the authentic
 * Stellar Lumens (XLM) vector emblem for native XLM, or a monogram fallback badge.
 */
export function TokenBadge({
  code,
  icon,
  size = 38,
  trustStatus,
}: TokenBadgeProps) {
  const [imgFailed, setImgFailed] = useState(false);

  useEffect(() => {
    setImgFailed(false);
  }, [icon]);

  const ringColor =
    trustStatus === "scam_spoof"
      ? "rgba(239, 68, 68, 0.72)"
      : trustStatus === "official"
        ? "rgba(16, 185, 129, 0.65)"
        : "rgba(245, 201, 40, 0.45)";

  if (icon && !imgFailed) {
    return (
      <img
        src={icon}
        alt={`${code} logo`}
        width={size}
        height={size}
        onError={() => setImgFailed(true)}
        style={{
          width: size,
          height: size,
          borderRadius: "999px",
          objectFit: "cover",
          border: `1.5px solid ${ringColor}`,
          background: "rgba(6, 14, 36, 0.85)",
          flexShrink: 0,
        }}
      />
    );
  }

  if (code.trim().toUpperCase() === "XLM" && trustStatus !== "scam_spoof") {
    return (
      <span
        aria-label="Stellar Lumens XLM"
        style={{
          width: size,
          height: size,
          borderRadius: "999px",
          border: `1.5px solid ${ringColor}`,
          background: "radial-gradient(circle at 30% 25%, #172C69 0%, #060E24 100%)",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
          boxShadow: "0 2px 10px rgba(6, 14, 36, 0.45)",
        }}
      >
        <svg
          width={Math.round(size * 0.62)}
          height={Math.round(size * 0.62)}
          viewBox="0 0 24 24"
          fill="none"
          aria-hidden="true"
        >
          <path
            d="M19.2 4.6 5.4 11.7a7.3 7.3 0 0 1 11.5-5.6l2.3-1.5Zm-14.4 14.8 13.8-7.1a7.3 7.3 0 0 1-11.5 5.6l-2.3 1.5Z"
            fill="#F8FAFF"
          />
          <path
            d="M3.5 14.3 20.5 5.6M3.5 17.5 20.5 8.8"
            stroke="#F5C928"
            strokeWidth="1.9"
            strokeLinecap="round"
          />
        </svg>
      </span>
    );
  }

  return (
    <span
      className="aw-asset-badge"
      style={{
        width: size,
        height: size,
        fontSize: size >= 44 ? 13 : 11,
        borderColor: ringColor,
        flexShrink: 0,
      }}
    >
      {code.slice(0, 4)}
    </span>
  );
}
