import type { ReactNode } from "react";

export interface IconProps {
  size?: number;
  className?: string;
}

function SvgBase({
  size = 20,
  className,
  children,
}: IconProps & { children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.85}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      {children}
    </svg>
  );
}

export function IconWallet(props: IconProps) {
  return (
    <SvgBase {...props}>
      <path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H18a2 2 0 0 1 2 2v2" />
      <path d="M3 8.5v9A2.5 2.5 0 0 0 5.5 20H19a2 2 0 0 0 2-2v-6a2 2 0 0 0-2-2H5.5A2.5 2.5 0 0 1 3 7.5Z" />
      <circle cx="16.5" cy="14" r="1.25" fill="currentColor" stroke="none" />
    </SvgBase>
  );
}

export function IconNft(props: IconProps) {
  return (
    <SvgBase {...props}>
      <rect x="3.5" y="3.5" width="17" height="17" rx="3.5" />
      <path d="M8 15.5l2.8-3.4a1 1 0 0 1 1.54 0L14 14l1.4-1.6a1 1 0 0 1 1.52.02L19 15" />
      <circle cx="9" cy="9" r="1.3" fill="currentColor" stroke="none" />
    </SvgBase>
  );
}

export function IconActivity(props: IconProps) {
  return (
    <SvgBase {...props}>
      <path d="M3 12h4l2.5-6 4 12 2.5-6h5" />
    </SvgBase>
  );
}

export function IconAccounts(props: IconProps) {
  return (
    <SvgBase {...props}>
      <rect x="4" y="10" width="16" height="10" rx="2.5" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3" />
      <circle cx="12" cy="15" r="1.3" fill="currentColor" stroke="none" />
    </SvgBase>
  );
}

export function IconTelegram(props: IconProps) {
  return (
    <SvgBase {...props}>
      <path d="M21 4.5 3.6 11.4c-.9.35-.86 1.63.06 1.92l4.4 1.38 1.68 5.2c.25.78 1.24.97 1.77.35l2.58-2.98 4.48 3.24c.67.48 1.62.12 1.8-.69L22.2 5.7c.2-.85-.62-1.54-1.2-1.2Z" />
      <path d="M8.1 14.7 18.2 7.8" />
    </SvgBase>
  );
}

export function IconSend(props: IconProps) {
  return (
    <SvgBase {...props}>
      <path d="M7 17 17 7" />
      <path d="M8 7h9v9" />
    </SvgBase>
  );
}

export function IconReceive(props: IconProps) {
  return (
    <SvgBase {...props}>
      <path d="M17 7 7 17" />
      <path d="M16 17H7V8" />
    </SvgBase>
  );
}

export function IconSwap(props: IconProps) {
  return (
    <SvgBase {...props}>
      <path d="M7 7h12l-3-3" />
      <path d="M17 17H5l3 3" />
      <path d="M19 7l-3 3" />
      <path d="M5 17l3-3" />
    </SvgBase>
  );
}

export function IconShield(props: IconProps) {
  return (
    <SvgBase {...props}>
      <path d="M12 3 5 6.2v5.4c0 4.5 3 8.4 7 9.4 4-1 7-4.9 7-9.4V6.2L12 3Z" />
      <path d="m9.2 12.2 1.9 1.9 3.8-3.8" />
    </SvgBase>
  );
}

export function IconTools(props: IconProps) {
  return (
    <SvgBase {...props}>
      <path d="M4 7h10" />
      <path d="M18 7h2" />
      <circle cx="16" cy="7" r="2" />
      <path d="M4 17h4" />
      <path d="M12 17h8" />
      <circle cx="10" cy="17" r="2" />
    </SvgBase>
  );
}

export function IconBridge(props: IconProps) {
  return (
    <SvgBase {...props}>
      <path d="M3 16c2.5-5 5.5-7.5 9-7.5s6.5 2.5 9 7.5" />
      <path d="M6 16v3" />
      <path d="M12 8.5V19" />
      <path d="M18 16v3" />
      <path d="M3 19h18" />
    </SvgBase>
  );
}

export function IconLock(props: IconProps) {
  return (
    <SvgBase {...props}>
      <rect x="5" y="11" width="14" height="9" rx="2.5" />
      <path d="M8 11V7.5a4 4 0 0 1 8 0V11" />
    </SvgBase>
  );
}

