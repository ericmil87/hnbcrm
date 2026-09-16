# Guia — conectar um número novo no HNBCRM via API não oficial (bridge)

**Última atualização:** 2026-09-16
**Vale para:** provider `bridge` (gateway wuzapi/whatsmeow, protocolo do WhatsApp Web).
Para o canal oficial (Cloud API da Meta) o caminho é outro — ver `docs/WHATSAPP-CLOUD-API-PLAN.md`.

---

## 0. Leia antes de encostar no celular

O canal bridge fala o protocolo do WhatsApp Web **sem contrato com a Meta**. Isso significa, na prática:

- Viola os Termos de Uso do WhatsApp. O número pode ser **banido em definitivo, sem aviso e sem recurso**.
- Perder a sessão e ter que reler o QR **faz parte** do funcionamento normal (ver `docs/RELATORIO-DESCONEXAO-BRIDGE-2026-08-14.md`).
- Use um número **dedicado e descartável**. Nunca o número principal do negócio.
- O gatilho nº 1 de banimento é disparo para quem não te chamou primeiro. Só responda.

Se o atendimento precisa de confiabilidade de verdade, o provider certo é `meta`.

### Checklist do aparelho novo

| Item | Por quê |
|---|---|
| Chip ativado e número recebendo SMS/ligação | O WhatsApp exige verificação no ato da instalação |
| WhatsApp (ou WhatsApp Business) instalado e o número já verificado no aparelho | O bridge entra como **dispositivo vinculado**, não substitui o app |
| Foto, nome e descrição do perfil preenchidos | Perfil vazio + volume alto = perfil de spam |
| Aparelho vai ficar **ligado, carregando e no Wi-Fi** | Dispositivo vinculado desloga se o celular primário ficar >14 dias sem se conectar (regra oficial da Meta) |
| "Aquecimento": 2–3 dias de conversas reais antes de ligar volume/IA | Número novo + rajada = ban quase certo |
| Economia de bateria/otimização **desligada** para o WhatsApp | Android mata o app em segundo plano e derruba a sessão |

---

## 1. Pré-requisitos no CRM (já estão prontos hoje)

O modo **gerenciado** está ativo — quem conecta o número não precisa saber nada de servidor. Isso depende de três variáveis no deployment Convex, todas já configuradas em `dev:tacit-chicken-195`:

```bash
npx convex env list | cut -d= -f1 | grep WA_BRIDGE
# WA_BRIDGE_ADMIN_TOKEN   → token de admin do gateway (nunca sai do servidor)
# WA_BRIDGE_DEFAULT_URL   → https://aftvps.hnbcrm.com  ("Servidor HNBCRM")
# WA_BRIDGE_HMAC_SECRET   → segredo que assina os webhooks de entrada (mín. 32 chars)
```

> **Ao publicar em produção:** essas três variáveis precisam existir também no deployment de produção, senão o botão "Provisionar nova" some (cai no modo manual) e, sem `WA_BRIDGE_HMAC_SECRET`, o provisionamento falha de propósito.

**Permissão necessária:** `settings:manage` (por padrão, só admin).

---

## 2. Provisionar o canal no CRM (≈ 1 minuto)

1. Entre no CRM e vá em **Configurações → Canais** — atalho direto: `/app/configuracoes?secao=channels`.
2. Clique em **Conectar número**.
3. Escolha o card **WhatsApp via gateway (não oficial)** — o de cima é o Cloud API oficial.
4. Leia o aviso âmbar e marque **"Entendo e assumo o risco de usar um canal WhatsApp não oficial."** Sem isso o formulário não envia.
5. Deixe o seletor em **Provisionar nova** (é o default quando o modo gerenciado está ativo) e o gateway em **Servidor HNBCRM**.
   - *"Instância existente"* só serve se você já tiver uma instância wuzapi criada à mão e for colar URL, instância e token.
   - *"Usar meu próprio gateway"* pede a URL e o admin token do seu servidor.
6. Preencha só o **Nome de exibição** — é o rótulo que aparece no Inbox e nos cards. Ex.: `Atendimento Guardião`.
7. **Conectar**.

O que acontece nos bastidores (`convex/channelConfigs.ts:619` → `provisionBridgeChannel`):

- gera um token exclusivo da instância e um id `org_<orgId>_<sufixo>`;
- cria a instância no gateway (`POST /admin/users`) já inscrita em `Message,ReadReceipt,LoggedOut,TemporaryBan,ClientOutdated`, com webhook apontando para `https://tacit-chicken-195.convex.site/webhooks/bridge`;
- **arma a assinatura HMAC no cache vivo do gateway** (`POST /session/hmac/config`) — passo obrigatório por um bug do wuzapi; sem ele o CRM envia mas não recebe;
- cifra o token e grava o `channelConfig`.

