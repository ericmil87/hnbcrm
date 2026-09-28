import { v, ConvexError } from "convex/values";
import {
  convexAuth,
  getAuthUserId,
  type GenericActionCtxWithAuthConfig,
} from "@convex-dev/auth/server";
import { Password } from "@convex-dev/auth/providers/Password";
import { Anonymous } from "@convex-dev/auth/providers/Anonymous";
import { query } from "./_generated/server";
import { passwordResetProvider } from "./passwordReset";
import { internal } from "./_generated/api";
import { DataModel } from "./_generated/dataModel";

type CredentialsAuthorize = (
  params: Record<string, unknown>,
  ctx: GenericActionCtxWithAuthConfig<DataModel>,
) => Promise<unknown>;

/**
 * E-mail do provider Password independente da caixa digitada. O Convex Auth
 * usa `params.email` cru como `providerAccountId` (e o `profile` é síncrono,
 * sem banco), então "Eric@x.com" e "eric@x.com" viravam contas diferentes.
 * Aqui o e-mail é trocado pelo canônico ANTES do `authorize` do pacote: a
 * conta que JÁ existe em qualquer caixa (inclusive legado "Eric@X.com",
 * preferindo a forma digitada exata), senão a forma minúscula
 * (`authHelpers.resolvePasswordAccountEmail`) — ninguém perde o login, e o
 * cadastro com variante de conta existente é recusado.
 *
 * O `authorize` real mora em `options` (é o que o convexAuth mescla no
 * provider materializado — provider_utils.ts `providerDefaults`, v0.0.80).
 * Se uma versão nova mudar isso, o módulo QUEBRA no carregamento (deploy
 * falha alto) em vez de desligar a normalização em silêncio.
 */
export function withCanonicalEmail<P>(provider: P): P {
  const options = (provider as unknown as { options?: { authorize?: CredentialsAuthorize } }).options;
  const inner = options?.authorize;
  if (!options || !inner) {
    throw new Error("@convex-dev/auth: Password sem options.authorize — revisar withCanonicalEmail em convex/auth.ts");
  }
  options.authorize = async (params, ctx) => {
    if (typeof params.email !== "string") return inner(params, ctx);
    const { email, exists } = await ctx.runQuery(internal.authHelpers.resolvePasswordAccountEmail, {
      email: params.email,
    });
    // Cadastro público com uma variante de caixa de conta existente criaria
    // uma SEGUNDA conta — e a partir dali o login/reset poderiam cair nela.
    if (params.flow === "signUp" && exists) {
      throw new ConvexError("Já existe uma conta com este e-mail. Entre ou use \"Esqueci a senha\".");
    }
    return inner({ ...params, email }, ctx);
  };
  return provider;
}

// Sem `afterUserCreatedOrUpdated`: ele vinculava ao novo usuário todo membro
// pendente com o mesmo e-mail — e o cadastro não prova posse do e-mail, então
// quem se cadastrasse primeiro com o endereço de um convite entrava na org
// (como admin, se fosse o caso). Hoje todo vínculo nasce com `userId` pelo
// convite (`nodeActions.inviteHumanMember`); pendente legado é adotado quando
// o admin convida de novo.
export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  providers: [withCanonicalEmail(Password({ reset: passwordResetProvider })), Anonymous],
});

export const loggedInUser = query({
  args: {},
  returns: v.any(),
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      return null;
    }
    const user = await ctx.db.get("users", userId);
    if (!user) {
      return null;
    }
    return user;
  },
});
