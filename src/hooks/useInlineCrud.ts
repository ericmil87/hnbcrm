import { useCallback, useMemo, useReducer } from "react";
import { initialInlineCrud, inlineCrudReducer, type InlineCrudAction, type InlineCrudState } from "@/lib/inlineCrud";

/** Estado de lista + formulário em modal + confirmação de exclusão. */
export function useInlineCrud<F>(emptyForm: F) {
  // `emptyForm` é estável por chamada de uso (constante do módulo ou memo).
  const reducer = useCallback(
    (s: InlineCrudState<F>, a: InlineCrudAction<F>) => inlineCrudReducer(s, a, emptyForm),
    [emptyForm]
  );
  const [state, dispatch] = useReducer(reducer, emptyForm, initialInlineCrud<F>);

  const actions = useMemo(
    () => ({
      startCreate: () => dispatch({ type: "startCreate" }),
      startEdit: (id: string, form: F) => dispatch({ type: "startEdit", id, form }),
      cancel: () => dispatch({ type: "cancel" }),
      saved: () => dispatch({ type: "saved" }),
      setForm: (form: F) => dispatch({ type: "setForm", form }),
      patchForm: (patch: Partial<F>) => dispatch({ type: "patchForm", patch }),
      askDelete: (id: string) => dispatch({ type: "askDelete", id }),
      cancelDelete: () => dispatch({ type: "cancelDelete" }),
      confirmDelete: () => dispatch({ type: "confirmDelete" }),
    }),
    []
  );

  return { ...state, ...actions };
}