Se algo falhar aqui, o erro aparece no toast em português e **nenhum canal é criado pela metade** — exceto o caso "instância criada mas HMAC falhou", em que a própria mensagem manda remover a instância no gateway e provisionar de novo.

---

## 3. Parear o número (QR)

1. No card do canal recém-criado, clique em **Mostrar QR**.
2. No celular novo: **WhatsApp → Configurações (⋮ no Android) → Dispositivos conectados → Conectar um dispositivo**.
3. Escaneie o QR da tela.
   - O QR se renova sozinho a cada 4 s enquanto o modal estiver aberto; se expirar, é só esperar o próximo ou clicar em **Atualizar QR**.
4. Ao parear, o modal mostra **Conectado como +55…**, fecha sozinho em ~1,5 s e o card passa a exibir o badge verde **Conectado**.

Se aparecer **Número banido**, pare por aqui: esse chip não serve mais para o bridge.

### ⚠️ Um número só pode estar ativo em UMA conta

O modal avisa isso antes de você escanear. Se o número que você está pareando **já estiver conectado em outra conta do HNBCRM**, ao concluir o pareamento:

- o canal da outra conta é **desativado** (histórico e credenciais ficam — só para de enviar e receber);
- as campanhas em andamento dela são **pausadas**;
- fica um registro em **Auditoria** da conta deslocada explicando o que houve e quem levou o número;
- o aparelho antigo é **desvinculado** no WhatsApp (logout no gateway), liberando o slot.

Nesse caso o modal **não fecha sozinho**: ele mostra um banner nomeando as contas que perderam o número, para você ler antes de sair.

Isso não é higiene: com o mesmo número em duas contas, **cada mensagem do contato entra nas duas** — dado de um cliente aparecendo no inbox de outro.

> **Limitação:** a regra depende de descobrir qual número foi pareado, e isso hoje só funciona no **gateway gerenciado** (o `/session/status` do wuzapi devolve o JID vazio; o número vem da listagem admin). Em gateway próprio a exclusividade não dispara — controle manualmente.

---

## 4. Verificação pós-pareamento — **não pule esta parte**

Parear resolve o **envio**. O **recebimento** depende do HMAC e já quebrou silenciosamente antes (relatório de 14/08). Faça os quatro testes na ordem:

1. **Testar conexão** no card → deve virar/permanecer "Conectado como +55…" com o horário do teste.
2. **Receber:** de *outro* celular, mande uma mensagem para o número novo.
   → Em segundos deve surgir a conversa em **`/app/entrada`**, com contato e lead criados no pipeline padrão da org.
3. **Enviar:** responda pelo Inbox.
   → A mensagem chega no celular de teste e os tiques de entregue/lido voltam para o CRM.
4. **Áudio (opcional):** mande um voice note. Com a transcrição ligada, o texto aparece embaixo do áudio.
5. **Pelo celular:** responda a conversa **pelo app do WhatsApp do próprio número** (não pelo CRM).
   → A mensagem deve aparecer no Inbox como enviada, marcada como vinda do aparelho. É o que mantém o inbox igual à conversa real — e é o histórico que o atendente IA lê antes de responder.

### Se enviar funciona mas não chega nada no CRM

É o sintoma clássico da falha de assinatura. Confirme:

```bash
npx convex logs --history 200 | grep -i "Bridge webhook"   # Ctrl+C para sair: o comando segue escutando
# "Bridge webhook signature invalid for instance org_… — rejected"  → HMAC caiu (HTTP 401)
# "Bridge webhook for unknown/inactive instance …"                   → canal desativado/excluído no CRM
# nenhuma linha                                                      → o gateway não está nem tentando: ver §7
```

**Correção hoje:** o único caminho do produto que rearma o HMAC é o **provisionamento**. Exclua o canal no CRM e provisione um novo (o pareamento por QR terá que ser refeito). Com acesso ao servidor do gateway, dá para consertar sem re-parear:

```bash
# no servidor do gateway — precisa do token DA INSTÂNCIA e do WA_BRIDGE_HMAC_SECRET
curl -X POST https://aftvps.hnbcrm.com/session/hmac/config \
  -H "token: <TOKEN_DA_INSTANCIA>" -H "Content-Type: application/json" \
  -d '{"hmac_key":"<WA_BRIDGE_HMAC_SECRET>"}'
```

---

## 5. Arrumar a casa depois de conectar

### 5.1 Canal antigo

Se este número **substitui** outro (ex.: `GuardTeste2`), **desative ou exclua o antigo**. Motivo concreto: conversas antigas sem `channelConfigId` caem num fallback que escolhe o primeiro canal WhatsApp *ativo* da org (`convex/lib/channelResolve.ts`) — dois bridges ativos ao mesmo tempo fazem resposta sair pelo número errado.

