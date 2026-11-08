import { useEffect, useRef } from "react";
import { useLocation, useNavigate, useOutletContext } from "react-router";
import { toast } from "sonner";
import { Spinner } from "@/components/ui/Spinner";
import { TAB_ROUTES } from "@/lib/routes";
import { parseOpenLink, withOpenAction } from "@/lib/openLink";
import type { AppOutletContext } from "./AuthLayout";

interface OpenLinkRedirectProps {
  /** `location.search` de `/app/abrir?org=&to=`. */
  search: string;
  activeOrgId: string;
  /** Organizações do usuário (só entra em org da qual já é membro). */
  organizationIds: readonly string[];
  /** Troca de organização pelo mecanismo do AuthLayout, sem mexer na URL. */
  selectOrganization: (orgId: string) => void;
}

/**
 * `/app/abrir?org=&to=`: troca de organização e abre `to` (com replace, para o
 * "voltar" não cair de novo aqui). `to` só vale como caminho interno `/app/…`
 * (sem open redirect). Reusado pelo sino (multi-org) e pelo push (F1).
 */
export function OpenLinkRedirect({ search, activeOrgId, organizationIds, selectOrganization }: OpenLinkRedirectProps) {
  const navigate = useNavigate();
  const switchedRef = useRef(false);

  useEffect(() => {
    const link = parseOpenLink(search);
    if (!link) {
      toast.error("Este link não é válido.");
      navigate(TAB_ROUTES.dashboard, { replace: true });
      return;
    }
    if (!organizationIds.includes(link.org)) {
      toast.error("Você não tem acesso a essa organização.");
      navigate(TAB_ROUTES.dashboard, { replace: true });
      return;
    }
    if (link.org === activeOrgId) {
      navigate(withOpenAction(link.to, link.acao), { replace: true });
      return;
    }
    // Troca primeiro; o app remonta já na organização nova e este efeito
    // roda de novo com `activeOrgId` certo, aí navega.
    if (!switchedRef.current) {
      switchedRef.current = true;
      selectOrganization(link.org);
    }
  }, [search, activeOrgId, organizationIds, selectOrganization, navigate]);

  return (
    <div className="flex justify-center py-16" role="status" aria-label="Abrindo">
      <Spinner size="lg" />
    </div>
  );
}

export function OpenLinkPage() {
  const { organizationId, organizations, selectOrganization } = useOutletContext<AppOutletContext>();
  const { search } = useLocation();
  const ids = organizations.map((o) => o._id as string);
  // chave estável: a lista só muda de conteúdo quando entram/saem orgs
  const idsKey = ids.join(",");
  const stableIds = useStableList(ids, idsKey);
  return (
    <OpenLinkRedirect
      search={search}
      activeOrgId={organizationId}
      organizationIds={stableIds}
      selectOrganization={(orgId) => selectOrganization(orgId as AppOutletContext["organizationId"])}
    />
  );
}

function useStableList(list: string[], key: string): string[] {
  const ref = useRef({ key, list });
  if (ref.current.key !== key) ref.current = { key, list };
  return ref.current.list;
}
