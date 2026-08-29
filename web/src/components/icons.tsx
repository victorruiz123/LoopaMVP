/**
 * Ikoner som SVG, inte emoji.
 *
 * Emoji ritas av operativsystemet: 🔍 är en blå lupp på iOS, en grå på Android och en helt annan sak i
 * Windows-fonten. Det gör att en detalj mitt i ett formulär byter färg och form beroende på var den
 * visas, och den kan aldrig ärva textfärgen. De här ärver `currentColor` och ser likadana ut överallt.
 */

const base = {
  fill: "none" as const,
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

export function SearchIcon({ size = 17 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" {...base}>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.6-3.6" />
    </svg>
  );
}

export function CloseIcon({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" {...base} strokeWidth={2.2}>
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

export function ChevronRight({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" {...base} strokeWidth={2.2}>
      <path d="m9 5 7 7-7 7" />
    </svg>
  );
}

export function CheckIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" {...base} strokeWidth={2.6}>
      <path d="m5 12.5 4.5 4.5L19 7" />
    </svg>
  );
}

export function PlusIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" {...base} strokeWidth={2.2}>
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

export function MailIcon({ size = 17 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" {...base}>
      <rect x="2.5" y="5" width="19" height="14" rx="2.5" />
      <path d="m3 7 8.1 5.4a1.7 1.7 0 0 0 1.8 0L21 7" />
    </svg>
  );
}

export function LockIcon({ size = 17 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" {...base}>
      <rect x="4" y="10" width="16" height="10.5" rx="2.5" />
      <path d="M8 10V7.5a4 4 0 0 1 8 0V10" />
    </svg>
  );
}

export function EyeIcon({ size = 17 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" {...base}>
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

export function EyeOffIcon({ size = 17 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" {...base}>
      <path d="M10.6 6.1A8.9 8.9 0 0 1 12 6c6 0 9.5 6 9.5 6a16 16 0 0 1-3 3.6M6.4 7.8A15.9 15.9 0 0 0 2.5 12S6 18 12 18a8.8 8.8 0 0 0 3.4-.66" />
      <path d="m3 3 18 18" />
    </svg>
  );
}

export function UserIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" {...base}>
      <circle cx="12" cy="8" r="3.6" />
      <path d="M4.5 20a7.5 7.5 0 0 1 15 0" />
    </svg>
  );
}

/** Två personer: adminpanelen, som handlar om konton och inte om ett konto. */
export function UsersIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" {...base}>
      <circle cx="9" cy="8" r="3.2" />
      <path d="M2.8 19.5a6.4 6.4 0 0 1 12.4 0" />
      <path d="M16.2 5.2a3.2 3.2 0 0 1 0 5.6" />
      <path d="M17.6 14.2a6.4 6.4 0 0 1 3.6 5.3" />
    </svg>
  );
}

export function ArrowLeftIcon({ size = 17 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" {...base} strokeWidth={2.2}>
      <path d="M19 12H5m0 0 6-6m-6 6 6 6" />
    </svg>
  );
}

export function CardIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" {...base}>
      <rect x="3" y="4.5" width="18" height="15" rx="2.5" />
      <path d="M3 9.5h18M7 14h5" />
    </svg>
  );
}

/**
 * Kortet med luppen: sök upp ett truth-card på dess Loopa-ID.
 *
 * Skild från den vanliga luppen med flit. De två söker olika saker på samma skärm — märken i listan,
 * och ett enskilt publikt kort någon annanstans i Loopa — och en lupp som betyder två saker är ingen
 * ikon utan en gissning.
 */
export function CardSearchIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" {...base}>
      <path d="M21 11.5v-6A2 2 0 0 0 19 3.5H5a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h6" />
      <path d="M3 8.5h18" />
      <circle cx="16.5" cy="16.5" r="3.5" />
      <path d="m19.4 19.4 1.9 1.9" />
    </svg>
  );
}

/** Kopiera. Två ark, det främre förskjutet — samma bild som i alla system den här appen körs i. */
export function CopyIcon({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" {...base}>
      <rect x="9" y="9" width="11" height="11" rx="2.2" />
      <path d="M15 5.5A2.5 2.5 0 0 0 12.5 3H6a3 3 0 0 0-3 3v6.5A2.5 2.5 0 0 0 5.5 15" />
    </svg>
  );
}