- **Desativar** (botão ⏻ no card): para de receber e de enviar, mas mantém histórico e credenciais. **Não** desvincula o aparelho no gateway.
- **Excluir** (🗑): remove o canal do CRM **e encerra a sessão no gateway** (logout → o aparelho sai dos "Dispositivos conectados" do WhatsApp). Antes isso não acontecia, e cada canal excluído deixava uma instância órfã logada para sempre, gastando slot de aparelho e entregando webhook que o CRM descartava.

### 5.2 Transcrição de áudio

Toggle **"Transcrever áudios automaticamente"** dentro do próprio card. Usa o Whisper self-hosted (`WHISPER_SERVICE_URL`), é por canal e vale também para o atendente IA "ouvir" voice notes.

### 5.3 Histórico do aparelho (opcional, desligado por padrão)

No card do número, expanda **Histórico do aparelho**. Com ele ligado, o gateway passa a guardar uma cópia das mensagens desse número e o CRM importa o que estiver faltando — útil quando o CRM ficou fora do ar ou um webhook se perdeu.

- **Msgs por conversa** (10–500, padrão 100) e **Janela em dias** (1–30, padrão 7). Nada mais velho que a janela entra, mesmo que o gateway tenha.
- **Sincronizar agora** pede o histórico ao WhatsApp e importa alguns segundos depois. Rodar duas vezes não duplica nada.
- **Só recupera mensagem enviada por você** (pelo CRM ou pelo celular). Mensagem recebida não é reimportada de propósito: ela sempre chegou pelo webhook, e reinjetar uma pergunta de dias atrás faria o atendente IA responder a ela como se fosse nova.
- Enquanto o interruptor estiver desligado, o CRM não chama nenhum endpoint de histórico do gateway.

Expectativa realista: o pedido de histórico ao WhatsApp é **best-effort**. Num teste real pedimos 100 mensagens e vieram 50, todas antigas — as de horas atrás não vieram. O valor está na captura contínua daqui pra frente, não no resgate retroativo.

### 5.4 Painel de saúde

Abaixo da lista de canais aparece o **ChannelHealthPanel** com estatísticas de entrega dos últimos 7 dias. É o lugar de olhar quando "parece que está lento".

---

## 6. Liberar o atendente IA neste número (opcional)

A IA **não** atende canal bridge por padrão, mesmo com o atendente ligado. É preciso um aceite de risco separado, por organização:

1. **Configurações → IA**.
2. Card **"Canais não oficiais (bridge)"** → ligue a chave e confirme em **Liberar no bridge**.

Depois disso valem as regras normais do atendente:

- **Modo sugestão** (default): a IA escreve o rascunho, o humano revisa no Inbox e envia. Comece por aqui.
- **Modo autopilot**: só destrava depois de métricas de aceitação suficientes.
- O envio pelo bridge usa pacing humanizado (4–10 s reativo, 8–15 s a frio, com "digitando…") — é proteção contra ban, não lentidão à toa.
- Desligar a chave interrompe **na hora**, inclusive respostas já em geração.

---

## 7. Rotina de operação e o que fazer quando cair

Hoje **não existe monitoramento automático de saúde do canal** — nenhum cron, nenhum alerta. O card só atualiza quando alguém clica em "Testar conexão" ou abre o QR. Enquanto isso não muda, a rotina é manual:

| Frequência | Ação |
|---|---|
| Toda segunda | **Testar conexão** em cada canal bridge + mandar uma mensagem de fora e conferir que entrou no Inbox |
| Diária | Olhar se o celular está ligado, online e sem "otimização de bateria" ativa |
| Nunca | Reiniciar/atualizar o container do gateway no meio de uma janela de atendimento |

**Quando cair (envio falhando com `no session`, ou silêncio total):**

1. Configurações → Canais → **Mostrar QR** → re-parear pelo celular.
2. **Refaça o teste de recebimento da §4.** Re-parear conserta o envio e **não** rearma o HMAC — é exatamente aí que o canal volta pela metade.
3. Se o recebimento não voltar, aplique a correção da §4.

### Diagnóstico direto no gateway

```bash
# lista as instâncias, com connected/loggedIn e o events inscrito
curl -s -H "Authorization: $WA_BRIDGE_ADMIN_TOKEN" https://aftvps.hnbcrm.com/admin/users | jq

# status de uma instância específica
curl -s -H "token: <TOKEN_DA_INSTANCIA>" https://aftvps.hnbcrm.com/session/status | jq
```

Sinal de alerta: `events` ser só `"Message"` — perde tique de entregue/lido e o aviso de logout/ban.

