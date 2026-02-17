import { useState, useEffect, useRef } from "react";
import { Link } from "react-router";
import {
  Kanban,
  Contact2,
  MessageSquare,
  ArrowRightLeft,
  Users,
  ScrollText,
  Globe,
  SlidersHorizontal,
  Bookmark,
  Building2,
  BarChart3,
  Webhook,
  Server,
  Zap,
  CalendarDays,
  Bot,
  Radio,
  Paperclip,
  Search,
  Target,
  Layers,
  Check,
  Sparkles,
  Zap as Lightning,
  TrendingUp,
  Code2,
  Play,
  BookOpen,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { cn } from "@/lib/utils";
import { SEO } from "@/components/SEO";
import { OrganizationStructuredData } from "@/components/StructuredData";

// Simple useInView hook for scroll animations
function useInView(options = {}) {
  const [isInView, setIsInView] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) {
        setIsInView(true);
      }
    }, options);

    if (ref.current) {
      observer.observe(ref.current);
    }

    return () => {
      if (ref.current) {
        observer.unobserve(ref.current);
      }
    };
  }, []);

  return { ref, isInView };
}

export function LandingPage() {
  const [showFloatingCta, setShowFloatingCta] = useState(false);
  const heroRef = useRef<HTMLElement>(null);

  // IntersectionObserver for floating CTA
  useEffect(() => {
    const observer = new IntersectionObserver(
      ([entry]) => {
        setShowFloatingCta(!entry.isIntersecting);
      },
      { threshold: 0.1 }
    );

    if (heroRef.current) {
      observer.observe(heroRef.current);
    }

    return () => {
      if (heroRef.current) {
        observer.unobserve(heroRef.current);
      }
    };
  }, []);

  const scrollToSection = (id: string) => {
    const element = document.getElementById(id);
    if (element) {
      element.scrollIntoView({ behavior: "smooth" });
    }
  };

  return (
    <>
      <SEO
        title="HNBCRM — CRM com Colaboração Humano-IA"
        description="CRM multi-tenancy com automação de IA. Gerencie leads, pipeline, contatos e integre agentes de IA via API REST e MCP."
        keywords="crm, ai, automation, leads, pipeline, multi-tenant, webhook, mcp, api rest"
      />
      <OrganizationStructuredData />
      <div className="min-h-screen bg-surface-base text-text-primary">
        {/* Hero Section with inline header */}
      <section
        ref={heroRef}
        className="relative min-h-[85vh] md:min-h-screen flex flex-col bg-[radial-gradient(ellipse_80%_50%_at_50%_-20%,rgba(255,107,0,0.15),transparent)]"
      >
        {/* Header */}
        <header className="pt-6 px-4">
          <div className="flex items-center justify-between max-w-6xl mx-auto">
            <div className="flex items-center gap-2">
              <img
                src="/orange_icon_logo_transparent-bg-528x488.png"
                alt="HNBCRM Logo"
                className="h-8 w-8 object-contain"
              />
              <span className="text-xl font-bold text-text-primary">HNBCRM</span>
            </div>
            <div className="flex items-center gap-4">
              <Link to="/developers">
                <Button variant="ghost" size="sm">
                  Developers
                </Button>
              </Link>
              <Link to="/entrar">
                <Button variant="ghost" size="sm">
                  Entrar
                </Button>
              </Link>
            </div>
          </div>
        </header>

        {/* Hero Content */}
        <div className="flex-1 flex flex-col items-center justify-center px-4 text-center">
          <div className="max-w-4xl mx-auto space-y-6 md:space-y-8">
            <div className="animate-fade-in">
              <Badge variant="brand">Beta Aberto — 100% Grátis</Badge>
            </div>

            <h1 className="text-4xl md:text-6xl lg:text-7xl font-bold leading-tight animate-fade-in-up">
              O CRM onde{" "}
              <span className="text-brand-500">Humanos e IA</span>{" "}
              trabalham juntos
            </h1>

            <p className="text-lg md:text-xl text-text-secondary max-w-2xl mx-auto animate-fade-in-up [animation-delay:100ms]">
              Pipeline visual, caixa de entrada multicanal, repasses
              inteligentes e auditoria completa. Tudo em tempo real.
            </p>

            <div className="flex flex-col sm:flex-row items-center justify-center gap-4 animate-fade-in-up [animation-delay:200ms]">
              <Link to="/entrar">
                <Button variant="primary" size="lg" className="shadow-glow min-h-[44px]">
                  Começar Grátis
                </Button>
              </Link>
              <Button
                variant="secondary"
                size="lg"
                onClick={() => scrollToSection("funcionalidades")}
                className="min-h-[44px]"
              >
                Ver Funcionalidades
              </Button>
            </div>

            <p className="text-sm text-text-muted animate-fade-in-up [animation-delay:300ms]">
              Sem cartão de crédito. Sem limite de tempo.
            </p>
          </div>
        </div>
      </section>

      {/* Floating CTA Pill */}
      <Link to="/entrar">
        <button
          className={cn(
            "fixed bottom-6 left-1/2 -translate-x-1/2 z-40",
            "bg-brand-600 text-white rounded-full shadow-elevated px-6 py-3",
            "font-semibold transition-all duration-300 min-h-[44px]",
            showFloatingCta
              ? "opacity-100 translate-y-0"
              : "opacity-0 translate-y-4 pointer-events-none"
          )}
          aria-label="Começar Grátis"
        >
          Começar Grátis
        </button>
      </Link>

      <main>
        {/* Social Proof Bar */}
        <SocialProofBar />

        {/* Features Section */}
        <FeaturesSection />

        {/* Developer Section */}
        <DeveloperSection />

        {/* Coming Soon Section */}
        <ComingSoonSection />

        {/* How It Works Section */}
        <HowItWorksSection />

        {/* Pricing Section */}
        <PricingSection />

        {/* CTA Section */}
        <CTASection />
      </main>

      {/* Footer */}
      <Footer />
    </div>
    </>
  );
}

