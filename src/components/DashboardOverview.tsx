import { useState } from "react";
import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { Id } from "../../convex/_generated/dataModel";
import { cn } from "@/lib/utils";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Avatar } from "@/components/ui/Avatar";
import { Skeleton } from "@/components/ui/Skeleton";
import type { Tab } from "@/components/layout/BottomTabBar";
import { OnboardingChecklist } from "@/components/onboarding/OnboardingChecklist";
import {
  Handshake,
  DollarSign,
  Target,
  ArrowRightLeft,
  Users,
  Kanban,
  MessageSquare,
  Contact2,
  ScrollText,
  Globe,
  Webhook,
  Bookmark,
  Server,
  Paperclip,
  Zap,
  Search,
  Layers,
  Bot,
  Bell,
  FileUp,
} from "lucide-react";

interface DashboardOverviewProps {
  organizationId: Id<"organizations">;
  onTabChange: (tab: Tab) => void;
}

export function DashboardOverview({ organizationId, onTabChange }: DashboardOverviewProps) {
  const stats = useQuery(api.dashboard.getDashboardStats, { organizationId });
  const currentMember = useQuery(api.teamMembers.getCurrentTeamMember, { organizationId });

  if (!stats || !currentMember) {
    return <LoadingSkeleton />;
  }

  const totalPipelineValue = stats.pipelineStats.reduce((sum, b) => sum + b.totalValue, 0);
  const totalLeads = stats.pipelineStats.reduce((sum, b) => sum + b.totalLeads, 0);
  const firstName = currentMember.name.split(" ")[0];

  return (
    <div className="space-y-8 max-w-7xl">
      {/* 1. Hero Section */}
      <div className="flex items-center gap-4">
        <div className="h-12 w-12 md:h-14 md:w-14 rounded-2xl bg-brand-500/10 flex items-center justify-center shrink-0">
          <Handshake size={28} className="text-brand-500" />
        </div>
        <div>
          <h1 className="text-2xl md:text-3xl font-bold text-text-primary">Olá, {firstName}!</h1>
          <p className="text-sm md:text-base text-text-secondary">
            {stats.organizationName} — Humanos e bots, juntos no seu CRM.
          </p>
        </div>
      </div>

      {/* Onboarding Checklist */}
      <OnboardingChecklist organizationId={organizationId} onTabChange={onTabChange} />

      {/* 2. Quick Stats Row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 md:gap-4">
        <StatCard
          icon={DollarSign}
          label="Valor do Pipeline"
          value={formatCurrency(totalPipelineValue)}
          colorClass="bg-semantic-success/10 text-semantic-success"
        />
        <StatCard
          icon={Target}
          label="Leads Ativos"
          value={totalLeads.toString()}
          colorClass="bg-brand-500/10 text-brand-500"
        />
        <StatCard
          icon={ArrowRightLeft}
          label="Repasses Pendentes"
          value={stats.pendingHandoffs.toString()}
          colorClass="bg-semantic-warning/10 text-semantic-warning"
        />
        <StatCard
          icon={Users}
          label="Membros da Equipe"
          value={stats.teamMemberCount.toString()}
          colorClass="bg-semantic-info/10 text-semantic-info"
        />
      </div>

      {/* 3. Quick Actions */}
      <div>
        <h2 className="text-lg font-semibold text-text-primary mb-3">Ações Rápidas</h2>
        <div className="flex gap-3 overflow-x-auto pb-2 md:grid md:grid-cols-4 md:overflow-visible">
          <QuickActionCard icon={Kanban} label="Ir ao Pipeline" onClick={() => onTabChange("board")} />
          <QuickActionCard icon={MessageSquare} label="Caixa de Entrada" onClick={() => onTabChange("inbox")} />
          <QuickActionCard icon={ArrowRightLeft} label="Ver Repasses" onClick={() => onTabChange("handoffs")} />
          <QuickActionCard icon={Users} label="Gerenciar Equipe" onClick={() => onTabChange("team")} />
        </div>
      </div>

      {/* 4. Pipeline + Team Performance */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Pipeline por Board */}
        <PipelineByBoardWidget pipelineStats={stats.pipelineStats} />

        {/* Desempenho da Equipe */}
        <Card>
          <h3 className="text-lg font-semibold text-text-primary mb-4">Desempenho da Equipe</h3>
          {stats.teamPerformance.length === 0 ? (
            <p className="text-text-muted">Nenhum dado de equipe ainda.</p>
          ) : (
            <div className="space-y-2">
              {stats.teamPerformance.map((member, index) => (
                <div
                  key={index}
                  className="flex items-center justify-between p-2 bg-surface-sunken rounded-lg"
                >
                  <div className="flex items-center gap-2">
                    <Avatar
                      name={member.memberName}
                      type={member.memberType as "human" | "ai"}
                      size="sm"
                    />
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-text-primary">{member.memberName}</span>
                      <Badge variant={member.memberType === "ai" ? "warning" : "info"}>
                        {member.memberType === "ai" ? "IA" : "Humano"}
                      </Badge>
                    </div>
                  </div>
                  <span className="text-sm font-semibold text-text-primary tabular-nums">
                    {member.leadCount} leads
                  </span>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      {/* 5. Feature Overview Grid */}
      <div>
        <h2 className="text-lg font-semibold text-text-primary mb-4">Plataforma HNBCRM</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {existingFeatures(totalLeads, totalPipelineValue, stats, onTabChange).map((feature, idx) => (
            <FeatureCard key={idx} {...feature} />
          ))}
        </div>
      </div>

      {/* 6. Coming Soon Section */}
      <div>
        <div className="flex items-center gap-3 mb-4">
          <h2 className="text-lg font-semibold text-text-primary">Em Breve</h2>
          <Badge variant="warning">Próximas funcionalidades</Badge>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {comingSoonFeatures.map((feature, idx) => (
            <ComingSoonCard key={idx} {...feature} />
          ))}
        </div>
      </div>

      {/* 7. Recent Activity */}
      <Card>
        <h3 className="text-lg font-semibold text-text-primary mb-4">Atividade Recente</h3>
        {stats.recentActivities.length === 0 ? (
          <p className="text-text-muted">Nenhuma atividade recente.</p>
        ) : (
          <div className="space-y-3">
            {stats.recentActivities.map((activity) => {
              const badgeVariant = activityTypeBadges[activity.type] || "default";
              const typeLabel = activityTypeLabels[activity.type] || activity.type.replace("_", " ");

              return (
                <div key={activity._id} className="flex items-start gap-3 text-sm">
                  <Badge variant={badgeVariant} className="shrink-0">
                    {typeLabel}
                  </Badge>
                  <div className="flex-1 min-w-0">
                    <p className="text-text-primary truncate">{activity.content || typeLabel}</p>
                    <p className="text-text-muted text-xs">
                      {activity.actorName} · {new Date(activity.createdAt).toLocaleString("pt-BR")}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>
    </div>
  );
}

// ============================================================================
// Helper Components
// ============================================================================

interface BoardPipelineStats {
  boardId: string;
  boardName: string;
  boardColor: string;
  boardOrder: number;
  totalLeads: number;
  totalValue: number;
  stages: {
    stageId: string;
    stageName: string;
    stageColor: string;
    stageOrder: number;
    leadCount: number;
    totalValue: number;
    isClosedWon: boolean;
    isClosedLost: boolean;
  }[];
}

interface PipelineByBoardWidgetProps {
  pipelineStats: BoardPipelineStats[];
}

function PipelineByBoardWidget({ pipelineStats }: PipelineByBoardWidgetProps) {
  const [selectedBoardIdx, setSelectedBoardIdx] = useState(0);

  // Edge case: no boards
  if (pipelineStats.length === 0) {
    return (
      <Card>
        <h3 className="text-lg font-semibold text-text-primary mb-4">Pipeline por Board</h3>
        <p className="text-text-muted">Nenhum lead no pipeline ainda.</p>
      </Card>
    );
  }

  // Ensure selectedBoardIdx is valid
  const safeIdx = selectedBoardIdx >= 0 && selectedBoardIdx < pipelineStats.length ? selectedBoardIdx : 0;
  const selectedBoard = pipelineStats[safeIdx];

  return (
    <Card>
      <h3 className="text-lg font-semibold text-text-primary mb-4">Pipeline por Board</h3>

      {/* Board tabs (only show if 2+ boards) */}
      {pipelineStats.length > 1 && (
        <div className="flex gap-2 overflow-x-auto pb-3 mb-3">
          {pipelineStats.map((board, idx) => (
            <button
              key={board.boardId}
              onClick={() => setSelectedBoardIdx(idx)}
              className={cn(
                "flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium whitespace-nowrap transition-colors",
                idx === safeIdx
                  ? "bg-brand-600 text-white"
                  : "bg-surface-overlay text-text-secondary hover:bg-surface-raised"
              )}
            >
              <div
                className="w-2 h-2 rounded-full shrink-0"
                style={{ backgroundColor: board.boardColor }}
              />
              {board.boardName}
            </button>
          ))}
        </div>
      )}

      {/* Board summary */}
      <div className="flex items-center justify-between mb-3 pb-3 border-b border-border">
        <div className="flex items-center gap-2">
          <div
            className="w-2 h-2 rounded-full shrink-0"
            style={{ backgroundColor: selectedBoard.boardColor }}
          />
          <span className="text-sm font-medium text-text-primary">{selectedBoard.boardName}</span>
        </div>
        <span className="text-sm text-text-secondary tabular-nums">
          {selectedBoard.totalLeads} leads · R$ {selectedBoard.totalValue.toLocaleString("pt-BR")}
        </span>
      </div>

      {/* Stage breakdown */}
      <div className="space-y-3">
        {selectedBoard.stages.map((stage) => {
          const percentage =
            selectedBoard.totalValue > 0 ? (stage.totalValue / selectedBoard.totalValue) * 100 : 0;
          return (
            <div key={stage.stageId}>
              <div className="flex items-center justify-between mb-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-text-primary">{stage.stageName}</span>
                  {stage.isClosedWon && (
                    <Badge variant="success" className="text-[10px] px-1.5 py-0">
                      Ganho
                    </Badge>
                  )}
                  {stage.isClosedLost && (
                    <Badge variant="error" className="text-[10px] px-1.5 py-0">
                      Perdido
                    </Badge>
                  )}
                </div>
                <span className="text-sm text-text-secondary tabular-nums">
                  {stage.leadCount} leads · R$ {stage.totalValue.toLocaleString("pt-BR")}
                </span>
              </div>
              <div className="w-full bg-surface-sunken rounded-full h-2">
                <div
                  className="h-2 rounded-full transition-all duration-300"
                  style={{
                    width: `${Math.max(percentage, 2)}%`,
                    backgroundColor: stage.stageColor,
                  }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

interface StatCardProps {
  icon: React.ElementType;
  label: string;
  value: string;
  colorClass: string;
}

function StatCard({ icon: Icon, label, value, colorClass }: StatCardProps) {
  return (
    <Card>
      <div className="flex items-start gap-3">
        <div className={cn("h-8 w-8 rounded-lg flex items-center justify-center shrink-0", colorClass)}>
          <Icon size={18} />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm text-text-secondary truncate">{label}</p>
          <p className="text-2xl font-bold tabular-nums text-text-primary">{value}</p>
        </div>
      </div>
    </Card>
  );
}

interface QuickActionCardProps {
  icon: React.ElementType;
  label: string;
  onClick: () => void;
}

function QuickActionCard({ icon: Icon, label, onClick }: QuickActionCardProps) {
  return (
    <Card
      variant="interactive"
      onClick={onClick}
      className="min-w-[140px] shrink-0 md:min-w-0 md:shrink !p-3 flex items-center gap-3"
    >
      <Icon size={20} className="text-brand-400 shrink-0" />
      <span className="text-sm font-medium text-text-primary">{label}</span>
    </Card>
  );
}

interface FeatureCardProps {
  icon: React.ElementType;
  title: string;
  description: string;
  dataBadge?: string;
  tab: Tab;
  onClick: () => void;
}

function FeatureCard({ icon: Icon, title, description, dataBadge, onClick }: FeatureCardProps) {
  return (
    <Card variant="interactive" onClick={onClick} className="flex flex-col gap-3">
      <div className="flex items-start justify-between">
        <div className="h-10 w-10 rounded-xl bg-brand-500/10 flex items-center justify-center shrink-0">
          <Icon size={20} className="text-brand-400" />
        </div>
        {dataBadge && (
          <Badge variant="brand" className="text-xs">
            {dataBadge}
          </Badge>
        )}
      </div>
      <div>
        <h4 className="text-sm font-semibold text-text-primary">{title}</h4>
        <p className="text-xs text-text-muted mt-1 line-clamp-2">{description}</p>
      </div>
    </Card>
  );
}

interface ComingSoonCardProps {
  icon: React.ElementType;
  title: string;
  description: string;
}

function ComingSoonCard({ icon: Icon, title, description }: ComingSoonCardProps) {
  return (
    <Card className="flex flex-col gap-3 opacity-60">
      <div className="flex items-start justify-between">
        <div className="h-10 w-10 rounded-xl bg-surface-overlay flex items-center justify-center shrink-0">
          <Icon size={20} className="text-text-muted" />
        </div>
        <Badge variant="warning" className="text-xs">
          Em Breve
        </Badge>
      </div>
      <div>
        <h4 className="text-sm font-semibold text-text-secondary">{title}</h4>
        <p className="text-xs text-text-muted mt-1 line-clamp-2">{description}</p>
      </div>
    </Card>
  );
}

function LoadingSkeleton() {
  return (
    <div className="space-y-8 max-w-7xl">
      <div className="flex items-center gap-4">
        <Skeleton variant="circle" className="h-14 w-14 rounded-2xl" />
        <div className="space-y-2 flex-1">
          <Skeleton className="h-7 w-48" />
          <Skeleton className="h-4 w-72" />
        </div>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} variant="card" className="h-24" />
        ))}
      </div>
      <Skeleton variant="card" className="h-12" />
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Skeleton variant="card" className="h-48" />
        <Skeleton variant="card" className="h-48" />
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} variant="card" className="h-28" />
        ))}
      </div>
    </div>
  );
}

// ============================================================================
// Data
// ============================================================================

function existingFeatures(
  totalLeads: number,
  totalPipelineValue: number,
  stats: {
    pendingHandoffs: number;
    teamMemberCount: number;
  },
  onTabChange: (tab: Tab) => void
) {
  return [
    {
      icon: Kanban,
      title: "Pipeline Kanban",
      description: "Gerencie leads com drag-and-drop entre etapas configuráveis",
      dataBadge: `${totalLeads} leads`,
      tab: "board" as Tab,
      onClick: () => onTabChange("board"),
    },
    {
      icon: Target,
      title: "Gestão de Leads",
      description: "Qualificação BANT, temperatura, prioridade e campos personalizados",
      dataBadge: formatCurrency(totalPipelineValue),
      tab: "board" as Tab,
      onClick: () => onTabChange("board"),
    },
    {
      icon: Contact2,
      title: "Contatos",
      description: "Cadastro completo com busca por nome, email e empresa",
      tab: "contacts" as Tab,
      onClick: () => onTabChange("contacts"),
    },
    {
      icon: MessageSquare,
      title: "Conversas Multicanal",
      description: "WhatsApp, Telegram, email e webchat em uma caixa unificada",
      dataBadge: "Multicanal",
      tab: "inbox" as Tab,
      onClick: () => onTabChange("inbox"),
    },
    {
      icon: ArrowRightLeft,
      title: "Repasses IA-Humano",
      description: "Transferência inteligente de leads entre bots e humanos",
      dataBadge: stats.pendingHandoffs > 0 ? `${stats.pendingHandoffs} pendentes` : undefined,
      tab: "handoffs" as Tab,
      onClick: () => onTabChange("handoffs"),
    },
    {
      icon: Users,
      title: "Equipe Colaborativa",
      description: "Gerencie membros humanos e bots de IA como uma equipe unificada",
      dataBadge: `${stats.teamMemberCount} membros`,
      tab: "team" as Tab,
      onClick: () => onTabChange("team"),
    },
    {
      icon: ScrollText,
      title: "Auditoria Completa",
      description: "Histórico detalhado de todas as ações com filtros e exportação",
      dataBadge: "Exportável",
      tab: "audit" as Tab,
      onClick: () => onTabChange("audit"),
    },
    {
      icon: Globe,
      title: "API REST",
      description: "19 endpoints autenticados para integrações externas via X-API-Key",
      dataBadge: "19 endpoints",
      tab: "settings" as Tab,
      onClick: () => onTabChange("settings"),
    },
    {
      icon: Webhook,
      title: "Sistema de Webhooks",
      description: "Notificações em tempo real para eventos do CRM via HTTP",
      dataBadge: "Tempo real",
      tab: "settings" as Tab,
      onClick: () => onTabChange("settings"),
    },
    {
      icon: Bookmark,
      title: "Visões Salvas",
      description: "Filtros personalizados para leads e contatos com compartilhamento",
      tab: "board" as Tab,
      onClick: () => onTabChange("board"),
    },
  ];
}

const comingSoonFeatures = [
  {
    icon: Server,
    title: "Servidor MCP",
    description: "Protocolo de integração com agentes de IA externos e ferramentas",
  },
  {
    icon: Paperclip,
    title: "Arquivos e Anexos",
    description: "Upload e armazenamento de documentos vinculados a leads e conversas",
  },
  {
    icon: Zap,
    title: "Motor de Automações",
    description: "Regras automáticas para mover leads, atribuir e notificar a equipe",
  },
  {
    icon: Search,
    title: "Paleta de Comandos",
    description: "Busca rápida com Cmd+K para acessar qualquer recurso do CRM",
  },
  {
    icon: Layers,
    title: "Operações em Massa",
    description: "Atualizar, mover ou atribuir múltiplos leads de uma vez",
  },
  {
    icon: Bot,
    title: "Co-piloto IA",
    description: "Sugestões inteligentes de respostas e próximos passos para leads",
  },
  {
    icon: Bell,
    title: "Notificações",
    description: "Alertas em tempo real sobre leads, repasses e atividades da equipe",
  },
  {
    icon: FileUp,
    title: "Importar/Exportar",
    description: "Importação de CSV e exportação de dados em massa para planilhas",
  },
];

const activityTypeLabels: Record<string, string> = {
  created: "criado",
  stage_change: "mudança de etapa",
  assignment: "atribuição",
  message_sent: "mensagem enviada",
  handoff: "repasse",
  qualification_update: "qualificação",
  note: "nota",
};

const activityTypeBadges: Record<string, "success" | "brand" | "info" | "warning" | "default"> = {
  created: "success",
  stage_change: "brand",
  assignment: "info",
  message_sent: "info",
  handoff: "warning",
  qualification_update: "warning",
  note: "default",
};

function formatCurrency(value: number): string {
  if (value >= 1_000_000) return `R$ ${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `R$ ${(value / 1_000).toFixed(1)}k`;
  return `R$ ${value.toLocaleString("pt-BR")}`;
}
