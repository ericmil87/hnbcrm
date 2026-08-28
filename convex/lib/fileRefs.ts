/**
 * Contagem de referências do blob antes de apagá-lo.
 *
 * Uma linha de `files` NÃO é dona exclusiva do `storageId`: `conversations.
 * forwardMessage` duplica a linha ao encaminhar um anexo (cada mensagem precisa
 * do seu próprio `files.messageId`) apontando para o MESMO blob. Sem esta
 * checagem, apagar um dos lados — pela cascata de exclusão de lead ou pelo
 * botão de excluir arquivo — levava o blob junto e deixava a outra mensagem com
 * um anexo quebrado, sem aviso nenhum.
 *
 * Correção escolhida: manter a duplicação de linhas (opção b do achado) e
 * condicionar SÓ o `ctx.storage.delete`. A alternativa — compartilhar uma única
 * linha de `files` entre as mensagens — quebraria o vínculo 1:1 de
 * `files.messageId` e obrigaria a mexer em toda a leitura de anexos.
 *
 * Direção segura: na dúvida, o blob FICA. Um blob órfão é desperdício de
 * espaço; um blob apagado cedo demais é anexo perdido.
 */
import { MutationCtx } from "../_generated/server";
import { Doc } from "../_generated/dataModel";

/**
 * `true` se alguma OUTRA linha de `files` aponta para o mesmo blob.
 *
 * A varredura usa o índice `by_storage_id`. O compartilhamento legítimo é
 * sempre dentro da mesma org (o encaminhamento recusa conversa de outra org),
 * mas uma linha de org diferente também bloqueia: apagar o blob alheio seria
 * pior do que deixá-lo ocupando espaço.
 */
export async function isStorageShared(
  ctx: MutationCtx,
  file: Pick<Doc<"files">, "_id" | "storageId">
): Promise<boolean> {
  const rows = await ctx.db
    .query("files")
    .withIndex("by_storage_id", (q) => q.eq("storageId", file.storageId))
    .take(2);
  return rows.some((row) => row._id !== file._id);
}

/**
 * Apaga o blob de um arquivo SE nenhuma outra linha de `files` o referenciar.
 * Não toca no doc de `files` — quem chama decide o que fazer com a linha.
 * Devolve `true` quando o blob foi de fato removido.
 */
export async function deleteBlobIfUnreferenced(
  ctx: MutationCtx,
  file: Pick<Doc<"files">, "_id" | "storageId">
): Promise<boolean> {
  if (await isStorageShared(ctx, file)) return false;
  try {
    await ctx.storage.delete(file.storageId as never);
  } catch {
    // blob já removido — segue
    return false;
  }
  return true;
}
