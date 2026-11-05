/**
 * Estado de uma lista com formulário em modal e confirmação de exclusão
 * (campos personalizados, origens, chaves, webhooks). Reducer puro; o hook
 * `useInlineCrud` só o liga ao React.
 */
export interface InlineCrudState<F> {
  showForm: boolean;
  /** `null` = criando; id = editando aquele item. */
  editingId: string | null;
  form: F;
  confirmDeleteId: string | null;
}

export type InlineCrudAction<F> =
  | { type: "startCreate" }
  | { type: "openForm" }
  | { type: "startEdit"; id: string; form: F }
  | { type: "cancel" }
  | { type: "saved" }
  | { type: "setForm"; form: F }
  | { type: "patchForm"; patch: Partial<F> }
  | { type: "askDelete"; id: string }
  | { type: "cancelDelete" }
  | { type: "confirmDelete" };

export function initialInlineCrud<F>(emptyForm: F): InlineCrudState<F> {
  return { showForm: false, editingId: null, form: emptyForm, confirmDeleteId: null };
}

/** `emptyForm` é o formulário em branco usado ao criar e depois de salvar. */
export function inlineCrudReducer<F>(
  state: InlineCrudState<F>,
  action: InlineCrudAction<F>,
  emptyForm: F
): InlineCrudState<F> {
  switch (action.type) {
    case "startCreate":
      return { ...state, showForm: true, editingId: null, form: emptyForm };
    case "openForm":
      // Só abre o modal; o rascunho (nome, agente, validade) fica como estava.
      return { ...state, showForm: true };
    case "startEdit":
      return { ...state, showForm: true, editingId: action.id, form: action.form };
    case "cancel":
      // Mantém o rascunho: o formulário só é zerado ao criar de novo ou salvar.
      return { ...state, showForm: false, editingId: null };
    case "saved":
      return { ...state, showForm: false, editingId: null, form: emptyForm };
    case "setForm":
      return { ...state, form: action.form };
    case "patchForm":
      return { ...state, form: { ...state.form, ...action.patch } };
    case "askDelete":
      return { ...state, confirmDeleteId: action.id };
    case "cancelDelete":
    case "confirmDelete":
      return { ...state, confirmDeleteId: null };
  }
}
