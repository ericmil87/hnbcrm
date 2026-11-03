import { useEffect, useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { toast } from "sonner";
import { QRCodeSVG } from "qrcode.react";
import { Send, ExternalLink, Copy, Check, TriangleAlert, Unplug, RefreshCw } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Spinner";
import { Switch } from "@/components/settings/CentralSection";
import { usePermissions } from "@/hooks/usePermissions";
import { cn } from "@/lib/utils";
import { mutationErrorMessage } from "@/lib/errors";
import {
  formatClock,
  formatCountdown,
  formatDayMonth,
  formatHour,
  isExpired,
  telegramDisplayName,
} from "@/lib/telegramLink";

interface TelegramCardProps {
  organizationId: Id<"organizations">;
}

export function TelegramCard({ organizationId }: TelegramCardProps) {
  const data = useQuery(api.telegram.getMyLink, { organizationId });
  const { can } = usePermissions(organizationId);
  const setOrgModules = useMutation(api.orgModules.setOrgModules);
  const createLinkCode = useMutation(api.telegram.createLinkCode);
  const unlink = useMutation(api.telegram.unlink);
  const updatePrefs = useMutation(api.telegram.updateMyLinkPrefs);
  const updateOrgSettings = useMutation(api.telegram.updateOrgTelegramSettings);

  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState<{ url: string; expiresAt: number } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [copied, setCopied] = useState(false);
  const [confirmUnlink, setConfirmUnlink] = useState(false);

  // Tick only while a link code is on screen.
  useEffect(() => {
    if (!code) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [code]);

  // Once connected, the pending code is irrelevant.
  const activeLink = data?.link?.status === "active";
  useEffect(() => {
    if (activeLink) {
      setCode(null);
      setConfirmUnlink(false);
    }
  }, [activeLink]);

  if (data === undefined) {
    return (
      <Card>
        <div className="flex justify-center py-6">
          <Spinner size="md" />
        </div>
      </Card>
    );
  }

  const { moduleEnabled, botUsername, link } = data;
  const isAdmin = can("settings", "manage");

  const run = async (fn: () => Promise<unknown>, fallback: string, success?: string) => {
    setBusy(true);
    try {
      await fn();
      if (success) toast.success(success);
    } catch (error) {
      toast.error(mutationErrorMessage(error, fallback));
    } finally {
      setBusy(false);
    }
  };

  const generate = () =>
    run(async () => {
      const result = await createLinkCode({ organizationId });
      setNow(Date.now());
      setCopied(false);
      setCode(result);
    }, "Não foi possível gerar o link do Telegram");

  const copy = async () => {
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Não foi possível copiar o link");
    }
  };


  const renderAssistant = (l: NonNullable<typeof link>) => {
    const a = l.assistant;
    const autoAllowedOrg = data.org.allowAutoMode;
    const isAuto = a.mode === "auto";
    const save = (assistant: Parameters<typeof updatePrefs>[0]["assistant"]) =>
      run(() => updatePrefs({ organizationId, assistant }), "Não foi possível salvar o assistente");
    const modes = [
      {
        value: "suggest" as const,
        label: "Sugestão",
        desc: "Eu proponho, você confirma. Nada vai para o cliente sem o seu toque.",
      },
      {
        value: "auto" as const,
        label: "Automático",
        desc: `Eu decido e executo; o que for para o cliente fica ${a.autoSendDelaySeconds} s na sua tela para você cancelar ou regenerar. Tudo tem Desfazer.`,
      },
    ];
    const actions = [
      { key: "instructAi", label: "Instruir a IA" },
      { key: "createTask", label: "Criar tarefa" },
      { key: "moveStage", label: "Mover etapa" },
      { key: "acceptHandoff", label: "Aceitar repasse" },
      { key: "replyCustomer", label: "Responder ao cliente" },
    ] as const;
    return (
      <div className="space-y-3 border-t border-border pt-4">
        <h4 className="text-sm font-semibold text-text-primary">Assistente</h4>
        <div role="radiogroup" aria-label="Modo do assistente" className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {modes.map((m) => {
            const selected = a.mode === m.value;
            const disabled = busy || (m.value === "auto" && !autoAllowedOrg);
            return (
              <button
                key={m.value}
                type="button"
                role="radio"
                aria-checked={selected}
                disabled={disabled}
                onClick={() => !selected && void save({ mode: m.value })}
                className={cn(
                  "min-h-[44px] rounded-card border px-3.5 py-2.5 text-left transition-colors focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-2 focus:ring-offset-surface-base disabled:cursor-not-allowed disabled:opacity-50",
                  selected ? "border-brand-500 bg-brand-500/10" : "border-border hover:bg-surface-overlay"
                )}
              >
                <span className="block text-sm font-medium text-text-primary">{m.label}</span>
                <span className="block text-xs text-text-secondary">
                  {m.value === "auto" && !autoAllowedOrg ? "Desligado pela organização" : m.desc}
                </span>
              </button>
            );
          })}
        </div>
        {a.autoPausedAt !== undefined && !isAuto && (
          <div className="flex items-start gap-2 rounded-lg border border-semantic-warning/30 bg-semantic-warning/10 px-3.5 py-2.5 text-xs text-text-secondary">
            <TriangleAlert size={14} className="mt-0.5 shrink-0 text-semantic-warning" aria-hidden="true" />
            <span>
              Pausado automaticamente após 3 desfazeres na última hora; escolha Automático de novo para religar.
            </span>
          </div>
        )}
        <div className="flex min-h-[44px] items-center justify-between gap-3">
          <span className="text-sm text-text-primary">
            Sugerir ação nos repasses (uma chamada de IA por repasse)
          </span>
          <Switch
            checked={a.suggestOnEvents}
            label="Sugerir ação nos repasses"
            disabled={busy}
            onChange={() => void save({ suggestOnEvents: !a.suggestOnEvents })}
          />
        </div>
        <div className={cn(!isAuto && "opacity-50")}>
          <label htmlFor="tg-auto-delay" className="mb-1 block text-xs text-text-secondary">
            Segundos para cancelar um envio no automático
          </label>
          <input
            id="tg-auto-delay"
            type="number"
            inputMode="numeric"
            min={5}
            max={120}
            defaultValue={a.autoSendDelaySeconds}
            key={a.autoSendDelaySeconds}
            disabled={busy}
            onBlur={(e) => {
              const n = Math.min(120, Math.max(5, Math.round(Number(e.target.value) || 15)));
              if (n !== a.autoSendDelaySeconds) void save({ autoSendDelaySeconds: n });
              else e.target.value = String(n);
            }}
            className="w-full min-h-[44px] bg-surface-raised border border-border-strong text-text-primary rounded-field px-3.5 py-2.5 text-base md:text-sm focus:outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20 sm:w-40"
          />
        </div>
        <fieldset className={cn("space-y-1", !isAuto && "opacity-50")}>
          <legend className="mb-1 text-xs text-text-secondary">No automático ela pode</legend>
          {actions.map(({ key, label }) => (
            <label key={key} className="flex min-h-[44px] cursor-pointer items-center gap-3">
              <input
                type="checkbox"
                checked={a.autoAllowed[key]}
                disabled={busy}
                onChange={() => void save({ autoAllowed: { [key]: !a.autoAllowed[key] } })}
                className="h-5 w-5 rounded border-border-strong accent-brand-600"
              />
              <span className="text-sm text-text-primary">
                {label}
                {key === "replyCustomer" && (
                  <span className="block text-xs text-text-muted">
                    sempre com os {a.autoSendDelaySeconds} s para cancelar
                  </span>
                )}
              </span>
            </label>
          ))}
        </fieldset>
      </div>
    );
  };

  const renderConnectFlow = () => {
    const expired = code ? isExpired(code.expiresAt, now) : false;
    return (
      <div className="mt-4 space-y-4">
        {!botUsername && (
          <p className="text-sm text-text-secondary">Telegram não está configurado neste ambiente.</p>
        )}
        {(!code || expired) && (
          <>
            {expired && (
              <p className="text-xs text-semantic-warning">O link expirou. Gere outro para conectar.</p>
            )}
            <Button
              variant="primary"
              className="min-h-[44px]"
              onClick={generate}
              disabled={busy || !botUsername}
            >
              <Send size={16} aria-hidden="true" />
              {busy ? "Gerando..." : "Conectar Telegram"}
            </Button>
          </>
        )}
        {code && !expired && (
          <div className="space-y-3">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
              <div className="self-start rounded-lg bg-white p-3" aria-label="QR code do link do Telegram">
                <QRCodeSVG value={code.url} size={192} bgColor="#ffffff" fgColor="#000000" />
              </div>
              <div className="min-w-0 flex-1 space-y-3">
                <div className="flex flex-wrap gap-2">
                  <a
                    href={code.url}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex min-h-[44px] items-center justify-center gap-2 rounded-full bg-brand-600 px-5 text-sm font-semibold text-white transition-colors hover:bg-brand-700 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-2 focus:ring-offset-surface-base"
                  >
                    <ExternalLink size={16} aria-hidden="true" />
                    Abrir no Telegram
                  </a>
                  <Button variant="secondary" className="min-h-[44px]" onClick={copy}>
                    {copied ? <Check size={16} aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />}
                    {copied ? "Copiado" : "Copiar link"}
                  </Button>
                  <Button variant="ghost" className="min-h-[44px]" onClick={generate} disabled={busy}>
                    <RefreshCw size={16} aria-hidden="true" />
                    Gerar outro link
                  </Button>
                </div>
                <p className="text-xs text-text-secondary">
                  O link vale por 10 minutos e só funciona uma vez. Abra no celular com o Telegram instalado.
                </p>
                <p className="text-xs text-text-muted">
                  Expira às {formatClock(code.expiresAt)} (faltam {formatCountdown(code.expiresAt, now)})
                </p>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  };

  let body: React.ReactNode;

  if (!moduleEnabled) {
    body = (
      <div className="mt-4 space-y-3">
        <p className="text-sm text-text-secondary">
          Receba repasses, tarefas e alertas no Telegram e fale com o Copiloto pelo celular. Mensagens de clientes
          passam a existir no Telegram, por isso um administrador precisa ligar o módulo.
        </p>
        {isAdmin ? (
          <div className="flex min-h-[44px] items-center justify-between gap-3 rounded-lg border border-border px-3.5">
            <span className="text-sm font-medium text-text-primary">Ligar Telegram para a equipe</span>
            <Switch
              checked={false}
              onChange={() =>
                void run(
                  () => setOrgModules({ organizationId, modules: { telegram: true } }),
                  "Não foi possível ligar o módulo do Telegram",
                  "Telegram ligado para a equipe"
                )
              }
              label="Ligar Telegram para a equipe"
              disabled={busy}
            />
          </div>
        ) : (
          <p className="text-sm text-text-muted">Peça a um administrador para ligar o módulo.</p>
        )}
      </div>
    );
  } else if (link && link.status === "active") {
    body = (
      <div className="mt-4 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-text-primary">
            Conectado como <span className="font-medium">{telegramDisplayName(link)}</span> · desde{" "}
            {formatDayMonth(link.linkedAt)}
          </p>
          {confirmUnlink ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-text-secondary">Desconectar o Telegram?</span>
              <Button
                variant="danger"
                className="min-h-[44px]"
                disabled={busy}
                onClick={() =>
                  void run(() => unlink({ organizationId }), "Não foi possível desconectar", "Telegram desconectado")
                }
              >
                Desconectar
              </Button>
              <Button variant="secondary" className="min-h-[44px]" onClick={() => setConfirmUnlink(false)}>
                Cancelar
              </Button>
            </div>
          ) : (
            <Button variant="secondary" className="min-h-[44px]" onClick={() => setConfirmUnlink(true)}>
              <Unplug size={16} aria-hidden="true" />
              Desconectar
            </Button>
          )}
        </div>

        <div className="divide-y divide-border">
          {(
            [
              { key: "relayAssignedConversations", label: "Receber as mensagens das conversas que eu atendo" },
              { key: "mediaInbound", label: "Receber fotos e áudios dos clientes" },
            ] as const
          ).map(({ key, label }) => (
            <div key={key} className="flex min-h-[44px] items-center justify-between gap-3 py-3">
              <span className="text-sm text-text-primary">{label}</span>
              <Switch
                checked={link.prefs[key]}
                label={label}
                disabled={busy}
                onChange={() =>
                  void run(
                    () => updatePrefs({ organizationId, prefs: { [key]: !link.prefs[key] } }),
                    "Não foi possível salvar a preferência"
                  )
                }
              />
            </div>
          ))}

          <div className="space-y-3 py-3">
            <div className="flex min-h-[44px] items-center justify-between gap-3">
              <span className="text-sm font-medium text-text-primary">Relatórios diários</span>
            </div>
            <div className="flex min-h-[44px] items-center justify-between gap-3">
              <span className="text-sm text-text-primary">Receber relatórios no Telegram</span>
              <Switch
                checked={link.reports.enabled}
                label="Receber relatórios no Telegram"
                disabled={busy}
                onChange={() =>
                  void run(
                    () => updatePrefs({ organizationId, reports: { enabled: !link.reports.enabled } }),
                    "Não foi possível salvar a preferência"
                  )
                }
              />
            </div>
            <div className={cn("grid grid-cols-1 gap-3 sm:grid-cols-2", !link.reports.enabled && "opacity-50")}>
              {(
                [
                  { key: "morningHour", label: "Manhã", id: "tg-morning-hour" },
                  { key: "eveningHour", label: "Fim do dia", id: "tg-evening-hour" },
                ] as const
              ).map(({ key, label, id }) => (
                <div key={key}>
                  <label htmlFor={id} className="mb-1 block text-xs text-text-secondary">
                    {label}
                  </label>
                  <select
                    id={id}
                    value={link.reports[key]}
                    disabled={busy || !link.reports.enabled}
                    onChange={(e) =>
                      void run(
                        () => updatePrefs({ organizationId, reports: { [key]: Number(e.target.value) } }),
                        "Não foi possível salvar o horário"
                      )
                    }
                    className="w-full min-h-[44px] bg-surface-raised border border-border-strong text-text-primary rounded-field px-3.5 py-2.5 text-base md:text-sm focus:outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20 disabled:cursor-not-allowed"
                  >
                    {Array.from({ length: 24 }, (_, h) => (
                      <option key={h} value={h}>
                        {formatHour(h)}
                      </option>
                    ))}
                  </select>
                </div>
              ))}
            </div>
            <p className="text-xs text-text-muted">Hora local da organização.</p>
            <div className={cn("flex min-h-[44px] items-center justify-between gap-3", !link.reports.enabled && "opacity-50")}>
              <span className="text-sm text-text-primary">Também aos fins de semana</span>
              <Switch
                checked={link.reports.weekends ?? false}
                label="Também aos fins de semana"
                disabled={busy || !link.reports.enabled}
                onChange={() =>
                  void run(
                    () => updatePrefs({ organizationId, reports: { weekends: !(link.reports.weekends ?? false) } }),
                    "Não foi possível salvar a preferência"
                  )
                }
              />
            </div>
            <p className="text-xs text-text-muted">
              De manhã: repasses pendentes, follow-ups da IA, suas tarefas, leads novos e conversas não lidas. No fim
              do dia: leads, ganhos e perdidos, tarefas, repasses sem dono e custo de IA. /hoje no bot manda o da
              manhã a qualquer hora.
            </p>
          </div>
        </div>

        {renderAssistant(link)}
      </div>
    );
  } else {
    const blocked = link?.status === "blocked";
    body = (
      <>
        {blocked && (
          <div className="mt-4 flex items-start gap-2 rounded-lg border border-semantic-warning/30 bg-semantic-warning/10 px-3.5 py-2.5 text-sm text-text-secondary">
            <TriangleAlert size={16} className="mt-0.5 shrink-0 text-semantic-warning" aria-hidden="true" />
            <span>
              Seu Telegram bloqueou o bot. Desbloqueie {botUsername ? `@${botUsername}` : "o bot"} e conecte de
              novo.
            </span>
          </div>
        )}
        {renderConnectFlow()}
        {blocked && (
          <div className="mt-3">
            <Button
              variant="secondary"
              className="min-h-[44px]"
              disabled={busy}
              onClick={() =>
                void run(() => unlink({ organizationId }), "Não foi possível desconectar", "Telegram desconectado")
              }
            >
              <Unplug size={16} aria-hidden="true" />
              Desconectar
            </Button>
          </div>
        )}
      </>
    );
  }

  return (
    <Card>
      <div className="p-6">
        <div className="flex items-center gap-3">
          <Send size={20} className="text-brand-500" aria-hidden="true" />
          <h3 className="text-lg font-semibold text-text-primary">Telegram</h3>
        </div>
        <p className="sr-only" role="status" aria-live="polite">
          {!moduleEnabled
            ? "Telegram desligado para a equipe"
            : activeLink
              ? "Telegram conectado"
              : code && !isExpired(code.expiresAt, now)
                ? "Link do Telegram gerado"
                : "Telegram não conectado"}
        </p>
        {moduleEnabled && isAdmin && (
          <div className="mt-4 space-y-1">
            <div className="flex min-h-[44px] items-center justify-between gap-3 rounded-lg border border-border px-3.5">
              <span className="text-sm font-medium text-text-primary">Telegram para a equipe</span>
              <Switch
                checked
                onChange={() =>
                  void run(
                    () => setOrgModules({ organizationId, modules: { telegram: false } }),
                    "Não foi possível desligar o módulo do Telegram",
                    "Telegram desligado para a equipe"
                  )
                }
                label="Telegram para a equipe"
                disabled={busy}
              />
            </div>
            <p className="text-xs text-text-muted">
              Desligar faz o bot parar para todos da organização, mas os vínculos são mantidos e voltam a funcionar quando
              o módulo for ligado de novo.
            </p>
          </div>
        )}
        {moduleEnabled && data.canManage && (
          <div className="mt-4 space-y-1">
            <h4 className="text-sm font-semibold text-text-primary">Configurações da organização</h4>
            <div className="divide-y divide-border">
              {(
                [
                  {
                    key: "discreet",
                    label: "Modo discreto",
                    desc: "Cartões curtos (200 caracteres), sem telefone e sem nome completo do cliente; sem botão 'Abrir no WhatsApp' e sem 'Ver tudo'. Use se a organização não quer dados de clientes íntegros no Telegram.",
                  },
                  {
                    key: "protectContent",
                    label: "Proteger conteúdo",
                    desc: "Impede encaminhar e copiar as mensagens do bot no Telegram.",
                  },
                  {
                    key: "allowAutoMode",
                    label: "Permitir modo automático na organização",
                    desc: "Desligado, todo mundo fica em Sugestão.",
                  },
                ] as const
              ).map(({ key, label, desc }) => (
                <div key={key} className="flex min-h-[44px] items-start justify-between gap-3 py-3">
                  <div className="min-w-0">
                    <span className="text-sm font-medium text-text-primary">{label}</span>
                    <p className="text-xs text-text-secondary">{desc}</p>
                  </div>
                  <Switch
                    checked={data.org[key]}
                    label={label}
                    disabled={busy}
                    onChange={() =>
                      void run(
                        () => updateOrgSettings({ organizationId, [key]: !data.org[key] }),
                        "Não foi possível salvar a configuração"
                      )
                    }
                  />
                </div>
              ))}
            </div>
          </div>
        )}
        <div>{body}</div>
      </div>
    </Card>
  );
}
