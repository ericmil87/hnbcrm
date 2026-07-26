# Limites WhatsApp/Meta e Anti-Ban para CRM Multi-Tenant

Pesquisa para calibrar constantes de pacing/fila de envio nos dois transportes do ClawCRM: (a) WhatsApp Cloud API oficial da Meta e (b) gateway não-oficial via protocolo WhatsApp Web (whatsmeow/wuzapi).

## Resumo Executivo

A Cloud API tem regras **documentadas e numéricas** que dá para codificar com precisão: pair rate limit de 1 msg/6s por destinatário (erro 131056), throughput de 80 mps por número (erro 130429), tiers de mensageamento (250→2K→10K→100K→ilimitado) e backoff de retry `4^X` segundos — tudo confirmado na documentação oficial [1][2][3]. Não existe, na doc atual, um número análogo para o protocolo não-oficial: as faixas de delay usadas pela comunidade variam de 1-5s a 15-45s dependendo da fonte, e o fator que mais aparece como decisivo não é o delay em si, mas se o número já tem "relação" com o destinatário (contato salvo, conversa iniciada pelo cliente) — um usuário relatou ban mesmo com 30s de delay ao mandar para contatos frios [10]. Recomendo tratar os números do protocolo não-oficial como estimativas de engenharia calibráveis por métrica de bloqueio real, não como limites garantidos por ninguém.

## Descobertas

### 1. Cloud API oficial — limites publicados

**Tiers de conversas iniciadas pelo negócio (messaging limit)** [1][5]
- Portfólio novo: **250** destinatários únicos por período móvel de 24h, fora da janela de atendimento de 24h (customer service window).
- Sobe para **2.000** completando um "scaling path": verificar o negócio, ter parceiro verificando, OU enviar 2.000 mensagens entregues (fora da janela de atendimento) para números únicos num período móvel de **30 dias**, usando templates de alta qualidade.
- Depois de 2.000, escala automaticamente (sem ação manual) para **10.000 → 100.000 → Ilimitado**, condicionado a: (a) mensagens de alta qualidade em todos os números/templates e (b) uso de **mais de 50% do limite atual nos últimos 7 dias**. Quando os critérios batem, o limite sobe um nível em até **6 horas**.
- O limite é por **portfólio de negócio**, compartilhado entre todos os números WABA daquele portfólio — um número sozinho pode consumir a cota inteira.
- Consultar via API: campo `whatsapp_business_manager_messaging_limit` (o antigo `messaging_limit_tier` foi descontinuado).
- Importante: esse limite só vale para mensagens **fora** da janela de atendimento de 24h. Dentro dela (cliente respondeu ou iniciou), não conta.

**Throughput (mensagens por segundo, por número)** [2]
- Default: **80 mps**, contando inbound + outbound, todos os tipos de mensagem.
- Upgrade automático e gratuito para **1.000 mps** se: portfólio tem messaging limit "Unlimited" + número mensageou 100K+ destinatários únicos fora da janela de atendimento em 24h móveis + `quality_score` é YELLOW ou melhor.
- Números do WhatsApp Business app usados também via Cloud API ficam fixos em **20 mps**.
- Exceder o throughput → **erro 130429** até voltar dentro do limite.
- Durante o processo de upgrade (até 1 minuto), o número fica indisponível: erro **131057**.

**Pair rate limit (mesmo destinatário)** [3] — este é o número mais relevante para pacing por conversa:
- **1 mensagem a cada 6 segundos** para o mesmo usuário do WhatsApp (0,17 msg/s ≈ 10/min ≈ 600/hora).
- Exceder → **erro 131056** até normalizar.
- Permite burst de até **45 mensagens em 6 segundos**, mas isso "toma emprestado" da cota futura — ex.: um burst de 20 exige ~2 minutos de espera antes de mandar mais para aquele mesmo usuário.
- Retry recomendado pela própria doc: backoff exponencial de **4^X segundos** (X começa em 0 e sobe 1 a cada falha) até suceder.

**Limites de chamadas de API (rate limit de app/WABA)** [3]
- Endpoints de gestão (WABA info, `phone_numbers`, `message_templates`, `subscribed_apps`, `assigned_users`, status): **200 requisições/hora** por app/WABA por padrão; **5.000/hora** se a WABA estiver ativa com ao menos um número registrado.
- Credit Line API: 5.000 req/hora.
- A doc também nomeia "Test message rate limit" (WABAs não verificadas), "Capacity rate limit" (todas as contas) e "Business phone rate limit" (por número) como categorias existentes, mas não publica valores numéricos para elas na versão atual — é uma lacuna documental, não um dado que eu tenha encontrado em outro lugar confiável.

