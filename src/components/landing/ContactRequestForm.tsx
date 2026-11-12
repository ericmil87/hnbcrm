import { useState } from "react";
import { Button } from "@/components/ui/Button";
import type { ButtonProps } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { Textarea } from "@/components/ui/Textarea";
import { contactHref, type ContactTopic } from "@/lib/contactHref";
import { submitContactRequest, type ContactRequestResult } from "@/lib/contactRequest";

type Submit = typeof submitContactRequest;

const NEED_LABEL: Record<ContactTopic, string> = {
  implantacao: "O que você quer resolver",
  consultoria: "O que você quer resolver",
  empresa: "O que você precisa",
};

interface ContactRequestFormProps {
  topic: ContactTopic;
  onClose?: () => void;
  /** Injetável nos testes. */
  submit?: Submit;
}

/** Formulário curto que vira lead na equipe do HNBCRM; cai para o e-mail se não puder enviar. */
export function ContactRequestForm({ topic, onClose, submit = submitContactRequest }: ContactRequestFormProps) {
  const [values, setValues] = useState({ name: "", email: "", phone: "", business: "", teamSize: "", need: "", trap: "" });
  const [state, setState] = useState<"idle" | "sending" | "done">("idle");
  const [failure, setFailure] = useState<Extract<ContactRequestResult, { ok: false }> | null>(null);
  const set = (k: keyof typeof values) => (e: { target: { value: string } }) =>
    setValues((v) => ({ ...v, [k]: e.target.value }));

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (state === "sending") return;
    setState("sending");
    setFailure(null);
    const result = await submit({
      name: values.name,
      email: values.email,
      need: values.need,
      kind: topic,
      ...(values.phone ? { phone: values.phone } : {}),
      ...(values.business ? { business: values.business } : {}),
      ...(values.teamSize ? { teamSize: values.teamSize } : {}),
      _honeypot: values.trap,
    });
    if (result.ok) {
      setState("done");
      return;
    }
    setFailure(result);
    setState("idle");
  }

  if (state === "done") {
    return (
      <div className="space-y-4" role="status">
        <p className="text-text-primary">Recebemos seu pedido. Vamos responder por e-mail em breve.</p>
        {onClose && (
          <Button variant="secondary" size="lg" className="w-full" onClick={onClose}>
            Fechar
          </Button>
        )}
      </div>
    );
  }

  const fallback = failure && (failure.code === "unavailable" || failure.code === "error");

  return (
    <form onSubmit={onSubmit} className="space-y-3">
      <Input label="Nome" name="name" autoComplete="name" required maxLength={80} value={values.name} onChange={set("name")} />
      <Input label="E-mail" name="email" type="email" autoComplete="email" required maxLength={254} value={values.email} onChange={set("email")} />
      <Input label="Telefone (opcional)" name="phone" type="tel" autoComplete="tel" maxLength={30} value={values.phone} onChange={set("phone")} />
      <Input label="Seu negócio" name="business" maxLength={120} value={values.business} onChange={set("business")} />
      <Input label="Tamanho da equipe" name="teamSize" maxLength={30} placeholder="Ex.: 5 pessoas" value={values.teamSize} onChange={set("teamSize")} />
      <Textarea label={NEED_LABEL[topic]} name="need" required maxLength={1000} rows={4} value={values.need} onChange={set("need")} />
      <div aria-hidden="true" className="absolute -left-[9999px] h-0 w-0 overflow-hidden">
        <label>
          Não preencha
          <input name="website" tabIndex={-1} autoComplete="off" value={values.trap} onChange={set("trap")} />
        </label>
      </div>
      <p className="text-xs text-text-muted">
        Usamos estes dados só para entrarmos em contato sobre o seu pedido. Veja a{" "}
        <a href="/privacidade" className="text-brand-400 underline">
          Política de Privacidade
        </a>
        .
      </p>
      {failure && (
        <p role="alert" className="text-sm text-semantic-error">
          {failure.message}
        </p>
      )}
      {fallback && (
        <a href={contactHref(topic)} className="block text-sm font-medium text-brand-400 underline">
          Enviar por e-mail
        </a>
      )}
      <Button type="submit" size="lg" className="w-full" loading={state === "sending"}>
        Enviar pedido
      </Button>
    </form>
  );
}

interface ContactRequestButtonProps {
  topic: ContactTopic;
  children: React.ReactNode;
  variant?: ButtonProps["variant"];
  size?: ButtonProps["size"];
  className?: string;
}

/** Botão que abre o formulário num modal (substitui o link mailto dos botões de contato). */
export function ContactRequestButton({ topic, children, variant, size, className }: ContactRequestButtonProps) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button type="button" variant={variant} size={size} className={className} onClick={() => setOpen(true)}>
        {children}
      </Button>
      <Modal open={open} onClose={() => setOpen(false)} title="Falar com a gente">
        <ContactRequestForm topic={topic} onClose={() => setOpen(false)} />
      </Modal>
    </>
  );
}
