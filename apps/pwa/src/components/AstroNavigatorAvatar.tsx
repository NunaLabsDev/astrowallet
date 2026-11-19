import type { AccountKind } from "@astrowallet/domain";

export type NavigatorState = "float" | "shield" | "warp" | "vault" | "comms" | "zenith";

export type VisorGeometry = "Orbital Dome" | "Hex Visor" | "Prism Split" | "Nova Crest";
export type ArmorTintName = "Solar Blaze" | "Cosmic Purple" | "Stellar Gold" | "Nebula Lavender";
export type OrbitalHaloName = "Single Ring" | "Twin Orbit" | "Nebula Flare" | "Shield Grid";

export interface NavigatorTraits {
  digest: number;
  visorIndex: number;
  visorName: VisorGeometry;
  armorIndex: number;
  armorName: ArmorTintName;
  armorHex: string;
  constellationIndex: number;
  haloIndex: number;
  haloName: OrbitalHaloName;
  frameKind: AccountKind;
}

export interface AstroNavigatorAvatarProps {
  seedKey: string;
  kind: AccountKind;
  state?: NavigatorState;
  size?: number;
}

const VISOR_NAMES: readonly VisorGeometry[] = [
  "Orbital Dome",
  "Hex Visor",
  "Prism Split",
  "Nova Crest",
];

const ARMOR_PALETTE: ReadonlyArray<{
  name: ArmorTintName;
  hex: string;
  shade: string;
  inkHighlight: string;
}> = [
  { name: "Solar Blaze", hex: "#F15A24", shade: "#B83B12", inkHighlight: "#FFB396" },
  { name: "Cosmic Purple", hex: "#8050C8", shade: "#532B94", inkHighlight: "#D4C2FF" },
  { name: "Stellar Gold", hex: "#F5C928", shade: "#BD9410", inkHighlight: "#FFF2B2" },
  { name: "Nebula Lavender", hex: "#A58BE0", shade: "#6E55AB", inkHighlight: "#ECE5FF" },
];

const HALO_NAMES: readonly OrbitalHaloName[] = [
  "Single Ring",
  "Twin Orbit",
  "Nebula Flare",
  "Shield Grid",
];

