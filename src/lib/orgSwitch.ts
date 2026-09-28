import { PATH_TO_TAB, TAB_ROUTES } from "./routes";

/**
 * Parâmetros de busca que só controlam a UI (seção/aba) e valem em qualquer
 * org. Todo o resto (`?conversation=`, `?task=`, `?lead=`, `?handoff=`,
 * `?campanha=`, `?post=`…) aponta para uma entidade da org ANTERIOR — as
 * queries autorizam pela org da entidade, então a tela da org nova mostraria
 * o registro da antiga ao lado das listas dela.
 */
const ORG_AGNOSTIC_PARAMS = new Set(["secao", "aba"]);

/**
 * Destino da navegação ao trocar de organização: mesma aba, sem deep-link de
 * entidade. Rotas com id no caminho (ex.: `/app/formularios/:formId`) sobem
 * para a raiz da aba; rota desconhecida cai no painel.
 */
export function pathAfterOrgSwitch(pathname: string, search: string): string {
  let basePath: string;
  if (PATH_TO_TAB[pathname]) {
    basePath = pathname;
  } else {
    const parent = Object.values(TAB_ROUTES).find((root) => pathname.startsWith(root + "/"));
    basePath = parent ?? TAB_ROUTES.dashboard;
  }

  const params = new URLSearchParams(search);
  const kept = new URLSearchParams();
  if (basePath === pathname) {
    params.forEach((value, key) => {
      if (ORG_AGNOSTIC_PARAMS.has(key)) kept.set(key, value);
    });
  }
  const query = kept.toString();
  return query ? `${basePath}?${query}` : basePath;
}

/**
 * Orgs que apareceram na lista desde a última visita (convite para outra org
 * enquanto a pessoa usava a atual). `known === null` = primeira vez neste
 * navegador: nada é "novo", só registra a linha de base.
 */
export function newlyAddedOrgIds(
  known: readonly string[] | null,
  current: readonly string[],
  ignore: ReadonlySet<string> = new Set()
): string[] {
  if (known === null) return [];
  const knownSet = new Set(known);
  return current.filter((id) => !knownSet.has(id) && !ignore.has(id));
}

export type EntityDeepLinkKind = "task" | "conversation" | "lead" | "handoff";

/** Parâmetro de URL → tipo de entidade (os deep-links de e-mail/notificação). */
const ENTITY_PARAMS: readonly EntityDeepLinkKind[] = ["task", "conversation", "lead", "handoff"];

/**
 * Primeiro deep-link de entidade da URL. Links de e-mail e notificação não
 * carregam a org, então quem é membro de duas orgs pode chegar com o item de
 * A estando em B — o AuthLayout resolve a org do item antes de mostrar.
 */
export function entityDeepLink(
  search: string
): { kind: EntityDeepLinkKind; id: string } | null {
  const params = new URLSearchParams(search);
  for (const kind of ENTITY_PARAMS) {
    const id = params.get(kind);
    if (id) return { kind, id };
  }
  return null;
}

/** `pathname + search` sem um parâmetro. */
export function withoutSearchParam(pathname: string, search: string, param: string): string {
  const params = new URLSearchParams(search);
  params.delete(param);
  const query = params.toString();
  return query ? `${pathname}?${query}` : pathname;
}