**O que acontece ao exceder cada limite:**
| Limite excedido | Código de erro | Efeito |
|---|---|---|
| Throughput (mps) | 130429 | Rejeitado até voltar à taxa permitida |
| Pair rate limit (mesmo destinatário) | 131056 | Rejeitado até normalizar; retry com backoff 4^X |
| Upgrade de throughput em andamento | 131057 | Número indisponível por até 1 min |
| Messaging limit (tier) estourado | — | Mensagens de template fora da janela simplesmente não são aceitas até resetar/subir tier |

Não há evidência oficial de que exceder rate limits técnicos, por si só, sinalize a conta para banimento — são erros de throttling. O que afeta o **quality rating** (e por consequência pode levar a enforcement) é um mecanismo separado, coberto abaixo.

### 2. Quality rating e enforcement oficial

**Quality rating do número de telefone** [4][5]
- Calculado com base no feedback dos últimos **7 dias**, ponderado por recência: bloqueios, denúncias, silenciamentos, arquivamentos, e o motivo selecionado pelo usuário ao bloquear (`No longer needed`, `Didn't sign up`, `Spam`, `Offensive messages`, `No reason`).
- Três estados: **Verde** (alta), **Amarelo** (média), **Vermelho** (baixa).
- **Mudança recente importante**: os status "Flagged" e "Restricted" de número de telefone foram **descontinuados em 7 de outubro de 2025** [5] — hoje só existem os três estados de quality acima no nível de número. Se algum código/doc antiga do projeto ainda menciona "flagged"/"restricted" como estado de número, está desatualizado.
- Números de alto tráfego podem mudar de rating em questão de minutos [6].

**Quality rating do template** (separado, por template) [7]
- `GREEN` / `YELLOW` / `RED` / `UNKNOWN` (novo template começa `UNKNOWN`).
- Alimenta dois mecanismos automáticos:
  - **Template pausing** [8]: se cai para RED, é pausado automaticamente — 1ª vez: 3h; 2ª vez: 6h; 3ª vez: desabilitado (precisa editar e ressubmeter para aprovação). Durante a pausa a API rejeita envios (não conta contra o limite, não cobra). Desde 12/out/2023, precisa ser despausado manualmente via `/unpause` ou WhatsApp Manager.
  - **Template pacing** [9]: templates novos, recém-despausados, ou sem rating GREEN podem ter mensagens "seguradas" (`message_status: held_for_quality_assessment`) até acumular feedback suficiente. Se o sinal for bom, libera tudo; se ruim, o template é pausado e as mensagens seguradas são descartadas com erro **132015**. A Meta garante que, mesmo com pacing, 99% das campanhas de alto throughput entregam dentro de 1 hora.

**Policy enforcement no nível de conta (WABA)** [4]
- Violação de política (spam, misclassificação de template, categorias de risco como conteúdo adulto/álcool-tabaco/drogas/jogos) → aviso inicial.
- Violações repetidas escalam:
  1. Bloqueio de 1 ou 3 dias (templates de marketing/utility/authentication + impedido de adicionar números)
  2. Bloqueio de 5, 7 ou 30 dias (**todas** as mensagens + impedido de adicionar números)
  3. **Account lock**: bloqueio indefinido, só reversível via apelação
  4. **Desabilitação permanente** da plataforma se o negócio não corrigir após múltiplos avisos
- Violações graves (exploração infantil, golpes, terrorismo, venda de drogas ilegais) → offboard **imediato**, sem escalada gradual.
- Feedback negativo excessivo dos usuários, isoladamente, também pode levar a limitação ou desligamento do negócio.
- Notificação via Business Support Home, Notification Center, banner no WhatsApp Manager, e-mail a admins e webhook `account_update`. Apelação possível na maioria dos casos (não em todos os de spam), decisão em 24-48h.

**Boas práticas oficiais para manter qualidade** [6]: seguir a WhatsApp Business Messaging Policy; só mandar para quem deu opt-in explícito; mensagens altamente personalizadas e úteis; evitar mensagens de boas-vindas genéricas/abertas; evitar excesso de mensagens por dia; otimizar conteúdo e tamanho.

