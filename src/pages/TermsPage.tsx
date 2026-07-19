import { Link } from "react-router";
import { ArrowLeft, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { SEO } from "@/components/SEO";
import { Footer } from "@/components/landing/Footer";

const EFFECTIVE_DATE = "19 de julho de 2026";

function LegalSection({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section id={id} className="space-y-3 scroll-mt-24">
      <h2 className="text-xl md:text-2xl font-bold text-text-primary">{title}</h2>
      <div className="space-y-3 text-text-secondary leading-relaxed">{children}</div>
    </section>
  );
}

export function TermsPage() {
  return (
    <>
      <SEO
        title="Termos de Uso"
        description="Termos de Uso do HNBCRM — condições de uso da plataforma, planos, propriedade intelectual, limitação de responsabilidade e o canal WhatsApp não oficial."
        keywords="termos de uso, termos de serviço, hnbcrm, whatsapp, saas"
      />
      <div className="min-h-screen bg-surface-base text-text-primary">
        {/* Header */}
        <header className="sticky top-0 z-30 bg-surface-base/80 backdrop-blur-md border-b border-border">
          <div className="max-w-3xl mx-auto px-4 py-3 flex items-center justify-between gap-4">
            <Link to="/" className="flex items-center gap-2">
              <img
                src="/orange_icon_logo_transparent-bg-528x488.png"
                alt="HNBCRM Logo"
                className="h-7 w-7 object-contain"
              />
              <span className="text-lg font-bold text-text-primary">HNBCRM</span>
            </Link>
            <Link to="/">
              <Button variant="ghost" size="sm">
                <ArrowLeft size={16} />
                Voltar
              </Button>
            </Link>
          </div>
        </header>

        <main className="max-w-3xl mx-auto px-4 py-10 md:py-16">
          {/* Title */}
          <div className="mb-10 space-y-2">
            <h1 className="text-3xl md:text-4xl font-bold text-text-primary">Termos de Uso</h1>
            <p className="text-sm text-text-muted">Vigência: {EFFECTIVE_DATE}</p>
          </div>

          <div className="space-y-10">
            <p className="text-text-secondary leading-relaxed">
              Estes Termos de Uso ("Termos") regem o acesso e o uso da plataforma HNBCRM ("HNBCRM",
              "plataforma" ou "serviço"), um CRM multi-tenant com colaboração entre humanos e agentes de
              IA. Ao criar uma conta ou utilizar o serviço, você declara ter lido, compreendido e aceito
              estes Termos. Caso não concorde, não utilize a plataforma.
            </p>

            <LegalSection id="objeto" title="1. Objeto">
              <p>
                O HNBCRM disponibiliza ferramentas de gestão de relacionamento com clientes: pipeline de
                vendas, gestão de contatos e leads, caixa de entrada multicanal, repasses entre humanos e
                IA, calendário, automações de comunicação, API REST, servidor MCP e webhooks. Os recursos
                disponíveis podem variar conforme o plano contratado e a fase de desenvolvimento do
                produto.
              </p>
            </LegalSection>

            <LegalSection id="conta" title="2. Conta e cadastro">
              <p>
                O uso do serviço exige a criação de uma conta. Você é responsável por manter a
                confidencialidade das suas credenciais e por todas as atividades realizadas na sua conta e
                na sua organização. Você concorda em fornecer informações verdadeiras e mantê-las
                atualizadas, e em notificar imediatamente qualquer uso não autorizado.
              </p>
              <p>
                Administradores de uma organização são responsáveis pelos membros que convidam, pelas
                permissões que concedem e pelas chaves de API e integrações que configuram.
              </p>
            </LegalSection>

            <LegalSection id="uso-aceitavel" title="3. Uso aceitável">
              <p>Ao utilizar o HNBCRM, você concorda em não:</p>
              <ul className="list-disc list-inside space-y-1.5">
                <li>Violar leis aplicáveis, incluindo a legislação de proteção de dados e anti-spam;</li>
                <li>
                  Enviar comunicações não solicitadas em massa, mensagens fraudulentas ou conteúdo ilícito
                  a titulares que não consentiram com o contato;
                </li>
                <li>Tentar comprometer a segurança, a integridade ou a disponibilidade da plataforma;</li>
                <li>Acessar dados de outras organizações ou contornar o isolamento multi-tenant;</li>
                <li>Utilizar o serviço para finalidades que infrinjam direitos de terceiros.</li>
              </ul>
              <p>
                Você é o único responsável pelo conteúdo e pelos dados que insere, importa ou processa por
                meio do HNBCRM, bem como pela obtenção das bases legais necessárias para tratá-los.
              </p>
            </LegalSection>

            <LegalSection id="planos" title="4. Planos, cobrança e disponibilidade">
              <p>
                O HNBCRM encontra-se em fase de Beta Aberto, oferecido gratuitamente. Recursos, limites e
                condições de planos pagos poderão ser introduzidos futuramente, mediante aviso prévio. O
                serviço é fornecido "no estado em que se encontra", e podemos alterar, suspender ou
                descontinuar funcionalidades a qualquer momento durante o período de Beta.
              </p>
            </LegalSection>

            {/* WhatsApp unofficial channel — dedicated risk section */}
            <section id="whatsapp-nao-oficial" className="scroll-mt-24">
              <div className="rounded-xl border border-semantic-warning/40 bg-semantic-warning/10 p-5 md:p-6 space-y-4">
                <div className="flex items-center gap-2">
                  <AlertTriangle size={20} className="text-semantic-warning shrink-0" />
                  <h2 className="text-xl md:text-2xl font-bold text-text-primary">
                    5. Canal WhatsApp não oficial (bridge)
                  </h2>
                </div>
                <div className="space-y-3 text-text-secondary leading-relaxed">
                  <p>
                    O HNBCRM permite conectar o WhatsApp por dois transportes distintos. O primeiro é a{" "}
                    <span className="text-text-primary font-medium">WhatsApp Cloud API oficial (Meta)</span>
                    , aprovada pela Meta e sujeita às suas regras (janela de atendimento de 24 horas e
                    templates de mensagem). O segundo é um{" "}
                    <span className="text-text-primary font-medium">gateway não oficial ("bridge")</span>,
                    auto-hospedado pela organização, que se conecta ao WhatsApp por leitura de QR code
                    utilizando um protocolo não sancionado pela Meta.
                  </p>
                  <p className="text-text-primary font-medium">
                    O uso do canal bridge é opcional, ativado voluntariamente por organização (opt-in) e se
                    dá inteiramente por sua conta e risco. Ao habilitá-lo, você reconhece e concorda que:
                  </p>
                  <ul className="list-disc list-inside space-y-1.5">
                    <li>
                      O canal bridge utiliza um protocolo não autorizado pela Meta e{" "}
                      <span className="text-text-primary font-medium">
                        viola os Termos de Serviço do WhatsApp
                      </span>
                      ;
                    </li>
                    <li>
                      O número de WhatsApp conectado por esse meio{" "}
                      <span className="text-text-primary font-medium">
                        pode ser banido permanentemente
                      </span>
                      , sem aviso prévio e sem possibilidade de recurso;
                    </li>
                    <li>
                      Você assume integralmente o risco de banimento, perda de acesso, perda de dados de
                      conversas e quaisquer prejuízos decorrentes do uso desse canal;
                    </li>
                    <li>
                      O HNBCRM não se responsabiliza por banimentos, indisponibilidade, perda de acesso ao
                      número ou qualquer dano resultante do uso do canal não oficial.
                    </li>
                  </ul>
                  <p>Recomendações para reduzir — mas não eliminar — o risco:</p>
                  <ul className="list-disc list-inside space-y-1.5">
                    <li>
                      Utilize um número dedicado e descartável, nunca o número principal do seu negócio;
                    </li>
                    <li>
                      Não dispare mensagens para desconhecidos ou listas frias — é o principal gatilho de
                      banimento;
                    </li>
                    <li>
                      Faça o aquecimento gradual do número e respeite limites de envio (rate limiting);
                    </li>
                    <li>Contate apenas titulares que consentiram em receber suas mensagens.</li>
                  </ul>
                  <p>
                    A responsabilidade por operar o gateway auto-hospedado, pela infraestrutura e pela
                    conformidade legal do uso desse canal é exclusivamente da organização que o habilita.
                  </p>
                </div>
              </div>
            </section>

            <LegalSection id="propriedade" title="6. Propriedade intelectual">
              <p>
                O HNBCRM é distribuído como software de código aberto sob a licença MIT. O código-fonte está
                disponível publicamente e pode ser utilizado nos termos dessa licença. A marca, o nome, o
                logotipo e os elementos de identidade visual "HNBCRM" permanecem de titularidade de seus
                detentores e não são licenciados junto com o código.
              </p>
              <p>
                Os dados que você insere na plataforma permanecem seus. Você concede ao HNBCRM apenas as
                permissões necessárias para operar o serviço em seu nome.
              </p>
            </LegalSection>

            <LegalSection id="limitacao" title="7. Limitação de responsabilidade">
              <p>
                O serviço é fornecido "no estado em que se encontra" e "conforme disponível", sem garantias
                de qualquer natureza, expressas ou implícitas. Na máxima extensão permitida pela lei
                aplicável, o HNBCRM e seus mantenedores não serão responsáveis por danos indiretos,
                incidentais, especiais, consequenciais ou lucros cessantes decorrentes do uso ou da
                impossibilidade de uso do serviço, incluindo — sem limitação — perdas relacionadas ao canal
                WhatsApp não oficial descrito na cláusula 5.
              </p>
            </LegalSection>

            <LegalSection id="rescisao" title="8. Rescisão">
              <p>
                Você pode encerrar sua conta a qualquer momento. Podemos suspender ou encerrar o acesso em
                caso de violação destes Termos, de uso indevido da plataforma ou por exigência legal. Com o
                encerramento, o acesso ao serviço cessa; os dados poderão ser excluídos conforme nossa{" "}
                <Link to="/privacidade" className="text-brand-400 hover:text-brand-300 transition-colors">
                  Política de Privacidade
                </Link>
                .
              </p>
            </LegalSection>

            <LegalSection id="alteracoes" title="9. Alterações destes Termos">
              <p>
                Podemos atualizar estes Termos periodicamente. Alterações relevantes serão comunicadas por
                meios razoáveis. O uso continuado do serviço após a vigência das alterações representa a sua
                concordância com os Termos revisados.
              </p>
            </LegalSection>

            <LegalSection id="foro" title="10. Legislação aplicável e foro">
              <p>
                Estes Termos são regidos pelas leis da República Federativa do Brasil. Fica eleito o foro da
                comarca do domicílio do titular dos dados para dirimir quaisquer controvérsias, salvo
                disposição legal em contrário.
              </p>
            </LegalSection>

            <LegalSection id="contato" title="11. Contato">
              <p>
                Dúvidas sobre estes Termos podem ser encaminhadas pelos canais de contato indicados no
                repositório do projeto e na nossa{" "}
                <Link to="/privacidade" className="text-brand-400 hover:text-brand-300 transition-colors">
                  Política de Privacidade
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
