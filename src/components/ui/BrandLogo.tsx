import { useId } from "react";
import { cn } from "@/lib/utils";
import {
  BRAND_AI_CUT_PATH,
  BRAND_AI_CUT_STROKE,
  BRAND_AI_PATH,
  BRAND_HUMAN_PATH,
  BRAND_HUMAN_STROKE,
  BRAND_ICON_VIEWBOX,
  BRAND_WORDMARK_PATH,
  BRAND_WORDMARK_TRANSFORM,
  BRAND_WORDMARK_VIEWBOX,
} from "@/lib/brandLogo";

export type BrandLogoSize = "sm" | "md" | "lg" | "xl" | "2xl";

/** Icon height per size (the width follows the viewBox). `className` can still override it. */
const SIZE_CLASS: Record<BrandLogoSize, string> = {
  sm: "h-6",
  md: "h-8",
  lg: "h-10",
  xl: "h-16",
  "2xl": "h-20",
};

interface BrandLogoProps {
  /**
   * `icon` = the two interlocking bubbles; `wordmark` = icon + "HNBCRM"; `responsive` = icon below the
   * breakpoint and wordmark from it up (replaces the old "icon + loose HNBCRM text" headers).
   */
  variant?: "icon" | "wordmark" | "responsive";
  /** Breakpoint where `responsive` switches to the wordmark. */
  breakpoint?: "sm" | "lg";
  size?: BrandLogoSize;
  /** Extra classes (e.g. `h-12`, `mx-auto`); a height class here wins over `size`. */
  className?: string;
  /** Use when the text "HNBCRM" is already next to the logo (hides it from screen readers). */
  decorative?: boolean;
}

interface LogoSvgProps {
  wordmark: boolean;
  className?: string;
  decorative?: boolean;
}

/**
 * Inline SVG so the colors follow the theme without a file per theme: the human bubble is `currentColor`
 * (text-primary by default) and the AI bubble is the `logo-ai` token (green in the four themes). Each
 * instance gets its own mask id because several logos can share a page.
 */
function LogoSvg({ wordmark, className, decorative }: LogoSvgProps) {
  const maskId = `brand-cut-${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={wordmark ? BRAND_WORDMARK_VIEWBOX : BRAND_ICON_VIEWBOX}
      className={cn("shrink-0 w-auto text-text-primary", className)}
      {...(decorative ? { "aria-hidden": true } : { role: "img", "aria-label": "HNBCRM" })}
      focusable="false"
    >
      <mask id={maskId} maskUnits="userSpaceOnUse" x="0" y="0" width="64" height="64">
        <rect width="64" height="64" fill="#fff" />
        <path d={BRAND_AI_CUT_PATH} fill="#000" stroke="#000" strokeWidth={BRAND_AI_CUT_STROKE} strokeLinejoin="round" />
      </mask>
      <path
        mask={`url(#${maskId})`}
        d={BRAND_HUMAN_PATH}
        fill="none"
        stroke="currentColor"
        strokeWidth={BRAND_HUMAN_STROKE}
        strokeLinejoin="round"
      />
      <path className="fill-logo-ai" fillRule="evenodd" d={BRAND_AI_PATH} />
      {wordmark && <path fill="currentColor" transform={BRAND_WORDMARK_TRANSFORM} d={BRAND_WORDMARK_PATH} />}
    </svg>
  );
}

/** The only entry point for the HNBCRM logo in the app (landing, public pages, shell, wizard). */
export function BrandLogo({ variant = "icon", breakpoint = "sm", size = "md", className, decorative }: BrandLogoProps) {
  const sizeClass = SIZE_CLASS[size];
  if (variant === "responsive") {
    const iconOnly = breakpoint === "lg" ? "lg:hidden" : "sm:hidden";
    const wordOnly = breakpoint === "lg" ? "hidden lg:block" : "hidden sm:block";
    return (
      <>
        <LogoSvg wordmark={false} decorative={decorative} className={cn(sizeClass, iconOnly, className)} />
        <LogoSvg wordmark decorative={decorative} className={cn(sizeClass, wordOnly, className)} />
      </>
    );
  }
  return <LogoSvg wordmark={variant === "wordmark"} decorative={decorative} className={cn(sizeClass, className)} />;
}
