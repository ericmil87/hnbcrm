import { Github } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { cn } from "@/lib/utils";
import { useInView } from "@/hooks/useInView";

const stats = [
  { label: "Versão", value: "v0.22.0" },
  { label: "MCP Tools", value: "44+" },
  { label: "TypeScript", value: "99%" },
];

const techStack = ["React", "Convex", "TailwindCSS", "TypeScript"];

export function OpenSourceSection() {
  const { ref, isInView } = useInView({ threshold: 0.1 });

  return (
    <section
      ref={ref}
      className="py-12 md:py-16 border-y border-border bg-surface-sunken/50"
    >
      <div className="max-w-6xl mx-auto px-4">
        <div className="text-center space-y-4 mb-10">
          <div className={cn(isInView && "animate-fade-in")}>
            <Badge variant="brand">Open Source — MIT License</Badge>
          </div>
          <h2
            className={cn(
              "text-2xl md:text-3xl lg:text-4xl font-bold",
              isInView && "animate-fade-in-up"
            )}
          >
            Construido abertamente
          </h2>
          <p
            className={cn(
              "text-text-secondary max-w-xl mx-auto",
              isInView && "animate-fade-in-up [animation-delay:100ms]"
            )}
          >
            100% do código é aberto, auditável e extensível. Faça fork, contribua
            ou use como base para seu proprio CRM.
          </p>
        </div>

        <div
          className={cn(
            "grid grid-cols-3 gap-4 md:gap-6 max-w-lg mx-auto mb-8",
            isInView && "animate-fade-in-up [animation-delay:150ms]"
          )}
        >
          {stats.map((stat) => (
            <Card key={stat.label} className="p-4 text-center">
              <div className="text-xl md:text-2xl font-bold text-text-primary">
                {stat.value}
              </div>
              <div className="text-xs text-text-secondary">{stat.label}</div>
            </Card>
          ))}
        </div>

        <div
          className={cn(
            "flex flex-wrap items-center justify-center gap-2 mb-8",
            isInView && "animate-fade-in-up [animation-delay:200ms]"
          )}
        >
          {techStack.map((tech) => (
            <span
              key={tech}
              className="px-3 py-1 rounded-full text-xs font-medium bg-surface-overlay text-text-secondary border border-border"
            >
              {tech}
            </span>
          ))}
        </div>

        <div
          className={cn(
            "text-center",
            isInView && "animate-fade-in-up [animation-delay:250ms]"
          )}
        >
          <a
            href="https://github.com/ericmil87/hnbcrm"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 px-6 py-3 rounded-full bg-surface-overlay text-text-primary font-medium border border-border hover:bg-surface-raised transition-colors"
          >
            <Github size={18} />
            Ver no GitHub
          </a>
        </div>
      </div>
    </section>
  );
}
