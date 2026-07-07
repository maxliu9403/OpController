import { Fingerprint } from "lucide-react";

type ProviderIconProps = {
  providerType: string;
  displayName?: string | null;
  className?: string;
};

const PROVIDER_INITIALS: Record<string, string> = {
  ixbrowser: "IX",
  nstbrowser: "NST",
  bitbrowser: "BIT",
};

function fallbackInitials(value?: string | null) {
  const source = (value ?? "").trim();
  if (!source) {
    return "FP";
  }
  return source
    .split(/\s+/)
    .map((part) => part[0])
    .join("")
    .slice(0, 3)
    .toUpperCase();
}

export function ProviderIcon({ providerType, displayName, className }: ProviderIconProps) {
  const normalizedType = providerType.toLowerCase();
  const initials = PROVIDER_INITIALS[normalizedType] ?? fallbackInitials(displayName ?? providerType);

  return (
    <span className={["provider-icon", `provider-icon--${normalizedType}`, className].filter(Boolean).join(" ")}>
      <Fingerprint size={24} aria-hidden />
      <span className="provider-icon__letters">{initials}</span>
    </span>
  );
}
