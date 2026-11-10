import { cn } from "@/lib/utils";

interface BrandLogoProps {
  /** Size/spacing classes for every image (e.g. "h-8 w-8"). */
  className?: string;
}

/**
 * HNBCRM icon that follows the theme: black on the light surfaces (Claro, Estilo WhatsApp), white on
 * WhatsApp escuro and the original orange on Escuro (kept as before). Hidden images are `display:none`,
 * so only the visible one is in the accessibility tree and each carries the alt text.
 */
export function BrandLogo({ className }: BrandLogoProps) {
  return (
    <>
      <img
        src="/black_icon_logo_transparent-bg-528x488.png"
        alt="HNBCRM"
        className={cn("hidden light-theme:block object-contain", className)}
      />
      <img
        src="/white_icon_logo_transparent-bg-528x488.png"
        alt="HNBCRM"
        className={cn("hidden [[data-theme=whatsapp-dark]_&]:block object-contain", className)}
      />
      <img
        src="/orange_icon_logo_transparent-bg-528x488.png"
        alt="HNBCRM"
        className={cn("hidden [[data-theme=dark]_&]:block object-contain", className)}
      />
    </>
  );
}
