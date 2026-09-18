// Única fonte da validade do código de redefinição de senha — usada tanto
// pelo provider do Convex Auth (convex/passwordReset.ts, TTL real do código
// no servidor) quanto pelo e-mail (convex/authEmails.ts, texto "expira em X
// minutos"). Duplicar o número nos dois arquivos os deixaria dessincronizar
// silenciosamente (o e-mail diria 15 min enquanto o código já teria caído).
export const RESET_CODE_TTL_MINUTES = 15;
