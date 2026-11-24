import { useEffect, useMemo, useState } from "react";

export interface TokenBadgeProps {
  code: string;
  icon?: string | undefined;
  fallbackIcon?: string | undefined;
  isNative?: boolean | undefined;
  size?: number | undefined;
  trustStatus?: "official" | "scam_spoof" | "unverified" | undefined;
}

/**
 * Renders an official SEP-1 `stellar.toml` / SEP-42 HTTPS token logo, the authentic
 * Stellar Lumens (XLM) vector emblem for native XLM, or a clear `?` no-image badge
 * when no real image exists. Never fabricates or substitutes fake token logos.
 */
function normalizeBadgeUrl(raw: string | undefined): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.startsWith("https://")) return trimmed;
  if (trimmed.startsWith("ipfs://")) {
    const cidPath = trimmed.slice("ipfs://".length).replace(/^ipfs\//, "");
    return cidPath ? `https://ipfs.io/ipfs/${cidPath}` : null;
  }
  return null;
}

export function TokenBadge({
  code,
  icon,
  fallbackIcon,
  isNative,
  size = 38,
  trustStatus,
}: TokenBadgeProps) {
  const candidates = useMemo(() => {
    const urls = [normalizeBadgeUrl(icon), normalizeBadgeUrl(fallbackIcon)].filter(
      (u): u is string => u !== null,
    );
    return Array.from(new Set(urls));
  }, [icon, fallbackIcon]);

  const [candidateIdx, setCandidateIdx] = useState(0);

  useEffect(() => {
    setCandidateIdx(0);
  }, [icon, fallbackIcon]);

  const neutralBorder = "1px solid rgba(255, 255, 255, 0.14)";
  const dotColor =
    trustStatus === "scam_spoof"
      ? "#ef4444"
      : trustStatus === "official"
        ? "#10b981"
        : null;

  const activeUrl = candidates[candidateIdx];
  if (activeUrl) {
    return (
      <span
        style={{
          position: "relative",
          width: size,
          height: size,
          borderRadius: "999px",
          border: neutralBorder,
          background: "rgba(248, 250, 255, 0.08)",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
        }}
      >
        <img
          src={activeUrl}
          alt={`${code} logo`}
          width={size}
          height={size}
          referrerPolicy="no-referrer"
          loading="lazy"
          onError={() => setCandidateIdx((idx) => idx + 1)}
          style={{
            width: "100%",
            height: "100%",
            objectFit: "contain",
            display: "block",
            borderRadius: "999px",
          }}
        />
        {dotColor && (
          <span
            aria-hidden="true"
            style={{
              position: "absolute",
              right: -1,
              bottom: -1,
              width: Math.max(8, Math.round(size * 0.26)),
              height: Math.max(8, Math.round(size * 0.26)),
              borderRadius: "999px",
              background: dotColor,
              border: "1.5px solid #060E24",
            }}
          />
        )}
      </span>
    );
  }

  if (
    (isNative || (isNative === undefined && code.trim().toUpperCase() === "XLM")) &&
    trustStatus !== "scam_spoof"
  ) {
    return (
      <span
        aria-label="Stellar Lumens XLM"
        style={{
          position: "relative",
          width: size,
          height: size,
          borderRadius: "999px",
          border: neutralBorder,
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
      className={`aw-token-no-image ${trustStatus === "scam_spoof" ? "aw-token-no-image--danger" : ""}`}
      title={`${code}: No official image in stellar.toml`}
      aria-label={`${code} — no token image`}
      style={{
        width: size,
        height: size,
        fontSize: Math.max(11, Math.round(size * 0.44)),
        flexShrink: 0,
      }}
    >
      ?
    </span>
  );
}
