import { LEGAL_ENTITY, legalIdentification, type LegalEntity } from "@/lib/legalEntity";

interface LegalIdentificationProps {
  entity?: LegalEntity;
  className?: string;
}

/** Quem vende: nome, CPF/CNPJ, endereço e e-mails (Decreto 7.962/2013). */
export function LegalIdentification({ entity = LEGAL_ENTITY, className }: LegalIdentificationProps) {
  const id = legalIdentification(entity);
  return (
    <address className={className ?? "text-caption not-italic text-text-muted"}>
      <span>{id.name}</span>
      {" · "}
      {id.incomplete ? (
        <span>CPF/CNPJ e endereço: em atualização</span>
      ) : (
        <span>
          {id.document.replace(/\D/g, "").length === 14 ? "CNPJ" : "CPF"} {id.document} · {id.address}
        </span>
      )}
      {" · "}
      <a href={`mailto:${entity.email}`} className="underline underline-offset-2 hover:text-text-primary">
        {entity.email}
      </a>
      {" · Encarregado de dados: "}
      <a href={`mailto:${entity.dpoEmail}`} className="underline underline-offset-2 hover:text-text-primary">
        {entity.dpoEmail}
      </a>
    </address>
  );
}
