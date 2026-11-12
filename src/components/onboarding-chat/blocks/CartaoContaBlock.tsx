import { useEffect, useState, type FormEvent } from "react";
import { useMutation, useQuery } from "convex/react";
import { CheckCircle2, UserCheck } from "lucide-react";
import { api } from "../../../../convex/_generated/api";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import {
  confirmResultMessage,
  isEmailCodeComplete,
  normalizeEmailCode,
  requestResultMessage,
  resendWaitSeconds,
  type ConfirmReason,
  type RequestReason,
} from "@/lib/onboardingAccount";
import { BlockCard } from "./BlockCard";
import type { BlockProps } from "./types";

export interface CartaoContaViewProps {
  /** E-mail já confirmado (bloco do servidor ou status ao vivo). */
  verified: boolean;
  note?: string;
  /** Do `getEmailVerificationStatus` (cooldown do último código). */
  canResendAt?: number;
  onRequest: () => Promise<{ sent: boolean; reason?: RequestReason; canResendAt?: number }>;
  onConfirm: (code: string) => Promise<{ verified: boolean; reason?: ConfirmReason; attemptsLeft?: number }>;
  /** Relógio injetável (teste). */
  nowFn?: () => number;
}

/**
 * `cartaoConta` (apresentação): confirmado = estado ok; senão pede o código
 * (nada é enviado sozinho: "Enviar código" é um clique), campo de 6 dígitos com
 * `one-time-code`, reenvio com espera. Explica que os materiais liberam depois.
 */
export function CartaoContaView({ verified, note, canResendAt, onRequest, onConfirm, nowFn = Date.now }: CartaoContaViewProps) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState<"request" | "confirm" | null>(null);
  const [message, setMessage] = useState<{ text: string; tone: "info" | "error" } | null>(null);
  const [done, setDone] = useState(false);
  const [resendAt, setResendAt] = useState<number | undefined>(canResendAt);
  const [now, setNow] = useState(() => nowFn());

  useEffect(() => {
    if (canResendAt !== undefined) setResendAt((cur) => Math.max(cur ?? 0, canResendAt));
  }, [canResendAt]);

  const wait = resendWaitSeconds(resendAt, now);
  useEffect(() => {
    if (wait <= 0) return;
    const id = window.setInterval(() => setNow(nowFn()), 1000);
    return () => window.clearInterval(id);
  }, [wait > 0, nowFn]); // eslint-disable-line react-hooks/exhaustive-deps

  if (verified || done) {
    return (
      <BlockCard title="Sua conta" icon={UserCheck} note={note}>
        <p role="status" className="flex items-start gap-2 text-sm text-text-primary">
          <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-semantic-success" aria-hidden="true" />
          E-mail confirmado. Já dá para enviar site, PDF, imagem ou áudio.
        </p>
      </BlockCard>
    );
  }

  const request = async () => {
    setBusy("request");
    setMessage(null);
    try {
      const r = await onRequest();
      if (r.reason === "already_verified") setDone(true);
      if (typeof r.canResendAt === "number") {
        setResendAt(r.canResendAt);
        setNow(nowFn());
      }
      setMessage({ text: requestResultMessage(r), tone: r.sent ? "info" : "error" });
    } catch {
      setMessage({ text: "Não foi possível enviar o código. Tente de novo.", tone: "error" });
    } finally {
      setBusy(null);
    }
  };

  const confirm = async (e: FormEvent) => {
    e.preventDefault();
    if (!isEmailCodeComplete(code)) return;
    setBusy("confirm");
    setMessage(null);
    try {
      const r = await onConfirm(code);
      if (r.verified) {
        setDone(true);
        return;
      }
      setMessage({ text: confirmResultMessage(r), tone: "error" });
    } catch {
      setMessage({ text: confirmResultMessage({ verified: false }), tone: "error" });
    } finally {
      setBusy(null);
    }
  };

  return (
    <BlockCard title="Confirme o seu e-mail" icon={UserCheck} note={note}>
      <p className="text-sm text-text-secondary">
        Para liberar o envio de site, PDF, imagem e áudio, confirme o e-mail da sua conta com um código de 6 dígitos.
      </p>
      <form onSubmit={(e) => void confirm(e)} className="mt-3 space-y-2" noValidate>
        <Input
          id="onboarding-email-code"
          label="Código de 6 dígitos"
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={7}
          placeholder="000000"
          value={code}
          onChange={(e) => setCode(normalizeEmailCode(e.target.value))}
          disabled={busy !== null}
          className="tabular-nums tracking-widest"
        />
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="secondary" loading={busy === "request"} disabled={busy !== null || wait > 0} onClick={() => void request()}>
            {wait > 0 ? (
              <>
                Reenviar código em <span className="tabular-nums">{wait}</span> s
              </>
            ) : resendAt !== undefined ? (
              "Reenviar código"
            ) : (
              "Enviar código"
            )}
          </Button>
          <Button type="submit" loading={busy === "confirm"} disabled={busy !== null || !isEmailCodeComplete(code)}>
            Confirmar
          </Button>
        </div>
      </form>
      <div aria-live="polite" className="mt-2">
        {message && (
          <p className={message.tone === "error" ? "text-sm text-semantic-error" : "text-sm text-text-secondary"}>{message.text}</p>
        )}
      </div>
    </BlockCard>
  );
}

/** Container: estado ao vivo do e-mail e as mutations de código. */
export function CartaoContaBlock({ block }: BlockProps<"cartaoConta">) {
  const status = useQuery(api.emailVerification.getEmailVerificationStatus, block.emailVerified ? "skip" : {});
  const requestCode = useMutation(api.emailVerification.requestEmailVerificationCode);
  const confirmCode = useMutation(api.emailVerification.confirmEmailVerificationCode);
  return (
    <CartaoContaView
      verified={block.emailVerified || status?.verified === true}
      note={block.note}
      canResendAt={status?.canResendAt}
      onRequest={() => requestCode({})}
      onConfirm={(code) => confirmCode({ code })}
    />
  );
}