export function VideoIcon({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" {...base}>
      <rect x="2.5" y="6" width="13" height="12" rx="3" />
      <path d="m15.5 11 5-2.8v7.6l-5-2.8Z" />
    </svg>
  );
}

export function CameraIcon({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" {...base}>
      <path d="M3 8.5A2.5 2.5 0 0 1 5.5 6h1.7a1 1 0 0 0 .83-.45l.74-1.1A1 1 0 0 1 9.6 4h4.8a1 1 0 0 1 .83.45l.74 1.1a1 1 0 0 0 .83.45h1.7A2.5 2.5 0 0 1 21 8.5v8A2.5 2.5 0 0 1 18.5 19h-13A2.5 2.5 0 0 1 3 16.5Z" />
      <circle cx="12" cy="12.5" r="3.4" />
    </svg>
  );
}

export function FolderIcon({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" {...base}>
      <path d="M3 7.5A2.5 2.5 0 0 1 5.5 5h3.2a1 1 0 0 1 .78.37l1.15 1.44a1 1 0 0 0 .78.37h7.09A2.5 2.5 0 0 1 21 9.68v6.82A2.5 2.5 0 0 1 18.5 19h-13A2.5 2.5 0 0 1 3 16.5Z" />
    </svg>
  );
}

export function PhotosIcon({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" {...base}>
      <rect x="3" y="5" width="18" height="14" rx="2.6" />
      <path d="m3.6 16.4 4.2-4.2a1.6 1.6 0 0 1 2.25 0l3.1 3.1M13 14l1.9-1.9a1.6 1.6 0 0 1 2.25 0l3.2 3.2" />
      <circle cx="8.6" cy="9.2" r="1.3" />
    </svg>
  );
}

export function AlertIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" {...base}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7.5v5.2" />
      <circle cx="12" cy="16.3" r="0.9" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function CheckCircleIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" fill="none">
      <circle cx="12" cy="12" r="9.2" fill="currentColor" />
      <path d="m7.9 12.3 2.7 2.7 5.5-5.7" stroke="#fff" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function SlidersIcon({ size = 17 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" {...base}>
      <path d="M4 7h10M18 7h2M4 17h2M10 17h10" />
      <circle cx="16" cy="7" r="2.1" />
      <circle cx="8" cy="17" r="2.1" />
    </svg>
  );
}

export function MinusIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" {...base} strokeWidth={2.2}>
      <path d="M5 12h14" />
    </svg>
  );
}

export function SofaIcon({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" {...base}>
      <path d="M20 9.5v-3A2.5 2.5 0 0 0 17.5 4h-11A2.5 2.5 0 0 0 4 6.5v3" />
      <path d="M2 11.5v5A1.5 1.5 0 0 0 3.5 18h17a1.5 1.5 0 0 0 1.5-1.5v-5a2 2 0 0 0-4 0V13H6v-1.5a2 2 0 0 0-4 0Z" />
      <path d="M5 18v2M19 18v2" />
    </svg>
  );
}

export function MobileIcon({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" {...base}>
      <rect x="7" y="2.5" width="10" height="19" rx="2.5" />
      <path d="M10.75 18.5h2.5" />
    </svg>
  );
}

export function DesktopIcon({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" {...base}>
      <rect x="2.5" y="4" width="19" height="12.5" rx="2" />
      <path d="M9 20.5h6M12 16.5v4" />
    </svg>
  );
}

export function SparkIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" {...base}>
      <path d="M12 3.2 13.7 9l5.8 1.7-5.8 1.7L12 18.2 10.3 12.4 4.5 10.7 10.3 9z" />
      <path d="M18.6 3.4 19.2 5.4l2 .6-2 .6-.6 2-.6-2-2-.6 2-.6z" />
    </svg>
  );
}

export function SendIcon({ size = 17 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" {...base}>
      <path d="M4.2 11.9 19.5 4.7 12.9 20l-2-6.2z" />
      <path d="m10.9 13.8 3.6-3.6" />
    </svg>
  );
}