### 3. Protocolo não-oficial (whatsmeow/wuzapi) — heurísticas da comunidade

Esta seção é **anedótica por natureza** — não existe documentação oficial da Meta para um protocolo que ela não sancionou. Priorizei relatos primários nas discussões do próprio repositório whatsmeow [10][11], cross-checando com um guia comercial de um provedor de API não-oficial [12] — que é fonte promocional (vende a própria API) e deve ser lida com ceticismo adicional, mas cujo framework geral é consistente com o relatado na comunidade.

**Motivos de ban reportados pelo próprio app do WhatsApp** (texto exibido ao usuário banido, coletado por membros da comunidade) [10]:
- "too many people blocked you"
- "you sent too many messages to people who don't have you in their address books"
- "you created too many groups with people who don't have you in their address books"
- "you sent the same message to too many people"
- "you sent too many messages to a broadcast list"

**O delay sozinho não é suficiente — o que parece importar mais é a relação prévia com o destinatário** [10]:
- Um usuário testou 30s de delay entre mensagens, mandando para 30 números que não estavam na agenda → foi banido mesmo assim.
- O mesmo tipo de teste, mas mandando 1.000 mensagens **sem** delay para um número próprio (conversa 1:1 já estabelecida) → nenhum ban.
- Conclusão recorrente na thread: **ser "respondente" (responder quem já procurou você) é bem menos arriscado que ser "broadcaster" (iniciar contato com quem nunca falou com você)** — mesmo com delay e variação de texto, iniciar contato frio em volume ainda banca.