function SocialProofBar() {
  return (
    <div className="py-8 border-y border-border bg-surface-sunken/50">
      <div className="max-w-6xl mx-auto px-4">
        <div className="flex flex-col sm:flex-row items-center justify-center gap-8 md:gap-16">
          <div className="flex items-center gap-3">
            <Sparkles className="text-brand-500" size={24} />
            <div>
              <div className="text-2xl font-bold text-text-primary">12+</div>
              <div className="text-sm text-text-secondary">Funcionalidades</div>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <Lightning className="text-brand-500" size={24} />
            <div>
              <div className="text-2xl font-bold text-text-primary">Tempo Real</div>
              <div className="text-sm text-text-secondary">com Convex</div>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <TrendingUp className="text-brand-500" size={24} />
            <div>
              <div className="text-2xl font-bold text-text-primary">IA Nativa</div>
              <div className="text-sm text-text-secondary">de Verdade</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function FeaturesSection() {
  const { ref, isInView } = useInView({ threshold: 0.1 });

  const features = [
    {
      icon: Kanban,
      title: "Pipeline Kanban",
      description: "Arraste e solte leads entre etapas. Visual, rápido e intuitivo.",
    },
    {
      icon: Contact2,
      title: "Gestão de Contatos",
      description: "Centralize todos os seus contatos com campos personalizados.",
    },
    {
      icon: MessageSquare,
      title: "Caixa de Entrada Unificada",
      description: "Todas as conversas em um só lugar, em tempo real.",
    },
    {
      icon: ArrowRightLeft,
      title: "Repasses IA ↔ Humano",
      description: "Handoffs inteligentes entre agentes de IA e vendedores.",
    },
    {
      icon: Users,
      title: "Equipe Humanos + IA",
      description: "Gerencie vendedores e agentes de IA lado a lado.",
    },
    {
      icon: ScrollText,
      title: "Auditoria Completa",
      description: "Rastreie todas as alterações com logs detalhados e filtráveis.",
    },
    {
      icon: Globe,
      title: "API REST Completa",
      description: "Integre com seus sistemas via API autenticada.",
    },
    {
      icon: SlidersHorizontal,
      title: "Campos Personalizados",
      description: "Adapte o CRM às suas necessidades com campos customizados.",
    },
    {
      icon: Bookmark,
      title: "Visões Salvas",
      description: "Crie filtros e visualizações personalizadas para sua equipe.",
    },
    {
      icon: Building2,
      title: "Multi-tenancy",
      description: "Isolamento total de dados por organização. Seguro e escalável.",
    },
    {
      icon: BarChart3,
      title: "Dashboard Tempo Real",
      description: "Métricas e KPIs atualizados instantaneamente.",
    },
    {
      icon: CalendarDays,
      title: "Calendário",
      description: "Visualize eventos e tarefas em dia, semana ou mês com drag-and-drop.",
    },
    {
      icon: Webhook,
      title: "Webhooks HMAC-SHA256",
      description: "Receba eventos em tempo real com autenticação segura.",
    },
    {
      icon: Server,
      title: "Servidor MCP",
      description: "Integre agentes de IA via Model Context Protocol.",
    },
  ];

  return (
    <section
      id="funcionalidades"
      ref={ref}
      className="py-16 md:py-24"
      aria-labelledby="features-heading"
    >
      <div className="max-w-6xl mx-auto px-4">
        <div className="text-center mb-12 md:mb-16">
          <h2
            id="features-heading"
            className={cn(
              "text-3xl md:text-4xl lg:text-5xl font-bold mb-4",
              isInView && "animate-fade-in-up"
            )}
          >
            Tudo que você precisa para vender mais
          </h2>
          <p
            className={cn(
              "text-lg text-text-secondary",
              isInView && "animate-fade-in-up [animation-delay:100ms]"
            )}
          >
            Funcionalidades prontas, sem configuração complicada.
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 md:gap-6">
          {features.map((feature, index) => (
            <Card
              key={index}
              className={cn(
                "p-6",
                isInView && "animate-fade-in-up",
                isInView && `[animation-delay:${index * 50}ms]`
              )}
            >
              <div className="flex items-start gap-4">
                <div className="w-10 h-10 rounded-xl bg-brand-500/10 flex items-center justify-center flex-shrink-0">
                  <feature.icon className="text-brand-400" size={20} />
                </div>
                <div>
                  <h3 className="font-semibold text-text-primary mb-2">
                    {feature.title}
                  </h3>
                  <p className="text-sm text-text-secondary">
                    {feature.description}
                  </p>
                </div>
              </div>
            </Card>
          ))}
        </div>
      </div>
    </section>
  );
}

function DeveloperSection() {
  const { ref, isInView } = useInView({ threshold: 0.1 });

  const cards = [
    {
      icon: Globe,
      title: "API REST Completa",
      description: "30 endpoints para gerenciar leads, contatos, conversas, handoffs e mais. Autenticacao via API Key.",
      link: "/developers#rest-api",
      linkText: "Ver Documentacao",
    },
    {
      icon: Server,
      title: "Servidor MCP",
      description: "26 ferramentas para agentes de IA via Model Context Protocol. Compativel com Claude, Cursor e VS Code.",
      link: "/developers#mcp",
      linkText: "Configurar MCP",
    },
    {
      icon: Play,
      title: "API Playground",
      description: "Teste endpoints direto do navegador. Preencha formularios, envie requisicoes e veja respostas em tempo real.",
      link: "/developers#playground",
      linkText: "Abrir Playground",
      primary: true,
    },
    {
      icon: BookOpen,
      title: "Agent Skills",
      description: "Skill portavel que ensina qualquer agente de IA a operar como membro da equipe. Compativel com Claude Code, Cursor, Gemini e mais.",
      link: "/developers#agent-skills",
      linkText: "Ver Skill",
    },
  ];

  return (
    <section
      id="developers"
      ref={ref}
      className="py-16 md:py-24 bg-surface-sunken/30"
      aria-labelledby="developer-heading"
    >
      <div className="max-w-6xl mx-auto px-4">
        <div className="text-center mb-12 md:mb-16">
          <Badge variant="brand">Developer Experience</Badge>
          <h2
            id="developer-heading"
            className={cn(
              "text-3xl md:text-4xl lg:text-5xl font-bold mb-4 mt-4",
              isInView && "animate-fade-in-up"
            )}
          >
            Feito para desenvolvedores
          </h2>
          <p
            className={cn(
              "text-lg text-text-secondary",
              isInView && "animate-fade-in-up [animation-delay:100ms]"
            )}
          >
            Integre agentes de IA, automatize workflows e estenda seu CRM.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
          {cards.map((card, index) => (
            <Card
              key={index}
              className={cn(
                "p-8 flex flex-col",
                card.primary && "border-brand-500",
                isInView && "animate-fade-in-up",
                isInView && `[animation-delay:${index * 100}ms]`
              )}
            >
              <div className="w-12 h-12 rounded-xl bg-brand-500/10 flex items-center justify-center mb-4">
                <card.icon className="text-brand-400" size={24} />
              </div>
              <h3 className="text-xl font-semibold text-text-primary mb-2">
                {card.title}
              </h3>
              <p className="text-sm text-text-secondary mb-6 flex-1">
                {card.description}
              </p>
              <Link to={card.link}>
                <Button
                  variant={card.primary ? "primary" : "secondary"}
                  size="sm"
                  className="w-full min-h-[44px]"
                >
                  <Code2 size={16} />
                  {card.linkText}
                </Button>
              </Link>
            </Card>
          ))}
        </div>
      </div>
    </section>
  );
}

function ComingSoonSection() {
  const { ref, isInView } = useInView({ threshold: 0.1 });

  const comingSoon = [
    {
      icon: Zap,
      title: "Motor de Automações",
      description: "Automatize fluxos de trabalho sem escrever código.",
    },
    {
      icon: Bot,
      title: "IA Co-piloto",
      description: "Assistente inteligente que sugere próximos passos.",
    },
    {
      icon: Radio,
      title: "Integrações de Canais",
      description: "WhatsApp, email, SMS e mais em breve.",
    },
    {
      icon: Paperclip,
      title: "Armazenamento de Arquivos",
      description: "Anexe documentos e imagens aos seus leads.",
    },
    {
      icon: Search,
      title: "Paleta de Comandos",
      description: "Navegue pelo CRM com atalhos de teclado.",
    },
    {
      icon: Target,
      title: "Scoring de Leads com IA",
      description: "Priorize automaticamente os melhores leads.",
    },
    {
      icon: Layers,
      title: "Fluxos Multi-Agente",
      description: "Orquestre múltiplos agentes de IA em paralelo.",
    },
  ];

  return (
    <section
      id="em-breve"
      ref={ref}
      className="py-16 md:py-24 bg-surface-sunken/30"
      aria-labelledby="coming-soon-heading"
    >
      <div className="max-w-6xl mx-auto px-4">
        <div className="text-center mb-12 md:mb-16">
          <h2
            id="coming-soon-heading"
            className={cn(
              "text-3xl md:text-4xl lg:text-5xl font-bold mb-4",
              isInView && "animate-fade-in-up"
            )}
          >
            Estamos só começando
          </h2>
          <p
            className={cn(
              "text-lg text-text-secondary",
              isInView && "animate-fade-in-up [animation-delay:100ms]"
            )}
          >
            Novas funcionalidades a cada semana.
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {comingSoon.map((feature, index) => (
            <Card
              key={index}
              className={cn(
                "p-6 opacity-70 relative",
                isInView && "animate-fade-in-up",
                isInView && `[animation-delay:${index * 50}ms]`
              )}
            >
              <div className="absolute top-4 right-4">
                <Badge variant="warning">Em Breve</Badge>
              </div>
              <div className="flex flex-col items-start gap-4">
                <div className="w-10 h-10 rounded-xl bg-surface-overlay flex items-center justify-center">
                  <feature.icon className="text-text-muted" size={20} />
                </div>
                <div>
                  <h3 className="font-semibold text-text-primary mb-2">
                    {feature.title}
                  </h3>
                  <p className="text-sm text-text-secondary">
                    {feature.description}
                  </p>
                </div>
              </div>
            </Card>
          ))}
        </div>
      </div>
    </section>
  );
}

function HowItWorksSection() {
  const { ref, isInView } = useInView({ threshold: 0.1 });

  const steps = [
    {
      number: 1,
      title: "Crie sua organização",
      description:
        "Cadastre-se em segundos e configure seu espaço de trabalho.",
    },
    {
      number: 2,
      title: "Configure seu pipeline",
      description:
        "Personalize etapas, campos e convide sua equipe.",
    },
    {
      number: 3,
      title: "Venda com superpoderes",
      description:
        "Leads, conversas, repasses e auditoria — tudo em tempo real.",
    },
  ];

  return (
    <section
      ref={ref}
      className="py-16 md:py-24"
      aria-labelledby="how-it-works-heading"
    >
      <div className="max-w-6xl mx-auto px-4">
        <div className="text-center mb-12 md:mb-16">
          <h2
            id="how-it-works-heading"
            className={cn(
              "text-3xl md:text-4xl lg:text-5xl font-bold mb-4",
              isInView && "animate-fade-in-up"
            )}
          >
            Simples de começar
          </h2>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {steps.map((step, index) => (
            <Card
              key={index}
              className={cn(
                "p-8 text-center",
                isInView && "animate-fade-in-up",
                isInView && `[animation-delay:${index * 100}ms]`
              )}
            >
              <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-brand-500/10 border-2 border-brand-500 flex items-center justify-center">
                <span className="text-2xl font-bold text-brand-500">
                  {step.number}
                </span>
              </div>
              <h3 className="text-xl font-semibold text-text-primary mb-3">
                {step.title}
              </h3>
              <p className="text-text-secondary">{step.description}</p>
            </Card>
          ))}
        </div>
      </div>
    </section>
  );
}

function PricingSection() {
  const { ref, isInView } = useInView({ threshold: 0.1 });

  return (
    <section
      id="precos"
      ref={ref}
      className="py-16 md:py-24"
      aria-labelledby="pricing-heading"
    >
      <div className="max-w-5xl mx-auto px-4">
        <div className="text-center mb-12 md:mb-16">
          <h2
            id="pricing-heading"
            className={cn(
              "text-3xl md:text-4xl lg:text-5xl font-bold mb-4",
              isInView && "animate-fade-in-up"
            )}
          >
            Preços simples e transparentes
          </h2>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {/* Starter Plan */}
          <Card
            className={cn(
              "p-8",
              isInView && "animate-fade-in-up [animation-delay:0ms]"
            )}
          >
            <div className="mb-6">
              <h3 className="text-xl font-semibold text-text-primary mb-2">
                Starter
              </h3>
              <div className="mb-2">
                <span className="text-3xl font-bold text-text-primary">
                  Grátis
                </span>
              </div>
              <p className="text-sm text-text-secondary">para sempre</p>
            </div>

            <ul className="space-y-3 mb-8">
              <li className="flex items-start gap-2">
                <Check className="text-brand-500 flex-shrink-0 mt-0.5" size={18} />
                <span className="text-text-secondary">Até 3 usuários</span>
              </li>
              <li className="flex items-start gap-2">
                <Check className="text-brand-500 flex-shrink-0 mt-0.5" size={18} />
                <span className="text-text-secondary">1 pipeline</span>
              </li>
              <li className="flex items-start gap-2">
                <Check className="text-brand-500 flex-shrink-0 mt-0.5" size={18} />
                <span className="text-text-secondary">100 leads</span>
              </li>
              <li className="flex items-start gap-2">
                <Check className="text-brand-500 flex-shrink-0 mt-0.5" size={18} />
                <span className="text-text-secondary">Caixa de entrada</span>
              </li>
              <li className="flex items-start gap-2">
                <Check className="text-brand-500 flex-shrink-0 mt-0.5" size={18} />
                <span className="text-text-secondary">Contatos</span>
              </li>
            </ul>

            <Link to="/entrar" className="block">
              <Button variant="secondary" className="w-full min-h-[44px]">
                Começar Grátis
              </Button>
            </Link>
          </Card>

          {/* Pro Plan (Highlighted) */}
          <Card
            className={cn(
              "p-8 border-brand-500 shadow-glow relative",
              isInView && "animate-fade-in-up [animation-delay:100ms]"
            )}
          >
            <div className="absolute -top-3 left-1/2 -translate-x-1/2">
              <Badge variant="brand">Recomendado</Badge>
            </div>

            <div className="mb-6">
              <h3 className="text-xl font-semibold text-text-primary mb-2">
                Pro
              </h3>
              <div className="mb-2">
                <div className="text-text-muted line-through text-sm mb-1">
                  R$ 97/mês
                </div>
                <span className="text-3xl font-bold text-brand-500">
                  Grátis no Beta
                </span>
              </div>
            </div>

            <ul className="space-y-3 mb-8">
              <li className="flex items-start gap-2">
                <Check className="text-brand-500 flex-shrink-0 mt-0.5" size={18} />
                <span className="text-text-secondary">Usuários ilimitados</span>
              </li>
              <li className="flex items-start gap-2">
                <Check className="text-brand-500 flex-shrink-0 mt-0.5" size={18} />
                <span className="text-text-secondary">Pipelines ilimitados</span>
              </li>
              <li className="flex items-start gap-2">
                <Check className="text-brand-500 flex-shrink-0 mt-0.5" size={18} />
                <span className="text-text-secondary">Leads ilimitados</span>
              </li>
              <li className="flex items-start gap-2">
                <Check className="text-brand-500 flex-shrink-0 mt-0.5" size={18} />
                <span className="text-text-secondary">Repasses IA ↔ Humano</span>
              </li>
              <li className="flex items-start gap-2">
                <Check className="text-brand-500 flex-shrink-0 mt-0.5" size={18} />
                <span className="text-text-secondary">API REST + Webhooks</span>
              </li>
              <li className="flex items-start gap-2">
                <Check className="text-brand-500 flex-shrink-0 mt-0.5" size={18} />
                <span className="text-text-secondary">Auditoria completa</span>
              </li>
              <li className="flex items-start gap-2">
                <Check className="text-brand-500 flex-shrink-0 mt-0.5" size={18} />
                <span className="text-text-secondary">Campos personalizados</span>
              </li>
            </ul>

            <Link to="/entrar" className="block">
              <Button variant="primary" className="w-full min-h-[44px]">
                Começar Grátis
              </Button>
            </Link>
          </Card>

          {/* Enterprise Plan */}
          <Card
            className={cn(
              "p-8",
              isInView && "animate-fade-in-up [animation-delay:200ms]"
            )}
          >
            <div className="mb-6">
              <h3 className="text-xl font-semibold text-text-primary mb-2">
                Enterprise
              </h3>
              <div className="mb-2">
                <div className="text-text-muted line-through text-sm mb-1">
                  R$ 297/mês
                </div>
                <span className="text-3xl font-bold text-brand-500">
                  Grátis no Beta
                </span>
              </div>
            </div>

            <ul className="space-y-3 mb-8">
              <li className="flex items-start gap-2">
                <Check className="text-brand-500 flex-shrink-0 mt-0.5" size={18} />
                <span className="text-text-secondary">Tudo do Pro</span>
              </li>
              <li className="flex items-start gap-2">
                <Check className="text-brand-500 flex-shrink-0 mt-0.5" size={18} />
                <span className="text-text-secondary">Servidor MCP</span>
              </li>
              <li className="flex items-start gap-2">
                <Check className="text-brand-500 flex-shrink-0 mt-0.5" size={18} />
                <span className="text-text-secondary flex items-center gap-2">
                  Automações <Badge variant="warning">Em Breve</Badge>
                </span>
              </li>
              <li className="flex items-start gap-2">
                <Check className="text-brand-500 flex-shrink-0 mt-0.5" size={18} />
                <span className="text-text-secondary flex items-center gap-2">
                  IA Co-piloto <Badge variant="warning">Em Breve</Badge>
                </span>
              </li>
              <li className="flex items-start gap-2">
                <Check className="text-brand-500 flex-shrink-0 mt-0.5" size={18} />
                <span className="text-text-secondary">Suporte prioritário</span>
              </li>
            </ul>

            <Link to="/entrar" className="block">
              <Button variant="secondary" className="w-full min-h-[44px]">
                Começar Grátis
              </Button>
            </Link>
          </Card>
        </div>
      </div>
    </section>
  );
}

function CTASection() {
  const { ref, isInView } = useInView({ threshold: 0.1 });

  return (
    <section
      ref={ref}
      className="py-16 md:py-24 text-center bg-[radial-gradient(ellipse_80%_50%_at_50%_-20%,rgba(255,107,0,0.15),transparent)]"
      aria-labelledby="cta-heading"
    >
      <div className="max-w-4xl mx-auto px-4">
        <h2
          id="cta-heading"
          className={cn(
            "text-3xl md:text-4xl lg:text-5xl font-bold mb-4",
            isInView && "animate-fade-in-up"
          )}
        >
          Pronto para transformar suas vendas?
        </h2>
        <p
          className={cn(
            "text-lg text-text-secondary mb-8",
            isInView && "animate-fade-in-up [animation-delay:100ms]"
          )}
        >
          Junte-se a empresas que já usam o HNBCRM para vender mais.
        </p>
        <div className={cn(isInView && "animate-fade-in-up [animation-delay:200ms]")}>
          <Link to="/entrar">
            <Button variant="primary" size="lg" className="min-h-[44px]">
              Criar Conta Grátis
            </Button>
          </Link>
        </div>
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer className="py-8 border-t border-border">
      <div className="max-w-6xl mx-auto px-4 text-center">
        <div className="flex items-center justify-center gap-2 mb-4">
          <img
            src="/orange_icon_logo_transparent-bg-528x488.png"
            alt="HNBCRM Logo"
            className="h-8 w-8 object-contain"
          />
          <span className="text-xl font-bold text-text-primary">HNBCRM</span>
        </div>
        <div className="flex items-center justify-center gap-6 mb-4">
          <Link to="/developers" className="text-sm text-text-secondary hover:text-text-primary transition-colors">
            Developers
          </Link>
        </div>
        <p className="text-text-secondary mb-4">
          O CRM onde humanos e IA trabalham juntos.
        </p>
        <p className="text-sm text-text-muted">
          © 2025 HNBCRM. Todos os direitos reservados.
        </p>
      </div>
    </footer>
  );
}