function fnv1a32(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Derives deterministic Astro Navigator visual traits from an account key and role kind.
 */
export function deriveNavigatorTraits(seedKey: string, kind: AccountKind): NavigatorTraits {
  const digest = fnv1a32(`${kind}:${seedKey}`);
  const visorIndex = digest % 4;
  const armorIndex = (digest >>> 2) % 4;
  const constellationIndex = (digest >>> 4) % 16;
  const haloIndex = (digest >>> 8) % 4;
  const armor = ARMOR_PALETTE[armorIndex] ?? ARMOR_PALETTE[0]!;

  return {
    digest,
    visorIndex,
    visorName: VISOR_NAMES[visorIndex] ?? "Orbital Dome",
    armorIndex,
    armorName: armor.name,
    armorHex: armor.hex,
    constellationIndex,
    haloIndex,
    haloName: HALO_NAMES[haloIndex] ?? "Single Ring",
    frameKind: kind,
  };
}

function renderPixelConstellationSigil(index: number) {
  const variant = index % 16;
  const bucket = variant % 4;
  const pipX = 14 + (variant & 3);
  const pipY = 25 + ((variant >>> 2) & 1);

  if (bucket === 0) {
    // 4-point Stellar star crest
    return (
      <g>
        <path fill="#F5C928" d="M15 24h2v1h1v2h-1v1h-2v-1h-1v-2h1v-1z" />
        <rect x={pipX} y={pipY} width="1" height="1" fill="#F8FAFF" />
      </g>
    );
  }
  if (bucket === 1) {
    // Dual vault chevron
    return (
      <g>
        <path fill="#F5C928" d="M13 24h2v1h-2v-1zm4 0h2v1h-2v-1zm-2 1h2v2h-2v-2zm-2 2h2v1h-2v-1zm4 0h2v1h-2v-1z" />
        <rect x={pipX} y={pipY} width="1" height="1" fill="#F8FAFF" />
      </g>
    );
  }
  if (bucket === 2) {
    // Orbital triangle sigil
    return (
      <g>
        <path fill="#F5C928" d="M15 24h2v1h-2v-1zm-1 1h1v2h-1v-2zm3 0h1v2h-1v-2zm-4 2h6v1h-6v-1z" />
        <rect x={pipX} y={pipY} width="1" height="1" fill="#F8FAFF" />
      </g>
    );
  }
  // Constellation triad
  return (
    <g>
      <rect x="13" y="25" width="1" height="1" fill="#F5C928" />
      <rect x="18" y="25" width="1" height="1" fill="#F5C928" />
      <rect x="15" y="27" width="2" height="1" fill="#F8FAFF" />
      <rect x={pipX} y="24" width="1" height="1" fill="#F5C928" />
    </g>
  );
}

/**
 * Deterministic, 100% original Astro Navigator collectible 32x32 crisp-pixel SVG avatar.
 * Inspired by NunaLabs Sorobits 32x32 precision while tailored to Stellar banking-trust custody.
 */
export function AstroNavigatorAvatar({
  seedKey,
  kind,
  state = "float",
  size = 84,
}: AstroNavigatorAvatarProps) {
  const traits = deriveNavigatorTraits(seedKey, kind);
  const armorSpec = ARMOR_PALETTE[traits.armorIndex] ?? ARMOR_PALETTE[0]!;
  const cornerAccent = kind === "smart" ? "#8050C8" : "#F5C928";
  const rimAccent =
    state === "zenith" || state === "warp"
      ? "#F5C928"
      : kind === "smart"
        ? "#A58BE0"
        : "#F5C928";

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      shapeRendering="crispEdges"
      role="img"
      aria-label={`Astro Navigator (${kind}, ${traits.visorName}, state ${state})`}
      className={`nav-state-${state}`}
    >
      {/* Sovereign Deep Navy Pixel Canvas */}
      <rect width="32" height="32" rx="5" fill="#060E24" />
      <rect x="1" y="1" width="30" height="30" rx="4" fill="#0B1638" />
      <rect x="2" y="2" width="28" height="13" fill="#112254" opacity="0.72" />

      {/* Deterministic subtle starfield pixels */}
      <rect x="4" y="4" width="1" height="1" fill="#A58BE0" />
      <rect x="27" y="5" width="1" height="1" fill="#F5C928" />
      <rect x="5" y="21" width="1" height="1" fill="#A58BE0" opacity="0.6" />
      <rect x="26" y="20" width="1" height="1" fill="#F8FAFF" opacity="0.6" />

      {/* Role Frame Corner Brackets (Classic G... Gold Vault vs Smart C... Amethyst) */}
      <path
        fill={cornerAccent}
        d="M2 2h4v1H3v3H2V2zm24 0h4v4h-1V3h-3V2zM2 26h1v3h3v1H2v-4zm27 0h1v4h-4v-1h3v-3z"
      />
      <rect
        x="1"
        y="1"
        width="30"
        height="30"
        rx="4"
        fill="none"
        stroke={rimAccent}
        strokeOpacity="0.35"
        strokeWidth="1"
      />

      {/* 4 Deterministic Pixel Orbital Halos */}
      {traits.haloIndex === 0 && (
        <path
          fill="#F5C928"
          fillOpacity="0.7"
          d="M5 10h2v1H5v-1zm2-1h2v1H7V9zm16 5h2v1h-2v-1zm2-1h2v1h-2v-1z"
        />
      )}
      {traits.haloIndex === 1 && (
        <g>
          <path fill="#A58BE0" d="M4 9h2v1H4V9zm22 0h2v1h-2V9z" />
          <path fill="#F5C928" d="M5 18h1v1H5v-1zm21 0h1v1h-1v-1z" />
        </g>
      )}
      {traits.haloIndex === 2 && (
        <g fill="#A58BE0">
          <rect x="6" y="7" width="1" height="1" />
          <rect x="25" y="7" width="1" height="1" />
          <rect x="4" y="14" width="1" height="1" fill="#F5C928" />
          <rect x="27" y="14" width="1" height="1" fill="#F5C928" />
        </g>
      )}
      {traits.haloIndex === 3 && (
        <path
          fill="#F5C928"
          fillOpacity="0.45"
          d="M8 4h16v1H8V4zM6 6h2v1H6V6zm18 0h2v1h-2V6zM5 8h1v12H5V8zm21 0h1v12h-1V8z"
        />
      )}

      {/* Pixel Pilot Shoulders & Suit Armor (rows 22..30) */}
      <path
        fill="#060E24"
        d="M8 21h16v1h2v2h1v6H5v-6h1v-2h2v-1z"
      />
      <path
        fill={armorSpec.hex}
        d="M8 22h16v1h1v2h1v5H6v-5h1v-2h1v-1z"
      />
      {/* Armor shading & specular shoulder rim */}
      <path fill={armorSpec.inkHighlight} d="M9 22h14v1H9z" />
      <path fill={armorSpec.shade} d="M6 26h3v4H6v-4zm17 0h3v4h-3v-4z" />
      {/* Dark chest plate */}
      <rect x="11" y="23" width="10" height="6" fill="#0D1B44" />

      {/* 16 Constellation Chest Sigils */}
      {renderPixelConstellationSigil(traits.constellationIndex)}

      {/* Pixel Armored Helmet Shell (rows 6..21) */}
      <path
        fill="#060E24"
        d="M11 6h10v1h2v1h1v2h1v8h-1v2h-1v1H9v-1H8v-2H7v-8h1V8h1V7h2V6z"
      />
      <path
        fill="#172C69"
        d="M11 7h10v1h2v2h1v8h-1v2H9v-2H8v-8h1V8h2V7z"
      />
      {/* Helmet top specular rim */}
      <path fill="#A58BE0" d="M11 7h10v1H11zM9 8h2v1H9zm12 0h2v1h-2z" />
      {/* Helmet side crest */}
      <rect x="8" y="12" width="1" height="4" fill={cornerAccent} />
      <rect x="23" y="12" width="1" height="4" fill={cornerAccent} />

      {/* 4 Pixel Visor Geometries */}
      {traits.visorIndex === 0 && (
        <g>
          <path fill="#060E24" d="M10 10h12v1h1v5h-1v1H10v-1H9v-5h1v-1z" />
          <path fill="#8050C8" d="M10 11h12v5H10v-5z" />
          <path fill="#172C69" d="M11 12h10v3H11v-3z" />
          <rect x="11" y="11" width="4" height="1" fill="#F8FAFF" />
          <rect x="12" y="13" width="2" height="1" fill="#F5C928" />
          <rect x="18" y="13" width="2" height="1" fill="#F5C928" />
        </g>
      )}
      {traits.visorIndex === 1 && (
        <g>
          <path fill="#F5C928" d="M11 10h10v1h2v5h-2v1H11v-1H9v-5h2v-1z" />
          <path fill="#172C69" d="M11 11h10v5H11v-5z" />
          <rect x="12" y="12" width="3" height="1" fill="#A58BE0" />
          <rect x="12" y="14" width="8" height="1" fill="#F15A24" />
        </g>
      )}
      {traits.visorIndex === 2 && (
        <g>
          <rect x="9" y="11" width="14" height="5" fill="#060E24" />
          <rect x="10" y="12" width="5" height="3" fill="#8050C8" />
          <rect x="17" y="12" width="5" height="3" fill="#8050C8" />
          <rect x="11" y="13" width="3" height="1" fill="#F5C928" />
          <rect x="18" y="13" width="3" height="1" fill="#F5C928" />
          <rect x="15" y="12" width="2" height="3" fill="#172C69" />
        </g>
      )}
      {traits.visorIndex === 3 && (
        <g>
          <rect x="9" y="11" width="14" height="5" fill="#F15A24" />
          <rect x="10" y="12" width="12" height="3" fill="#0D1B44" />
          <rect x="11" y="12" width="5" height="1" fill="#F8FAFF" />
          <rect x="11" y="13" width="10" height="1" fill="#A58BE0" />
        </g>
      )}

      {/* 6 Behavioral State Pixel Overlays */}
      {state === "float" && (
        <rect x="24" y="23" width="1" height="1" fill="#10B981" />
      )}
      {state === "shield" && (
        <g>
          <path
            fill="#F5C928"
            d="M23 12h6v1h1v5h-1v2h-1v1h-4v-1h-1v-2h-1v-5h1v-1z"
          />
          <path
            fill="#8050C8"
            d="M24 13h4v5h-1v2h-2v-2h-1v-5z"
          />
          <rect x="25" y="15" width="2" height="2" fill="#F8FAFF" />
        </g>
      )}
      {state === "warp" && (
        <g>
          <path fill="#F15A24" d="M2 19h4v1H2v-1zm1 2h4v1H3v-1z" />
          <path fill="#F5C928" d="M4 20h3v1H4v-1zm1 2h2v1H5v-1z" />
        </g>
      )}
      {state === "vault" && (
        <g>
          <rect x="22" y="19" width="7" height="7" fill="#F5C928" />
          <rect x="23" y="20" width="5" height="5" fill="#172C69" />
          <rect x="25" y="21" width="1" height="3" fill="#F5C928" />
        </g>
      )}
      {state === "comms" && (
        <g fill="#F5C928">
          <rect x="24" y="7" width="2" height="1" />
          <rect x="26" y="8" width="1" height="2" />
          <path fill="#A58BE0" d="M25 5h3v1h-3V5zm3 1h1v3h-1V6z" />
        </g>
      )}
      {state === "zenith" && (
        <path
          fill="#F5C928"
          d="M26 3h1v2h2v1h-2v2h-1V6h-2V5h2V3z"
        />
      )}
    </svg>
  );
}
