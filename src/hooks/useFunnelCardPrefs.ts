import { useCallback, useEffect, useState } from "react";
import {
  funnelCardPrefsStorageKey,
  parseFunnelCardPrefs,
  serializeFunnelCardPrefs,
  type FunnelCardPrefs,
} from "@/lib/funnelCardPrefs";

function read(organizationId: string): FunnelCardPrefs {
  try {
    return parseFunnelCardPrefs(window.localStorage.getItem(funnelCardPrefsStorageKey(organizationId)));
  } catch {
    return parseFunnelCardPrefs(null);
  }
}

/** Preferência pessoal de exibição dos cartões do Funil, por organização (`localStorage`). */
export function useFunnelCardPrefs(organizationId: string) {
  const [state, setState] = useState(() => ({ organizationId, prefs: read(organizationId) }));

  // Troca de organização: relê a preferência da nova org.
  useEffect(() => {
    setState((cur) => (cur.organizationId === organizationId ? cur : { organizationId, prefs: read(organizationId) }));
  }, [organizationId]);

  const setPrefs = useCallback(
    (next: FunnelCardPrefs) => {
      setState({ organizationId, prefs: next });
      try {
        window.localStorage.setItem(funnelCardPrefsStorageKey(organizationId), serializeFunnelCardPrefs(next));
      } catch {
        // armazenamento indisponível: a escolha vale só nesta sessão
      }
    },
    [organizationId]
  );

  // Na troca de org, o primeiro render já usa a preferência da nova org (sem piscar a antiga).
  const prefs = state.organizationId === organizationId ? state.prefs : read(organizationId);
  return [prefs, setPrefs] as const;
}
