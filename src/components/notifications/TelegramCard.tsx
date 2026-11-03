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

          <div className="flex min-h-[44px] items-center justify-between gap-3 py-3">
            <div className="min-w-0">
              <span className="text-sm text-text-muted">
                Relatório de manhã {formatHour(link.reports.morningHour)} · Fim do dia{" "}
                {formatHour(link.reports.eveningHour)}
              </span>
              <p className="text-xs text-text-muted">Disponível em breve</p>
            </div>
            <Switch checked={link.reports.enabled} onChange={() => {}} label="Relatórios no Telegram" disabled />
          </div>
        </div>

        <span className="inline-flex items-center rounded-full bg-surface-overlay px-3 py-1 text-xs text-text-secondary">
          Modo: {link.assistant.mode === "auto" ? "Automático" : "Sugestão"}
        </span>
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
        <div>{body}</div>
      </div>
    </Card>
  );
}
