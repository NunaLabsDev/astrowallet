export interface AstroWalletLogoProps {
  size?: number;
}

/**
 * Original 32x32 crisp-pixel Sovereign Vault Shield + 4-Point Stellar Key Star emblem.
 * Engineered in banking-trust Sovereign Navy, Royal Amethyst, Vault Gold, and Solar Blaze.
 */
export function AstroWalletLogo({ size = 38 }: AstroWalletLogoProps) {
  return (
    <div className="aw-pixel-frame" aria-hidden="true">
      <svg
        width={size}
        height={size}
        viewBox="0 0 32 32"
        shapeRendering="crispEdges"
        role="img"
        aria-label="AstroWallet Shield Emblem"
      >
        <rect width="32" height="32" rx="5" fill="#060E24" />
        {/* Sovereign Navy Shield Body */}
        <path
          fill="#172C69"
          d="M6 4h20v2h2v12h-2v4h-2v2h-2v2h-2v2h-8v-2h-2v-2H8v-2H6v-4H4V6h2V4z"
        />
        {/* Royal Amethyst Inner Armor Ring */}
        <path
          fill="#8050C8"
          d="M8 6h16v2h2v9h-2v3h-2v2h-2v2h-8v-2h-2v-2H8v-3H6V8h2V6z"
        />
        {/* Deep Vault Core */}
        <path
          fill="#0D1B44"
          d="M10 8h12v2h2v6h-2v3h-2v2h-8v-2h-2v-3H8v-6h2V8z"
        />
        {/* Specular Top Rim */}
        <path fill="#A58BE0" d="M8 6h16v1H8z" />
        {/* Corner Security Rivets */}
        <path fill="#F5C928" d="M7 7h1v1H7zm17 0h1v1h-1z" />
        {/* Animated 4-Point Stellar Key Star */}
        <g className="aw-logo-star">
          <path
            fill="#F5C928"
            d="M15 9h2v4h2v2h4v2h-4v2h-2v4h-2v-4h-2v-2H9v-2h4v-2h2V9z"
          />
          <path fill="#F15A24" d="M15 15h2v2h-2z" />
        </g>
      </svg>
    </div>
  );
}
