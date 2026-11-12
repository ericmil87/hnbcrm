import { useId, useState } from "react";
import { Link } from "react-router";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { submitNewsletterSignup, type NewsletterSignupResult } from "@/lib/newsletter";
import { COMMUNITY_COPY } from "./manifestoCopy";

type Submit = typeof submitNewsletterSignup;

interface NewsletterFormProps {
  /** Onde o formulário aparece ("landing", "manifesto"). */
  source: string;
  /** Injetável nos testes. */
  submit?: Submit;
}

/** Inscrição na lista de novidades; o sucesso substitui o formulário. */
export function NewsletterForm({ source, submit = submitNewsletterSignup }: NewsletterFormProps) {
  const copy = COMMUNITY_COPY.newsletter;
  const uid = useId();
  const [values, setValues] = useState({ name: "", email: "", trap: "" });
  const [state, setState] = useState<"idle" | "sending" | "done">("idle");
  const [failure, setFailure] = useState<Extract<NewsletterSignupResult, { ok: false }> | null>(null);
  const set = (k: keyof typeof values) => (e: { target: { value: string } }) =>
    setValues((v) => ({ ...v, [k]: e.target.value }));

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (state === "sending") return;
    setState("sending");
    setFailure(null);
    const name = values.name.trim();
    const result = await submit({
      email: values.email.trim(),
      ...(name ? { name } : {}),
      source,
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
      <p role="status" className="text-text-primary">
        {copy.success}
      </p>
    );
  }

  return (
    <form onSubmit={onSubmit} className="relative space-y-3">
      <Input
        label={copy.nameLabel}
        id={`${uid}-name`}
        name="name"
        autoComplete="name"
        maxLength={80}
        value={values.name}
        onChange={set("name")}
      />
      <Input
        label={copy.emailLabel}
        id={`${uid}-email`}
        name="email"
        type="email"
        autoComplete="email"
        required
        maxLength={254}
        placeholder={copy.emailPlaceholder}
        value={values.email}
        onChange={set("email")}
      />
      <div aria-hidden="true" className="absolute -left-[9999px] h-0 w-0 overflow-hidden">
        <label>
          Não preencha
          <input name="website" tabIndex={-1} autoComplete="off" value={values.trap} onChange={set("trap")} />
        </label>
      </div>
      <p className="text-caption text-text-muted">
        {copy.consent} Veja a{" "}
        <Link to="/privacidade" className="text-brand-400 underline">
          Política de Privacidade
        </Link>
        .
      </p>
      {failure && (
        <p role="alert" className="text-sm text-semantic-error">
          {failure.message}
        </p>
      )}
      <Button type="submit" size="lg" className="w-full" loading={state === "sending"}>
        {copy.cta}
      </Button>
    </form>
  );
}