**A causa era nossa, e está corrigida.** O `POST /session/connect` do wuzapi grava o que vier em `Subscribe` na coluna `events` da instância, e o CRM mandava `["Message"]` por padrão: **todo reconnect apagava** a assinatura feita no provisionamento. Foi por isso que os recibos de entrega/leitura ficaram mortos entre 2026-08-07 e 2026-09-16 (todos os envios travados em "enviado"). Hoje o connect manda a lista inteira (`BRIDGE_WEBHOOK_EVENTS`), que também **conserta** uma instância degradada no próximo reconnect.

Se ainda encontrar uma instância degradada, não precisa reprovisionar nem re-parear — dá para corrigir ao vivo (atualiza o banco **e** o cache do gateway):

```bash
curl -X PUT -H "Authorization: $WA_BRIDGE_ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"events":"Message,ReadReceipt,LoggedOut,TemporaryBan,ClientOutdated"}' \
  https://aftvps.hnbcrm.com/admin/users/<ID_DA_INSTANCIA>
```

> `POST /session/connect` **não** serve para isso: em instância já conectada ele responde `409 already connected` antes de tocar nos eventos.

### Instância órfã no gateway

Instância logada que não corresponde a nenhum canal do CRM entrega webhook que o ingress descarta (`Bridge webhook for unknown/inactive instance …`), gasta um slot de aparelho vinculado e dobra o risco de ban. Excluir o canal pelo CRM já resolve isso hoje; para limpar uma órfã antiga:

```bash
# /full faz LOGOUT antes de apagar — desvincula o aparelho de verdade.
# O DELETE sem /full só apaga a linha e deixa o aparelho vinculado (zumbi).
curl -X DELETE -H "Authorization: $WA_BRIDGE_ADMIN_TOKEN" \
  https://aftvps.hnbcrm.com/admin/users/<ID_DA_INSTANCIA>/full
```

---

## 8. Tabela rápida de erros

| Sintoma | Causa provável | O que fazer |
|---|---|---|
| "Admin token inválido" ao provisionar | `WA_BRIDGE_ADMIN_TOKEN` errado/rotacionado, ou gateway fora do ar | Conferir env e `curl` no `/admin/users` |
| "WA_BRIDGE_HMAC_SECRET não configurado" | Env ausente ou com menos de 32 chars | Setar no Convex e provisionar de novo |
| QR não aparece / "Não foi possível obter o QR" | Instância sem socket, gateway fora do ar | Fechar e reabrir o modal; se insistir, checar `/session/status` |
| QR some e volta sem parear | QR expirando antes da leitura | Deixar o modal aberto e escanear o QR novo (renova a cada 4 s) |
| "Número banido" | Ban do lado da Meta | Chip queimado — trocar de número |
| Envia mas não recebe | HMAC não armado (401 nos webhooks) | §4, correção do HMAC |
| `no session` no envio | Sessão caiu no gateway (restart, logout, device removed) | Re-parear por QR + refazer §4 |
| Resposta saiu pelo número errado | Dois canais WhatsApp ativos na org | Desativar o canal antigo (§5.1) |
| Canal desativou sozinho, com aviso na Auditoria | O número foi pareado em outra conta do HNBCRM | Esperado (§3). Para trazer de volta, pareie de novo aqui — a outra conta é que perde |
| Envio/recebimento ok, mas sem tique de entregue/lido | Assinatura de eventos degradada na instância | §7 — corrigir com `PUT /admin/users/{id}` |
| Mensagem digitada no celular não aparece no CRM | Versão antiga (antes de 2026-09-16) ou canal Meta | Atualizar; no Meta isso não existe — a Cloud API não usa aparelho |
| "Sincronizar agora" traz 0 mensagens | Nada dentro da janela de dias, ou histórico recém-ligado | Esperado (§5.3) — o store só passa a guardar a partir de quando foi ligado |
| IA não responde no canal | Falta o aceite de bridge em Configurações → IA | §6 |

---

## 9. Onde isso vive no código

| Arquivo | Papel |
|---|---|
| `src/components/settings/ChannelsSection.tsx` | UI: formulário, aceite de risco, modal do QR, card do canal |
| `convex/channelConfigs.ts` | `provisionBridgeChannel`, `getBridgeQrCode`, `checkChannelHealth` |
| `convex/lib/bridgeSession.ts` | Requests/parsers de `/admin/users`, `/session/*`, `/session/hmac/config` |
| `convex/bridge.ts` | Ingress `POST /webhooks/bridge` (verificação HMAC, roteamento por instância) |
| `convex/lib/bridgeSend.ts` / `bridgeMedia.ts` | Envio de texto e mídia |
| `convex/lib/bridgeHistory.ts` | Histórico do aparelho: `/session/history` e `/chat/history` |
| `convex/lib/whatsappDispatch.ts` | Pacing por conversa e por número |
| `docs/RELATORIO-DESCONEXAO-BRIDGE-2026-08-14.md` | Post-mortem da queda + análise do bug de HMAC |