export function IconRefresh(props: IconProps) {
  return (
    <SvgBase {...props}>
      <path d="M20 11a8 8 0 0 0-14.7-3.4" />
      <path d="M4 4v4h4" />
      <path d="M4 13a8 8 0 0 0 14.7 3.4" />
      <path d="M20 20v-4h-4" />
    </SvgBase>
  );
}

export function IconSparkles(props: IconProps) {
  return (
    <SvgBase {...props}>
      <path d="M12 3l1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6L12 3Z" />
      <path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8L19 15Z" />
    </SvgBase>
  );
}

export function IconCopy(props: IconProps) {
  return (
    <SvgBase {...props}>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15H4a1.5 1.5 0 0 1-1.5-1.5V4.5A1.5 1.5 0 0 1 4 3h9A1.5 1.5 0 0 1 14.5 4.5V6" />
    </SvgBase>
  );
}

export function IconCheck(props: IconProps) {
  return (
    <SvgBase {...props}>
      <path d="m5 12.5 4.5 4.5L19 7.5" />
    </SvgBase>
  );
}

export function IconClose(props: IconProps) {
  return (
    <SvgBase {...props}>
      <path d="M6 6 18 18" />
      <path d="M18 6 6 18" />
    </SvgBase>
  );
}

export function IconChevronRight(props: IconProps) {
  return (
    <SvgBase {...props}>
      <path d="m9 6 6 6-6 6" />
    </SvgBase>
  );
}

export function IconExternalLink(props: IconProps) {
  return (
    <SvgBase {...props}>
      <path d="M14 5h5v5" />
      <path d="M10 14 19 5" />
      <path d="M19 13v5a1.5 1.5 0 0 1-1.5 1.5h-12A1.5 1.5 0 0 1 4 18V6.5A1.5 1.5 0 0 1 5.5 5H11" />
    </SvgBase>
  );
}

export function IconKey(props: IconProps) {
  return (
    <SvgBase {...props}>
      <circle cx="8" cy="14" r="3.5" />
      <path d="m11 11.5 8.5-8.5" />
      <path d="m16.5 6 2.5 2.5" />
      <path d="m14 8.5 2 2" />
    </SvgBase>
  );
}

export function IconFingerprint(props: IconProps) {
  return (
    <SvgBase {...props}>
      <path d="M12 10.5v4.5" />
      <path d="M8.5 12a3.5 3.5 0 0 1 7 0v3.5" />
      <path d="M5.5 11.5a6.5 6.5 0 0 1 13 0v3" />
      <path d="M9 18.5c1.8-.6 3-2.3 3-4.3" />
      <path d="M12 4.5A7.5 7.5 0 0 1 19.5 12" />
    </SvgBase>
  );
}

export function IconGlobe(props: IconProps) {
  return (
    <SvgBase {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M3.5 9h17" />
      <path d="M3.5 15h17" />
      <path d="M12 3a13 13 0 0 1 0 18" />
      <path d="M12 3a13 13 0 0 0 0 18" />
    </SvgBase>
  );
}

export function IconLayers(props: IconProps) {
  return (
    <SvgBase {...props}>
      <path d="m12 4 8.5 4.2L12 12.4 3.5 8.2 12 4Z" />
      <path d="m3.5 12.2 8.5 4.2 8.5-4.2" />
      <path d="m3.5 16.2 8.5 4.2 8.5-4.2" />
    </SvgBase>
  );
}

export function IconArrowUpRight(props: IconProps) {
  return (
    <SvgBase {...props}>
      <path d="M7 17 17 7" />
      <path d="M9 7h8v8" />
    </SvgBase>
  );
}

export function IconArrowDownLeft(props: IconProps) {
  return (
    <SvgBase {...props}>
      <path d="M17 7 7 17" />
      <path d="M15 17H7V9" />
    </SvgBase>
  );
}

export function IconZap(props: IconProps) {
  return (
    <SvgBase {...props}>
      <path d="M13 3 4.5 13.5H11l-1 7.5 8.5-10.5H12l1-7.5Z" />
    </SvgBase>
  );
}

export function IconPlug(props: IconProps) {
  return (
    <SvgBase {...props}>
      <path d="M9 4v4" />
      <path d="M15 4v4" />
      <path d="M7 8h10v3.5a5 5 0 0 1-10 0V8Z" />
      <path d="M12 16.5V21" />
    </SvgBase>
  );
}
