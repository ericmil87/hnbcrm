import { ExternalLink, Github } from "lucide-react";
import { cn } from "@/lib/utils";
import { AUTHOR } from "./manifestoCopy";

interface AuthorCardProps {
  /** `card` tem moldura (landing); `plain` fica sem moldura, para fechar o texto do manifesto. */
  variant?: "card" | "plain";
  className?: string;
}

/** Apresentação do autor: foto, nome, texto em primeira pessoa e links externos. */
export function AuthorCard({ variant = "card", className }: AuthorCardProps) {
  return (
    <div
      className={cn(
        variant === "card" && "rounded-card border border-border bg-surface-base p-5 md:p-6",
        className,
      )}
    >
      <div className="flex items-center gap-4">
        <img
          src={AUTHOR.photo}
          alt={AUTHOR.photoAlt}
          width={112}
          height={112}
          loading="lazy"
          decoding="async"
          className="size-24 shrink-0 rounded-full border border-border object-cover md:size-28"
        />
        <div>
          <p className="font-display text-xl font-bold text-text-primary">{AUTHOR.name}</p>
          <p className="mt-1 text-sm text-text-secondary">{AUTHOR.role}</p>
        </div>
      </div>
      <div className="mt-5 space-y-3 text-text-primary">
        {AUTHOR.paragraphs.map((p) => (
          <p key={p}>{p}</p>
        ))}
      </div>
      <p className="mt-4 text-sm text-text-secondary">{AUTHOR.company}</p>
      <ul className="mt-3 flex flex-wrap gap-x-5">
        {AUTHOR.links.map((link) => (
          <li key={link.href}>
            <a
              href={link.href}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex min-h-11 items-center gap-1.5 text-sm font-medium text-brand-400 underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
            >
              {link.label === "GitHub" && <Github className="size-4" aria-hidden="true" />}
              {link.label}
              <ExternalLink className="size-3.5" aria-hidden="true" />
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}
