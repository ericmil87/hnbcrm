import { SUPPORTED_DEFAULT_COUNTRIES, resolveDefaultCountry } from "../../../convex/lib/orgPhone";
import { countryLabel } from "@/lib/defaultCountry";
import { timezoneOptions } from "@/lib/timezones";
import { useEffect, useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { Id } from "../../../convex/_generated/dataModel";
import { toast } from "sonner";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";


export function OrgProfilePanel({ organizationId }: { organizationId: Id<"organizations"> }) {
  const orgs = useQuery(api.organizations.getUserOrganizations);
  const updateOrganization = useMutation(api.organizations.updateOrganization);
  const org = orgs?.find((o) => o?._id === organizationId);

  const [name, setName] = useState("");
  const [timezone, setTimezone] = useState("");
  const [currency, setCurrency] = useState("");
  const [countryCode, setCountryCode] = useState("55");
  const [saving, setSaving] = useState(false);

  // Sincroniza o formulário com a org carregada — e de novo se a org mudar.
  // O antigo `useState(() => …)` rodava uma vez só, então trocar de org com a
  // tela aberta e clicar Salvar gravava nome/fuso/moeda da org anterior na nova.
  const orgLoaded = !!org;
  useEffect(() => {
    if (!org) return;
    setName(org.name || "");
    setTimezone(org.settings?.timezone || "UTC");
    setCurrency(org.settings?.currency || "USD");
    setCountryCode(resolveDefaultCountry(org.settings));
    // Só na chegada da org/troca de id: re-sincronizar a cada update reativo
    // apagaria o que a pessoa está digitando.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [organizationId, orgLoaded]);

  const handleSave = async () => {
    setSaving(true);
    try {
      await updateOrganization({
        organizationId,
        name,
        // Só o que esta tela edita: o servidor faz merge no resto de
        // `settings` (aiConfig, opt-out, campanhas) — reenviar uma cópia
        // lida antes sobrescreveria mudanças feitas em outra aba.
        settings: { timezone, currency, defaultCountryCode: countryCode },
      });
      toast.success("Organização atualizada");
    } catch (error) {
      toast.error("Não foi possível atualizar organização.");
    }
    setSaving(false);
  };

  return (
    <Card>
      <h3 className="text-lg font-semibold text-text-primary mb-4">Perfil da organização</h3>
      <div className="space-y-4 max-w-md">
        <Input
          label="Nome da organização"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />

        <div>
          <Select
            label="Fuso horário"
            value={timezone}
            onValueChange={setTimezone}
            options={timezoneOptions(timezone)}
          />
        </div>

        <div>
          <Select
            label="Moeda"
            value={currency}
            onValueChange={setCurrency}
            options={[
              { value: "USD", label: "USD ($)" },
              { value: "BRL", label: "BRL (R$)" },
              { value: "EUR", label: "EUR (€)" },
              { value: "GBP", label: "GBP (£)" },
              { value: "CAD", label: "CAD" },
              { value: "AUD", label: "AUD" },
            ]}
          />
        </div>

        <div>
          <Select
            id="org-default-country"
            label="País padrão dos telefones"
            hint="Usado quando um telefone é digitado ou importado sem o código do país (+DDI). Números com + sempre valem como digitados."
            value={countryCode}
            onValueChange={setCountryCode}
            options={SUPPORTED_DEFAULT_COUNTRIES.map((c) => ({
              value: c.dialCode,
              label: countryLabel(c),
            }))}
          />
        </div>

        <Button onClick={handleSave} disabled={saving}>
          {saving ? "Salvando..." : "Salvar"}
        </Button>
      </div>
    </Card>
  );
}

