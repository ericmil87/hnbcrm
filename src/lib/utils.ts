import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/**
 * tailwind-merge precisa conhecer as escalas próprias do tailwind.config.js.
 * Sem isso `text-caption` era lido como cor de texto e `cn("text-caption",
 * "text-text-muted")` descartava o tamanho (o texto saía em 16 px).
 */
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [{ text: ["caption", "micro"] }],
      shadow: [{ shadow: ["card", "card-hover", "elevated", "glow", "bubble"] }],
      rounded: [{ rounded: ["btn", "card", "field"] }],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