**Recomendações de um usuário com bot em produção sem bans reportados** (jeffersonsc, na thread #567) [11]:
- Warm-up: conectar o número primeiro no app oficial e no WhatsApp Web antes de automatizar.
- Configurar o "client name" da sessão whatsmeow como "Chrome" (navegador mais popular) — mascarar a identificação de cliente.
- Delay **aleatório entre 1 e 5 segundos** entre envios.
- Indicador de "digitando" antes/durante envio de texto; indicador de "gravando áudio" para notas de voz (OGG) — citado por dois usuários independentes na mesma thread, com um relatando faixa de 1000-5000ms.
- Deixar o cliente iniciar a conversa sempre que possível (modelo responsivo, não broadcast).
- "Certifique-se de que a saída de mensagens por minuto não seja muito alta e que as pessoas escrevam para você primeiro antes de você escrever para elas."
- Contra-exemplo relevante: um usuário conectou um número novo direto no WhatsApp Web **oficial** (sem whatsmeow) e foi banido após só ~5 mensagens — evidência de que a detecção de "possível spammer" é comportamental, não exclusiva de bibliotecas não-oficiais.
- Números recuperados de ban anterior, ao reconectar, receberam aviso de "app não-oficial detectado" — sinal de que a Meta reconhece sessões/dispositivos já sinalizados.

**Framework do guia comercial WasenderAPI** [12] (fonte promocional — sinalizo o viés, mas o conteúdo é coerente com o observado acima):
- Diferencia "ban técnico" (implementação de biblioteca mal feita, detectada como bot) de "ban comportamental" (denúncias de usuário, padrão de envio parece máquina).
- Warm-up gradual sugerido: semana 1 só uso manual; semana 2, 10-20 msgs/dia automatizadas para contatos engajados; semana 3+, aumentar volume ~20% a cada poucos dias.
- Delay sugerido: **15-45 segundos** entre mensagens (bem mais conservador que os 1-5s relatados no whatsmeow), com pausa de 10-15 min a cada 50 mensagens.
- Personalização via spintax/variáveis para não repetir texto idêntico em massa.
- Taxa de resposta recebida/enviada como sinal forte de legitimidade.
- Consistência de IP/sessão (evitar login de múltiplos países, evitar reconectar com frequência).
- Evitar links encurtados na primeira mensagem a um contato novo.
- Oferecer opt-out ("responda STOP") para reduzir a chance do botão de denúncia.

**Divergência a destacar**: as faixas de delay vão de 1-5s (whatsmeow, relato de produção) a 15-45s (guia comercial). Nenhuma das duas é um número "oficial" ou garantido — são calibrações de risco diferentes. Dado que o ClawCRM é multi-tenant (múltiplos clientes rodando o mesmo código, potencialmente somando padrões de tráfego reconhecíveis), pender para o lado mais conservador é mais prudente do que copiar o número mais otimista encontrado.

### 4. Recomendações práticas de implementação de fila

**Cloud API (transporte oficial)**
- O throughput (80 mps default) não é o gargalo real para volume de CRM pequeno/médio — o gargalo é o **pair rate limit**: nunca menos de 6 segundos entre duas mensagens para o mesmo destinatário. Sugiro implementar o limitador por par `(organizationId, destinatário)` com um piso de 6-7s (margem de segurança sobre o limite documentado) e não usar o burst de 45/6s como recurso normal — ele consome cota futura e complica o cálculo de fila.
- Para retry em 429/130429/131056: usar literalmente o backoff da doc, `4^X segundos` (X=0,1,2,...), já que é um valor publicado pela própria Meta, não uma estimativa.
- Monitorar `quality_score` via webhook `phone_number_quality_update` e reduzir automaticamente o volume de campanhas (ou pausar) se o número cair para YELLOW/RED.
- Para broadcast de templates em massa, consultar `whatsapp_business_manager_messaging_limit` antes de disparar e não estourar a cota do tier atual; espalhar campanhas grandes ao longo de horas/dias em vez de gastar a cota de uma vez — isso também ajuda organicamente a bater o critério de "mais de 50% de uso em 7 dias" para subir de tier.
- Tratar no webhook de status o `message_status: held_for_quality_assessment` e o erro `132015` (mensagem descartada por template pacing) — isso é comportamento automático da Meta, o código só precisa reconhecer e não tratar como falha de envio "normal".
- Para o cenário citado (200 mensagens agendadas para as 9h): tecnicamente, se forem 200 destinatários diferentes, cabem dentro do throughput de 80 mps quase instantaneamente sem violar o pair rate limit (que é por destinatário, não agregado). Ainda assim, um pico abrupto de volume é o tipo de padrão que a doc oficial pede para evitar ("avoid sending too many messages per day") como fator de quality — não há limite técnico formal aqui, mas sugiro (decisão de engenharia minha, não exigência documentada) aplicar um jitter de 1-3s entre envios sequenciais dentro do lote, só para não gerar um pico visualmente idêntico a um blast de spam.

**Gateway não-oficial (bridge/wuzapi/whatsmeow)**
Como o risco de ban aqui é permanente e sem processo formal de apelação, e o produto é multi-tenant (múltiplas orgs no mesmo código, o que pode criar uma "assinatura" de tráfego reconhecível se todos usarem exatamente os mesmos parâmetros), recomendo ficar entre os dois extremos observados na pesquisa, mais perto do lado conservador:
- **Intervalo mínimo entre envios: 3-10 segundos com jitter aleatório** — faixa intermediária entre os 1-5s otimistas do whatsmeow (relato único de produção) e os 15-45s do guia comercial. Isto é uma escolha de engenharia, não um número documentado ou garantido por nenhuma fonte.
- **Simular "digitando..."** antes de cada envio de texto, com duração proporcional ao tamanho da mensagem — prática confirmada por múltiplos relatos independentes na comunidade.
- **Simular "gravando áudio"** antes de enviar notas de voz.
- **Aplicar a mesma lógica de pair rate limit por destinatário** mesmo não sendo documentada oficialmente para o protocolo não-oficial (por analogia de segurança, não por exigência confirmada).
- **Cap diário por número**: nenhuma fonte confiável publica um número "seguro" garantido. Recomendo começar conservador (algumas centenas/dia para número já aquecido, dezenas/dia para número novo) e ajustar com base em métricas reais de bloqueio/denúncia observadas no próprio produto — não tratar nenhum valor fixo como garantia.
- **Warm-up obrigatório para números novos**: dias de uso manual + rampa de volume automatizado crescente antes de liberar tráfego pleno. Não existe tabela oficial "dia X = Y mensagens" — é prática de mercado sem consenso numérico rígido; uma rampa razoável seria começar com dezenas/dia e dobrar a cada poucos dias, mas isso é uma proposta minha, não um dado coletado.
- **Priorizar sempre responder conversas iniciadas pelo cliente sobre iniciar contato novo** — este é o sinal mais forte e mais consistente em todas as fontes da comunidade, mais importante que qualquer ajuste fino de delay.
- **Tratamento de erro/desconexão**: se a sessão reportar desconexão com mensagem de "versão não-oficial do WhatsApp detectada" (padrão relatado na comunidade), tratar como sinal de alto risco — pausar a fila daquele número e alertar o operador, em vez de reconectar/retry automático.

## Recomendações

1. **Codificar os números da Cloud API como constantes exatas** (pair rate limit 6s/destinatário, backoff 4^X, throughput 80 mps) — são valores publicados pela Meta e não deveriam ser "chutados"; risco baixo de errar.
2. **Não copiar cegamente nenhuma faixa de delay do protocolo não-oficial como se fosse garantida** — nem os 1-5s do whatsmeow nem os 15-45s do guia comercial são "seguros" comprovados; comece em algo como 3-10s + jitter e monitore taxa de bloqueio real por org como sinal de ajuste, documentando no código que é uma estimativa calibrável, não um limite oficial.
3. **Priorizar no produto o sinal mais forte encontrado**: para o bridge não-oficial, dar prioridade de fila (ou até liberar sem tanta cautela) para conversas onde o cliente mandou mensagem primeiro, e aplicar as travas mais rígidas de warm-up/rampa apenas para mensagens iniciadas pela organização (broadcast/campanha) — o risco está concentrado ali, não no atendimento reativo.
4. **Monitorar `quality_score` da Cloud API via webhook e cortar automaticamente campanhas quando cair para YELLOW/RED** — já existe um sinal oficial de alerta antecipado antes de qualquer enforcement mais grave; vale a pena não depender só de erro 429 para reagir.
5. **Se o time decidir por um cap diário no bridge, documentar explicitamente no código que o valor é uma escolha de produto sem lastro documental**, para evitar que alguém no futuro trate esse número como um "limite oficial da Meta" que não existe.

## Fontes

[1] https://developers.facebook.com/documentation/business-messaging/whatsapp/messaging-limits — Documentação oficial Meta, tiers de messaging limit (250/2K/10K/100K/ilimitado) e critérios de auto-scaling. Atualizada em 21/mai/2026.
[2] https://developers.facebook.com/documentation/business-messaging/whatsapp/throughput — Documentação oficial Meta, throughput por número (80 mps default, 1.000 mps upgrade) e critérios de elegibilidade. Atualizada em 17/jun/2026.
[3] https://developers.facebook.com/documentation/business-messaging/whatsapp/about-the-platform — Documentação oficial Meta, seção "Rate limits" e "Pair rate limits" (1 msg/6s, erro 131056, burst de 45/6s, backoff 4^X) e rate limit de chamadas de API (200/5000 req/hora).
[4] https://developers.facebook.com/documentation/business-messaging/whatsapp/policy-enforcement — Documentação oficial Meta sobre enforcement de política, escalada de bloqueios e banimento. Atualizada em 21/mai/2026.
[5] https://www.facebook.com/business/help/896873687365001 — Meta Business Help Center, "About your WhatsApp Business phone number's quality rating". Confirma estados verde/amarelo/vermelho e a descontinuação dos status "Flagged"/"Restricted" em 7/out/2025.
[6] https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/send-messages — Documentação oficial Meta, seção "Message quality" (sinais de feedback, boas práticas).
[7] https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/template-quality — Documentação oficial Meta, quality rating de templates (GREEN/YELLOW/RED/UNKNOWN).
[8] https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/template-pausing — Documentação oficial Meta, mecanismo de pausa automática de template (3h/6h/desabilitado).
[9] https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/template-pacing — Documentação oficial Meta, mecanismo de pacing/retenção de mensagens de template novo.
[10] https://github.com/tulir/whatsmeow/discussions/199 — Discussão da comunidade no repositório oficial do whatsmeow (biblioteca usada pelo wuzapi). Relatos anedóticos primários de usuários sobre motivos de ban e testes de delay vs. contato frio.
[11] https://github.com/tulir/whatsmeow/discussions/567 — Discussão da comunidade no whatsmeow sobre mudanças nas regras de ban; contém as recomendações mais concretas e testadas em produção (delay 1-5s, typing indicator, warm-up).
[12] https://wasenderapi.com/blog/stop-getting-banned-the-ultimate-whatsapp-anti-ban-strategy-for-unofficial-apis-in-2025 — Guia de um provedor comercial de API não-oficial. **Fonte promocional/comercial** (vende a própria API) — usado só como triangulação de framework, não como autoridade.

---

## Addendum 2026-07-26 — pesquisa complementar da rodada v4.1

### A. Rate limits não publicados da Meta (3 scouts, fontes oficiais)
As categorias **"Test message rate limit"**, **"Capacity rate limit"** e
**"Business phone rate limit"** são nomeadas pela doc oficial mas **não têm
valor numérico publicado em NENHUMA fonte confiável** (Meta, BSPs 360dialog,
comunidade) — não inventar caps. Códigos de throttling oficiais completos:
`4, 80007, 130429, 131048, 131056, 133016, 131064` (página error-codes).
- `80007` — "WABA has reached its rate limit", genérico, sem desambiguar a
  categoria → tratar como throttling (backoff 4^X), igual 130429.
- `131048` — restrição POR NÚMERO por "mensagens bloqueadas/denunciadas como
  spam". Candidato plausível (confiança MÉDIA, não confirmado) ao "business
  phone rate limit". **Não é throttling benigno — é sinal de risco de
  qualidade**: o ClawCRM congela a fila do canal 30min + alerta, sem retry.
- `80008` — rate limit da Management API (200/5000 req/h) — NÃO confundir com envio.

### B. Typing/warm-up de produção no protocolo não-oficial (baileys-antiban v4.10, mesmo protocolo do whatsmeow)
- **Typing model WPM**: 45±15 WPM (~267ms/char) com ciclos composing/paused e
  pausas de pensamento 0,8–3,5s (8% a cada 10 chars); fallback linear ~30ms/char.
  Mensagem de 200 chars = 30–60s "humano real". O ClawCRM usa 55ms/char + teto
  8s como compromisso deliberado UX×realismo (constante em
  `convex/lib/whatsappDispatch.ts`).
- **Warm-up com rampa concreta de produção**: dia 1=20, 2=36, 3=65, 4=117,
  5=210, 6=378, 7=680, 8+=sem limite (fator ~1,8×/dia; >72h inativo reinicia).
  Mais conservador e mais recente que qualquer blog. **Documentado como
  referência — NÃO implementado** (decisão v4/v4.1); `channelPacing.dailyCount`
  registra a métrica para calibrar se um dia virar produto.
- **Detecção 2025-26**: onda de "conta em risco" mai/2025 atingiu whatsmeow E
  Baileys simultaneamente (whatsmeow#807/#810, Baileys#1392; persiste em
  Baileys#2658, jun/2026) — comportamental + fingerprinting de SESSÃO (contas
  ociosas conectadas também receberam). Heurística nova relatada em 2026
  (confiança média, blog agregador): contador de mensagens NÃO respondidas em
  janela de 30 dias — penaliza broadcast, não atendimento reativo.
- **Hardening de gateway (fora do CRM, backlog)**: atrasar presença
  "available" 45–120s pós-conexão; pool de client names (o "Chrome" fixo
  idêntico em milhares de bots é ele próprio um fingerprint).
- **wuzapi**: confirmado SEM pacing embutido (wrapper fino do whatsmeow) — todo
  anti-ban é responsabilidade da nossa camada. `POST /chat/presence`
  `{Phone, State: "composing"|"paused", Media: ""|"audio"}`.

### C. Concorrentes
- **Letalk** (única com pacing documentado publicamente): temporizador de
  envios com intervalo aleatório **8–15s (média 12s)**, fila sequencial única
  por número, não configurável — base da faixa "fria" do bridge no ClawCRM
  (envio sem inbound do cliente nas últimas 24h).
- Kommo/Umbler/Blip/Huggy/Zenvia (API oficial): nenhum pacing próprio
  publicado — delegam throttling à Meta; conteúdo é compliance (opt-in,
  templates, quality rating). Chatwoot não tem WhatsApp não-oficial nativo
  (comunidade usa Evolution API/Baileys) e não tem pacing anti-ban no código.
- Ecossistema Evolution API (guias de terceiros, viés comercial): delay
  10–45s, caps 20–50/dia (número novo) a 80–200/dia (aquecido). Anedota de
  calibração de risco: **~30% de chance de ban em 6 meses mesmo com número
  aquecido** — o aceite de risco do P1 não é teatro.
