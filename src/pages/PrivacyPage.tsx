import { Link } from "react-router";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { SEO } from "@/components/SEO";
import { Footer } from "@/components/landing/Footer";
import { LegalIdentification } from "@/components/landing/LegalIdentification";
import { LEGAL_ENTITY } from "@/lib/legalEntity";
import { BrandLogo } from "@/components/ui/BrandLogo";
import { PublicThemeButton } from "@/components/landing/PublicThemeButton";

const EFFECTIVE_DATE = "10 de novembro de 2026";

function LegalSection({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section id={id} className="space-y-3 scroll-mt-24">
      <h2 className="text-xl md:text-2xl font-bold text-text-primary">{title}</h2>
      <div className="space-y-3 text-text-secondary leading-relaxed">{children}</div>
    </section>
  );
}

export function PrivacyPage() {
  return (
    <>
      <SEO
        title="Política de Privacidade"
        description="Política de Privacidade do HNBCRM — quais dados tratamos, como atuamos como operador em nome da sua organização, o canal WhatsApp, Instagram e Facebook Messenger, os grupos de WhatsApp e seus direitos sob a LGPD."
      />
      <div className="min-h-screen bg-surface-base text-text-primary">
        {/* Header */}
        <header className="sticky top-0 z-30 bg-surface-base/85 backdrop-blur-md border-b border-border">
          <div className="max-w-3xl mx-auto px-4 py-3 flex items-center justify-between gap-4">
            <Link to="/" className="flex items-center gap-2">
              <BrandLogo variant="wordmark" size="md" />
            </Link>
            <div className="flex items-center gap-1">
              <PublicThemeButton />
              <Link to="/">
                <Button variant="ghost" size="sm">
                  <ArrowLeft size={16} />
                  Voltar
                </Button>
              </Link>
            </div>
          </div>
        </header>

        <main className="max-w-3xl mx-auto px-4 py-10 md:py-16">
          {/* Title */}
          <div className="mb-10 space-y-2">
            <h1 className="text-3xl md:text-4xl font-bold text-text-primary">Política de Privacidade</h1>
            <p className="text-sm text-text-muted">Vigência: {EFFECTIVE_DATE}</p>
          </div>

          <div className="space-y-10">
            <p className="text-text-secondary leading-relaxed">
              Esta Política de Privacidade descreve como o HNBCRM trata dados pessoais em conformidade com a
              Lei Geral de Proteção de Dados (Lei nº 13.709/2018 — "LGPD"). Ela explica quais dados são
              coletados, com quais finalidades, o papel do HNBCRM no tratamento e os direitos dos titulares.
            </p>

            <LegalSection id="papeis" title="1. Papéis no tratamento de dados">
              <p>
                O HNBCRM atua de duas formas distintas. Em relação aos dados de cadastro e de conta dos
                usuários da plataforma, atuamos como{" "}
                <span className="text-text-primary font-medium">controlador</span>. Em relação aos dados de
                contatos, leads e conversas que cada organização insere e processa na plataforma, atuamos
                como <span className="text-text-primary font-medium">operador</span>, tratando esses dados{" "}
                em nome e sob as instruções da organização, que é a controladora desses dados.
              </p>
              <p>
                Cada organização é responsável por definir as bases legais, obter os consentimentos
                necessários e atender às requisições dos titulares dos dados que ela insere no HNBCRM.
              </p>
              <p>O controlador dos dados de cadastro, de cobrança e de contato comercial é:</p>
              <LegalIdentification className="block not-italic text-sm text-text-secondary" />
            </LegalSection>

            <LegalSection id="dados-coletados" title="2. Dados que tratamos">
              <p>
                <span className="text-text-primary font-medium">Dados de conta:</span> nome, e-mail,
                credenciais de acesso (armazenadas de forma protegida), organização à qual o usuário
                pertence, papel e permissões, além de registros de auditoria das ações realizadas na
                plataforma. Ao criar uma conta, o seu nome e o seu e-mail também são registrados como
                contato comercial do HNBCRM, para que possamos responder e acompanhar o seu cadastro.
              </p>
              <p>
                <span className="text-text-primary font-medium">Onboarding por conversa:</span> o texto
                que você escreve e os materiais que envia (sites, PDFs, imagens e áudios) na conversa de
                configuração são processados por inteligência artificial de provedores parceiros, que
                podem estar fora do Brasil. Não envie dados pessoais de clientes nessa conversa.
              </p>
              <p>
                <span className="text-text-primary font-medium">
                  Dados processados em nome da organização:
                </span>{" "}
                informações de contatos e leads (como nome, telefone, e-mail, empresa e campos
                personalizados), histórico de conversas e mensagens, tarefas, eventos de calendário e
                metadados relacionados ao atendimento.
              </p>
              <p>
                <span className="text-text-primary font-medium">
                  Membros de grupos de WhatsApp:
                </span>{" "}
                quando a organização opta por acompanhar um grupo, tratamos o identificador do participante
                no WhatsApp (JID e LID), o telefone, o nome de exibição quando a pessoa escreve na sala, o
                conteúdo das mensagens do grupo e, conforme a política de mídia escolhida pela organização,
                os arquivos de mídia enviados na sala. São dados de terceiros, que podem não ter qualquer contato
                anterior com a organização — o tratamento está descrito na cláusula 5 abaixo.
              </p>
              <p>
                <span className="text-text-primary font-medium">Dados técnicos:</span> informações mínimas
                necessárias ao funcionamento e à segurança do serviço, como registros de acesso e uso de
                chaves de API.
              </p>
            </LegalSection>

            <LegalSection id="finalidades" title="3. Finalidades">
              <p>
                Tratamos dados para: fornecer e operar a plataforma; autenticar usuários e controlar
                acessos; permitir a gestão de leads, contatos e conversas; possibilitar integrações via API,
                MCP e webhooks; manter a segurança e a rastreabilidade (logs de auditoria); e cumprir
                obrigações legais e regulatórias.
              </p>
            </LegalSection>

            <LegalSection id="whatsapp" title="4. Canais de mensagem e WhatsApp">
              <p>
                Quando uma organização conecta o WhatsApp, as mensagens trafegam pelo transporte configurado
                por ela. No caso da{" "}
                <span className="text-text-primary font-medium">Cloud API oficial (Meta)</span>, o tráfego
                ocorre pela infraestrutura da Meta, sujeita às políticas dela. No caso do{" "}
                <span className="text-text-primary font-medium">gateway não oficial ("bridge")</span>, as
                mensagens trafegam pelo gateway auto-hospedado e configurado pela própria organização,
                estando sob responsabilidade dela.
              </p>
              <p>
                O conteúdo das conversas é armazenado na plataforma como parte do histórico de atendimento da
                organização. O uso do canal não oficial envolve riscos descritos nos nossos{" "}
                <Link to="/termos" className="text-brand-400 hover:text-brand-300 transition-colors">
                  Termos de Uso
                </Link>
                .
              </p>
            </LegalSection>

            <LegalSection id="instagram-messenger" title="4-A. Instagram e Facebook Messenger">
              <p>
                Quando uma organização conecta uma conta do Instagram ou uma Página do Facebook, o HNBCRM
                trata, em nome dela, os seguintes dados:{" "}
                <span className="text-text-primary font-medium">
                  identificadores da Meta (PSID e IGSID), nome e @ do perfil, mensagens, anexos e reações
                </span>
                . A base é a execução do contrato com a organização cliente, que é a controladora; o HNBCRM
                atua como operador.
              </p>
              <p>
                A conexão é feita pelo fluxo oficial da Meta (Facebook Login for Business). O token da Página
                é armazenado cifrado e sua validade é verificada diariamente. Mídias recebidas são baixadas
                para o armazenamento da plataforma. Mensagens apagadas pelo cliente na Meta também são
                apagadas aqui. No Instagram, a conversa só funciona com a opção{" "}
                <span className="text-text-primary font-medium">"Permitir acesso às mensagens"</span>{" "}
                ativada na conta.
              </p>
              <p className="text-text-primary font-medium">Como pedir a exclusão dos seus dados</p>
              <ul className="list-disc pl-5 space-y-1.5">
                <li>
                  <span className="text-text-primary font-medium">
                    Se você administra a Página ou a conta do Instagram conectada:
                  </span>{" "}
                  remova o HNBCRM em facebook.com &gt; Configurações &gt; Integrações comerciais. Recebemos
                  o aviso da Meta, removemos as credenciais e os canais ficam desconectados. As conversas
                  permanecem com a organização.
                </li>
                <li>
                  <span className="text-text-primary font-medium">
                    Se você conversou com uma empresa pelo Instagram ou Messenger:
                  </span>{" "}
                  peça a exclusão à própria empresa (a controladora) ou escreva para{" "}
                  <a
                    href="mailto:privacidade@hnbcrm.com"
                    className="text-brand-400 hover:text-brand-300 transition-colors"
                  >
                    privacidade@hnbcrm.com
                  </a>{" "}
                  informando a conta e a empresa. Respondemos em até 15 dias.
                </li>
              </ul>
              <p>
                Se você iniciou a exclusão pela Meta, pode acompanhar o andamento pelo código de
                confirmação recebido na página de status indicada por ela.
              </p>
            </LegalSection>

            <LegalSection id="grupos-whatsapp" title="5. Grupos de WhatsApp">
              <p>
                O acompanhamento de grupos de WhatsApp é opcional e ativado grupo a grupo pela própria
                organização. <span className="text-text-primary font-medium">Somente os grupos marcados
                como acompanhados</span> têm a lista de participantes e o conteúdo das mensagens
                armazenados; dos demais grupos de que o número participa guardamos apenas o nome da sala, a
                quantidade de participantes e a data da última atividade, sem nome nem telefone de membros.
              </p>
              <p>
                <span className="text-text-primary font-medium">Finalidade:</span> registrar no histórico de
                atendimento da organização as conversas das salas que ela escolheu acompanhar, permitir que
                a equipe responda a partir da caixa de entrada e, quando a organização ativar os recursos de
                IA, gerar resumos e identificar oportunidades comerciais.
              </p>
              <p>
                <span className="text-text-primary font-medium">Base legal:</span> a definição e a
                documentação da base legal — em regra o legítimo interesse ou o consentimento do titular —
                cabem à organização controladora, que responde por ela perante os titulares e a autoridade
                competente. O HNBCRM atua como operador desses dados.
              </p>
              <p>
                <span className="text-text-primary font-medium">Retenção:</span> os participantes ficam
                armazenados enquanto o grupo estiver marcado como acompanhado. Ao deixar de acompanhar, a
                lista de participantes é apagada e a conversa é arquivada; a exclusão do canal de WhatsApp
                remove os dados das salas associadas àquele número.
              </p>
              <p>
                <span className="text-text-primary font-medium">Mídia dos grupos:</span> a organização
                escolhe, por tipo (imagens, áudios, vídeos e documentos), se os arquivos enviados nos grupos
                acompanhados são baixados sempre, nunca ou apenas quando a mensagem é dirigida a ela — isto
                é, quando menciona o número da organização, responde a uma mensagem dela ou contém uma
                palavra-chave configurada para o assistente de IA da sala. Esta última é a configuração
                padrão. Figurinhas de grupos não são baixadas automaticamente.
              </p>
              <p>
                Quando um arquivo não é baixado, a plataforma não armazena o seu conteúdo nem o submete a
                transcrição ou a leitura por IA. Guardamos apenas metadados (tipo, nome do arquivo e tamanho)
                e uma referência técnica, armazenada de forma criptografada, que permite a um usuário
                autorizado da organização baixar o arquivo sob demanda por até 14 (quatorze) dias. Após esse
                prazo, ou antes dele se a conversa ou o lead correspondente forem excluídos, a referência é
                apagada e o arquivo deixa de poder ser obtido pela plataforma. Essa referência não integra
                as cópias de segurança (backup) nem as exportações de dados disponibilizadas à organização.
              </p>
              <p>
                Arquivos de mídia de grupos já armazenados podem ser removidos para liberar espaço de
                armazenamento; nesse caso, a mensagem permanece no histórico com a indicação de que a mídia
                foi removida.
              </p>
              <p>
                <span className="text-text-primary font-medium">Compartilhamento:</span> se a organização
                ativar os recursos de IA em grupos, o conteúdo das mensagens da sala é enviado ao provedor
                de modelo de linguagem configurado por ela. Os webhooks e a API que a organização configurar
                podem transmitir identificadores (JID e LID), telefones e conteúdo das mensagens a sistemas
                externos escolhidos por ela, sob responsabilidade dela.
              </p>
              <p>
                O envio de mensagens individuais a membros de grupos depende de declaração expressa, pela
                organização, de que possui base legal e consentimento para o contato; a plataforma aplica
                limites de envio e a lista de supressão (pedidos de não contato). As demais condições e
                riscos estão nos nossos{" "}
                <Link to="/termos" className="text-brand-400 hover:text-brand-300 transition-colors">
                  Termos de Uso
                </Link>
                .
              </p>
            </LegalSection>

            <LegalSection id="armazenamento" title="6. Armazenamento e infraestrutura">
              <p>
                Os dados da plataforma são armazenados e processados na infraestrutura da Convex, provedor de
                backend em tempo real utilizado pelo HNBCRM. As credenciais sensíveis de integrações (como
                tokens de canais) são armazenadas de forma criptografada.
              </p>
            </LegalSection>

            <LegalSection id="pagamento" title="6-A. Pagamento e contato comercial">
              <p>
                <span className="text-text-primary font-medium">Pagamento.</span> A cobrança é processada
                pelo Asaas, que atua como operador e também como controlador próprio dos dados de pagamento.
                Enviamos ao Asaas os dados de cobrança (nome ou razão social, CPF ou CNPJ, e-mail e endereço
                de cobrança). O HNBCRM não guarda dados de cartão. A base legal é a execução do contrato, e
                os dados fiscais (nota fiscal) são guardados pelo prazo exigido em lei.
              </p>
              <p>
                <span className="text-text-primary font-medium">Contato comercial.</span> Usamos o nome, o
                e-mail e o telefone de cadastro da conta para falar com você sobre o serviço (avisos de uso
                e de cobrança, novidades e ofertas do próprio HNBCRM), com base no legítimo interesse. Para
                deixar de receber as mensagens comerciais, escreva para{" "}
                <a
                  href={`mailto:${LEGAL_ENTITY.email}`}
                  className="text-brand-400 hover:text-brand-300 transition-colors"
                >
                  {LEGAL_ENTITY.email}
                </a>
                . Avisos de cobrança e do contrato continuam sendo enviados.
              </p>
              <p>
                <span className="text-text-primary font-medium">Lista de novidades.</span> Quem se inscreve
                na lista de novidades do HNBCRM informa o e-mail (e o nome, se quiser). Usamos esses dados
                só para enviar novidades do HNBCRM, com base no consentimento, e você pode sair a qualquer
                momento respondendo a um e-mail ou escrevendo para{" "}
                <a
                  href={`mailto:${LEGAL_ENTITY.dpoEmail}`}
                  className="text-brand-400 hover:text-brand-300 transition-colors"
                >
                  {LEGAL_ENTITY.dpoEmail}
                </a>
                .
              </p>
            </LegalSection>

            <LegalSection id="compartilhamento" title="7. Compartilhamento com terceiros">
              <p>
                Compartilhamos dados apenas com prestadores de serviço estritamente necessários à operação
                da plataforma (por exemplo, a infraestrutura de backend e o serviço de envio de e-mails
                transacionais), e com as plataformas de mensagem que cada organização opta por integrar. Não
                comercializamos dados pessoais.
              </p>
              <p>
                Os suboperadores são: Convex (infraestrutura de backend), Vercel (hospedagem do front),
                Resend (e-mails), provedores de modelo de linguagem configurados pela organização, Meta
                (canais oficiais de mensagem) e Asaas (meio de pagamento). Alguns estão fora do Brasil, e a
                transferência internacional de dados segue o art. 33 da LGPD.
              </p>
              <p>
                Os recursos de inteligência artificial são opcionais e, quando a organização os ativa,
                enviam o conteúdo necessário à resposta ao provedor de modelo de linguagem configurado por
                ela. Do mesmo modo, os webhooks e as chaves de API criados pela organização transmitem dados
                aos sistemas externos que ela escolher. Em ambos os casos, a escolha do destino e a
                conformidade dessa transmissão são de responsabilidade da organização controladora.
              </p>
              <p>
                A tradução automática de mensagens também é opcional, vem desligada e só um administrador
                pode ativá-la. Quando ativada, o texto das mensagens a traduzir é processado primeiro pelo
                mecanismo de tradução hospedado na infraestrutura da própria organização e, se ele não
                estiver disponível, pelo provedor de modelo de linguagem configurado por ela, apenas para
                gerar a versão no outro idioma. A tradução é armazenada junto da mensagem. A escolha do
                provedor e a conformidade dessa transmissão, inclusive a eventual transferência
                internacional de dados, são de responsabilidade da organização controladora.
              </p>
            </LegalSection>

            <LegalSection id="retencao" title="8. Retenção">
              <p>
                Os dados são mantidos enquanto a conta e a organização estiverem ativas e pelo tempo
                necessário para cumprir as finalidades descritas ou obrigações legais. Guardamos
                os dados por 90 dias após o cancelamento ou o fim do teste não contratado, para que a
                organização exporte o que quiser; depois disso eles podem ser eliminados ou anonimizados,
                com aviso prévio, salvo obrigação legal (por exemplo, dados fiscais).
              </p>
              <p>
                Os dados de membros de grupos de WhatsApp seguem a retenção específica da cláusula 5: a
                lista de participantes existe enquanto o grupo estiver acompanhado e é apagada quando a
                organização deixa de acompanhá-lo; a exclusão do canal remove os dados das salas. A
                referência técnica que permite baixar sob demanda uma mídia de grupo não baixada é apagada
                em até 14 (quatorze) dias.
              </p>
            </LegalSection>

            <LegalSection id="direitos" title="9. Direitos do titular">
              <p>
                Nos termos da LGPD, o titular pode solicitar: confirmação da existência de tratamento;
                acesso aos dados; correção de dados incompletos ou desatualizados; anonimização, bloqueio ou
                eliminação de dados desnecessários; portabilidade; informação sobre compartilhamentos; e
                revogação de consentimento.
              </p>
              <p>
                Quando os dados são tratados pelo HNBCRM na qualidade de operador em nome de uma organização,
                as requisições devem ser direcionadas à organização controladora, que poderá acioná-lo como
                operador para atendê-las. Isso vale também para os membros de grupos de WhatsApp: a
                organização que acompanha a sala é quem deve atender aos pedidos de acesso, correção e
                eliminação dos dados desses participantes.
              </p>
            </LegalSection>

            <LegalSection id="seguranca" title="10. Segurança">
              <p>
                Adotamos medidas técnicas e organizacionais razoáveis para proteger os dados, incluindo
                isolamento estrito por organização (multi-tenant), controle de acesso baseado em permissões,
                autenticação por chave de API com hashing e criptografia de credenciais sensíveis. Nenhum
                sistema é totalmente imune a riscos; incidentes relevantes serão tratados conforme a
                legislação aplicável.
              </p>
            </LegalSection>

            <LegalSection id="alteracoes" title="11. Alterações desta Política">
              <p>
                Esta Política pode ser atualizada periodicamente. Alterações relevantes serão comunicadas por
                meios razoáveis, e a data de vigência no topo desta página será atualizada.
              </p>
            </LegalSection>

            <LegalSection id="contato" title="12. Contato e encarregado">
              <p>
                O encarregado pelo tratamento de dados pessoais atende em{" "}
                <a
                  href={`mailto:${LEGAL_ENTITY.dpoEmail}`}
                  className="text-brand-400 hover:text-brand-300 transition-colors"
                >
                  {LEGAL_ENTITY.dpoEmail}
                </a>
                , onde você também pode exercer os direitos de titular. Para dúvidas comerciais, escreva
                para{" "}
                <a
                  href={`mailto:${LEGAL_ENTITY.email}`}
                  className="text-brand-400 hover:text-brand-300 transition-colors"
                >
                  {LEGAL_ENTITY.email}
                </a>
                . Consulte também os nossos{" "}
                <Link to="/termos" className="text-brand-400 hover:text-brand-300 transition-colors">
                  Termos de Uso e Assinatura
                </Link>
                .
              </p>
            </LegalSection>
          </div>
        </main>

        <Footer />
      </div>
    </>
  );
}
