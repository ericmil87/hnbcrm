// OpenAPI 3.1.0 specification for the ClawCRM REST API
// Served at /api/v1/openapi.json

export const OPENAPI_SPEC = `{
  "openapi": "3.1.0",
  "info": {
    "title": "ClawCRM API",
    "description": "API REST do ClawCRM — CRM multi-tenant com colaboração entre humanos e agentes de IA. Todos os endpoints requerem autenticação via header X-API-Key. Desde a v0.47 TODA rota também exige uma permissão mínima na chave (categoria + nível, indicados na descrição de cada operação): a chave recebe 403 com o corpo {\\\"error\\\": \\\"Permissão insuficiente\\\", \\\"code\\\": 403} quando não a tem. O nível de cada rota espelha a função equivalente do app — as permissões da chave vêm da própria chave, do membro vinculado ou do padrão do papel (admin, manager, agent, ai).",
    "version": "1.0.0",
    "contact": {
      "name": "ClawCRM"
    }
  },
  "servers": [
    {
      "url": "/",
      "description": "Servidor atual"
    }
  ],
  "security": [
    {
      "ApiKeyAuth": []
    }
  ],
  "tags": [
    { "name": "Leads", "description": "Gerenciamento de leads no pipeline de vendas" },
    { "name": "Contatos", "description": "Gerenciamento de contatos e enriquecimento de dados" },
    { "name": "Conversas", "description": "Conversas multicanal e mensagens" },
    { "name": "Handoffs", "description": "Transferências entre agentes IA e humanos" },
    { "name": "Referência", "description": "Dados de referência: boards, membros e campos" },
    { "name": "Atividades", "description": "Timeline de atividades nos leads" },
    { "name": "Dashboard", "description": "Estatísticas e métricas do dashboard" },
    { "name": "Tarefas", "description": "Gerenciamento de tarefas e lembretes do CRM" },
    { "name": "Fontes", "description": "Fontes de captação de leads" },
    { "name": "Auditoria", "description": "Logs de auditoria" },
    { "name": "Calendario", "description": "Eventos do calendário" },
    { "name": "Dados", "description": "Exportação e importação de dados da organização — exige permissão settings: manage na chave de API" }
  ],
  "paths": {
    "/api/v1/inbound/lead": {
      "post": {
        "tags": ["Leads"],
        "summary": "Criar lead via captura universal",
        "description": "Cria um novo lead com contato e mensagem opcionais. Se o contato não existir, será criado automaticamente. Se uma mensagem for fornecida, uma conversa será criada. Requer permissão leads: edit_own na chave de API.",
        "operationId": "createInboundLead",
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object",
                "required": ["title"],
                "properties": {
                  "title": { "type": "string", "description": "Título do lead" },
                  "contact": {
                    "type": "object",
                    "description": "Dados do contato associado",
                    "properties": {
                      "email": { "type": "string", "format": "email", "description": "Email do contato" },
                      "phone": { "type": "string", "description": "Telefone do contato" },
                      "firstName": { "type": "string", "description": "Primeiro nome" },
                      "lastName": { "type": "string", "description": "Sobrenome" },
                      "company": { "type": "string", "description": "Empresa" }
                    }
                  },
                  "message": { "type": "string", "description": "Mensagem inicial (cria uma conversa)" },
                  "channel": { "type": "string", "enum": ["whatsapp", "telegram", "email", "webchat", "internal"], "default": "webchat", "description": "Canal da conversa" },
                  "value": { "type": "number", "default": 0, "description": "Valor monetário do lead" },
                  "currency": { "type": "string", "description": "Código da moeda (ex: BRL)" },
                  "priority": { "type": "string", "enum": ["low", "medium", "high", "urgent"], "default": "medium", "description": "Prioridade do lead" },
                  "temperature": { "type": "string", "enum": ["cold", "warm", "hot"], "default": "cold", "description": "Temperatura do lead" },
                  "sourceId": { "type": "string", "description": "ID da fonte de captação" },
                  "tags": { "type": "array", "items": { "type": "string" }, "description": "Tags de categorização" },
                  "customFields": { "type": "object", "additionalProperties": true, "description": "Campos personalizados" }
                }
              }
            }
          }
        },
        "responses": {
          "201": {
            "description": "Lead criado com sucesso",
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "properties": {
                    "success": { "type": "boolean", "const": true },
                    "leadId": { "type": "string", "description": "ID do lead criado" },
                    "contactId": { "type": "string", "description": "ID do contato associado" }
                  }
                }
              }
            }
          },
          "400": { "$ref": "#/components/responses/BadRequest" },
          "401": { "$ref": "#/components/responses/Unauthorized" },
          "403": { "$ref": "#/components/responses/Forbidden" },
          "500": { "$ref": "#/components/responses/InternalError" }
        }
      }
    },
    "/api/v1/leads": {
      "get": {
        "tags": ["Leads"],
        "summary": "Listar leads",
        "description": "Retorna a lista de leads da organização com filtros opcionais. Requer permissão leads: view_own na chave de API.",
        "operationId": "listLeads",
        "parameters": [
          { "name": "boardId", "in": "query", "schema": { "type": "string" }, "description": "Filtrar por board (pipeline)" },
          { "name": "stageId", "in": "query", "schema": { "type": "string" }, "description": "Filtrar por estágio" },
          { "name": "assignedTo", "in": "query", "schema": { "type": "string" }, "description": "Filtrar por membro responsável" },
          { "name": "limit", "in": "query", "schema": { "type": "integer", "default": 200, "maximum": 500 }, "description": "Limite de resultados" },
          { "name": "cursor", "in": "query", "schema": { "type": "string" }, "description": "Cursor para paginação (retornado como nextCursor na resposta anterior)" }
        ],
        "responses": {
          "200": {
            "description": "Lista de leads",
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "properties": {
                    "leads": { "type": "array", "items": { "$ref": "#/components/schemas/Lead" } },
                    "nextCursor": { "type": "string", "nullable": true, "description": "Cursor para a próxima página (null se não houver mais)" },
                    "hasMore": { "type": "boolean", "description": "Indica se há mais resultados" }
                  }
                }
              }
            }
          },
          "401": { "$ref": "#/components/responses/Unauthorized" },
          "403": { "$ref": "#/components/responses/Forbidden" },
          "500": { "$ref": "#/components/responses/InternalError" }
        }
      }
    },
    "/api/v1/leads/get": {
      "get": {
        "tags": ["Leads"],
        "summary": "Obter lead",
        "description": "Retorna os dados de um lead específico pelo ID. Requer permissão leads: view_own na chave de API.",
        "operationId": "getLead",
        "parameters": [
          { "name": "id", "in": "query", "required": true, "schema": { "type": "string" }, "description": "ID do lead" }
        ],
        "responses": {
          "200": {
            "description": "Dados do lead",
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "properties": {
                    "lead": { "$ref": "#/components/schemas/Lead" }
                  }
                }
              }
            }
          },
          "400": { "$ref": "#/components/responses/BadRequest" },
          "401": { "$ref": "#/components/responses/Unauthorized" },
          "403": { "$ref": "#/components/responses/Forbidden" },
          "404": { "$ref": "#/components/responses/NotFound" },
          "500": { "$ref": "#/components/responses/InternalError" }
        }
      }
    },
    "/api/v1/leads/update": {
      "post": {
        "tags": ["Leads"],
        "summary": "Atualizar lead",
        "description": "Atualiza os campos de um lead existente. Requer permissão leads: view_own na chave de API.",
        "operationId": "updateLead",
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object",
                "required": ["leadId"],
                "properties": {
                  "leadId": { "type": "string", "description": "ID do lead" },
                  "title": { "type": "string", "description": "Novo título" },
                  "value": { "type": "number", "description": "Novo valor monetário" },
                  "priority": { "type": "string", "enum": ["low", "medium", "high", "urgent"], "description": "Nova prioridade" },
                  "temperature": { "type": "string", "enum": ["cold", "warm", "hot"], "description": "Nova temperatura" },
                  "tags": { "type": "array", "items": { "type": "string" }, "description": "Novas tags" },
                  "customFields": { "type": "object", "additionalProperties": true, "description": "Campos personalizados" },
                  "sourceId": { "type": "string", "description": "ID da fonte de captação" }
                }
              }
            }
          }
        },
        "responses": {
          "200": { "$ref": "#/components/responses/Success" },
          "400": { "$ref": "#/components/responses/BadRequest" },
          "401": { "$ref": "#/components/responses/Unauthorized" },
          "403": { "$ref": "#/components/responses/Forbidden" },
          "500": { "$ref": "#/components/responses/InternalError" }
        }
      }
    },
    "/api/v1/leads/delete": {
      "post": {
        "tags": ["Leads"],
        "summary": "Excluir lead",
        "description": "Remove um lead permanentemente. Requer permissão leads: full na chave de API.",
        "operationId": "deleteLead",
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object",
                "required": ["leadId"],
                "properties": {
                  "leadId": { "type": "string", "description": "ID do lead a excluir" }
                }
              }
            }
          }
        },
        "responses": {
          "200": { "$ref": "#/components/responses/Success" },
          "400": { "$ref": "#/components/responses/BadRequest" },
          "401": { "$ref": "#/components/responses/Unauthorized" },
          "403": { "$ref": "#/components/responses/Forbidden" },
          "500": { "$ref": "#/components/responses/InternalError" }
        }
      }
    },
    "/api/v1/leads/move-stage": {
      "post": {
        "tags": ["Leads"],
        "summary": "Mover lead de estágio",
        "description": "Move um lead para um estágio diferente no pipeline. Requer permissão leads: view_own na chave de API.",
        "operationId": "moveLeadStage",
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object",
                "required": ["leadId", "stageId"],
                "properties": {
                  "leadId": { "type": "string", "description": "ID do lead" },
                  "stageId": { "type": "string", "description": "ID do estágio de destino" }
                }
              }
            }
          }
        },
        "responses": {
          "200": { "$ref": "#/components/responses/Success" },
          "400": { "$ref": "#/components/responses/BadRequest" },
          "401": { "$ref": "#/components/responses/Unauthorized" },
          "403": { "$ref": "#/components/responses/Forbidden" },
          "500": { "$ref": "#/components/responses/InternalError" }
        }
      }
    },
    "/api/v1/leads/assign": {
      "post": {
        "tags": ["Leads"],
        "summary": "Atribuir lead",
        "description": "Atribui ou desatribui um lead a um membro da equipe. Omita assignedTo para desatribuir. Requer permissão leads: view_own na chave de API.",
        "operationId": "assignLead",
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object",
                "required": ["leadId"],
                "properties": {
                  "leadId": { "type": "string", "description": "ID do lead" },
                  "assignedTo": { "type": "string", "description": "ID do membro da equipe (omita para desatribuir)" }
                }
              }
            }
          }
        },
        "responses": {
          "200": { "$ref": "#/components/responses/Success" },
          "400": { "$ref": "#/components/responses/BadRequest" },
          "401": { "$ref": "#/components/responses/Unauthorized" },
          "403": { "$ref": "#/components/responses/Forbidden" },
          "500": { "$ref": "#/components/responses/InternalError" }
        }
      }
    },
    "/api/v1/leads/handoff": {
      "post": {
        "tags": ["Leads", "Handoffs"],
        "summary": "Solicitar handoff",
        "description": "Solicita uma transferência (handoff) do lead para outro membro da equipe. Requer permissão inbox: view_own na chave de API.",
        "operationId": "requestHandoff",
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object",
                "required": ["leadId", "reason"],
                "properties": {
                  "leadId": { "type": "string", "description": "ID do lead" },
                  "reason": { "type": "string", "description": "Motivo do handoff" },
                  "toMemberId": { "type": "string", "description": "ID do membro destino (opcional, qualquer humano se omitido)" },
                  "summary": { "type": "string", "description": "Resumo da conversa" },
                  "suggestedActions": { "type": "array", "items": { "type": "string" }, "description": "Ações sugeridas" }
                }
              }
            }
          }
        },
        "responses": {
          "201": {
            "description": "Handoff criado com sucesso",
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "properties": {
                    "success": { "type": "boolean", "const": true },
                    "handoffId": { "type": "string", "description": "ID do handoff criado" }
                  }
                }
              }
            }
          },
          "400": { "$ref": "#/components/responses/BadRequest" },
          "401": { "$ref": "#/components/responses/Unauthorized" },
          "403": { "$ref": "#/components/responses/Forbidden" },
          "500": { "$ref": "#/components/responses/InternalError" }
        }
      }
    },
    "/api/v1/contacts": {
      "get": {
        "tags": ["Contatos"],
        "summary": "Listar contatos",
        "description": "Retorna a lista de contatos da organização. Requer permissão contacts: view na chave de API.",
        "operationId": "listContacts",
        "parameters": [
          { "name": "limit", "in": "query", "schema": { "type": "integer", "default": 500, "maximum": 500 }, "description": "Limite de resultados" },
          { "name": "cursor", "in": "query", "schema": { "type": "string" }, "description": "Cursor para paginação" }
        ],
        "responses": {
          "200": {
            "description": "Lista de contatos",
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "properties": {
                    "contacts": { "type": "array", "items": { "$ref": "#/components/schemas/Contact" } },
                    "nextCursor": { "type": "string", "nullable": true, "description": "Cursor para a próxima página" },
                    "hasMore": { "type": "boolean", "description": "Indica se há mais resultados" }
                  }
                }
              }
            }
          },
          "401": { "$ref": "#/components/responses/Unauthorized" },
          "403": { "$ref": "#/components/responses/Forbidden" },
          "500": { "$ref": "#/components/responses/InternalError" }
        }
      }
    },
    "/api/v1/contacts/create": {
      "post": {
        "tags": ["Contatos"],
        "summary": "Criar contato",
        "description": "Cria um novo contato na organização. Requer permissão contacts: edit na chave de API.",
        "operationId": "createContact",
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object",
                "properties": {
                  "firstName": { "type": "string", "description": "Primeiro nome" },
                  "lastName": { "type": "string", "description": "Sobrenome" },
                  "email": { "type": "string", "format": "email", "description": "Email" },
                  "phone": { "type": "string", "description": "Telefone" },
                  "company": { "type": "string", "description": "Empresa" },
                  "title": { "type": "string", "description": "Cargo" },
                  "whatsappNumber": { "type": "string", "description": "Número WhatsApp" },
                  "telegramUsername": { "type": "string", "description": "Usuário Telegram" },
                  "tags": { "type": "array", "items": { "type": "string" }, "description": "Tags" },
                  "photoUrl": { "type": "string", "format": "uri", "description": "URL da foto" },
                  "bio": { "type": "string", "description": "Biografia" },
                  "linkedinUrl": { "type": "string", "format": "uri", "description": "URL do LinkedIn" },
                  "instagramUrl": { "type": "string", "format": "uri", "description": "URL do Instagram" },
                  "facebookUrl": { "type": "string", "format": "uri", "description": "URL do Facebook" },
                  "twitterUrl": { "type": "string", "format": "uri", "description": "URL do Twitter/X" },
                  "city": { "type": "string", "description": "Cidade" },
                  "state": { "type": "string", "description": "Estado" },
                  "country": { "type": "string", "description": "País" },
                  "industry": { "type": "string", "description": "Indústria" },
                  "companySize": { "type": "string", "description": "Tamanho da empresa" },
                  "cnpj": { "type": "string", "description": "CNPJ da empresa" },
                  "companyWebsite": { "type": "string", "format": "uri", "description": "Website da empresa" },
                  "preferredContactTime": { "type": "string", "enum": ["morning", "afternoon", "evening"], "description": "Horário preferido para contato" },
                  "deviceType": { "type": "string", "enum": ["android", "iphone", "desktop", "unknown"], "description": "Tipo de dispositivo" },
                  "utmSource": { "type": "string", "description": "UTM source" },
                  "acquisitionChannel": { "type": "string", "description": "Canal de aquisição" },
                  "instagramFollowers": { "type": "number", "description": "Seguidores no Instagram" },
                  "linkedinConnections": { "type": "number", "description": "Conexões no LinkedIn" },
                  "socialInfluenceScore": { "type": "number", "minimum": 0, "maximum": 100, "description": "Score de influência social (0-100)" },
                  "customFields": { "type": "object", "additionalProperties": true, "description": "Campos personalizados" }
                }
              }
            }
          }
        },
        "responses": {
          "201": {
            "description": "Contato criado com sucesso",
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "properties": {
                    "success": { "type": "boolean", "const": true },
                    "contactId": { "type": "string", "description": "ID do contato criado" }
                  }
                }
              }
            }
          },
          "401": { "$ref": "#/components/responses/Unauthorized" },
          "403": { "$ref": "#/components/responses/Forbidden" },
          "500": { "$ref": "#/components/responses/InternalError" }
        }
      }
    },
    "/api/v1/contacts/get": {
      "get": {
        "tags": ["Contatos"],
        "summary": "Obter contato",
        "description": "Retorna os dados de um contato específico pelo ID. Requer permissão contacts: view na chave de API.",
        "operationId": "getContact",
        "parameters": [
          { "name": "id", "in": "query", "required": true, "schema": { "type": "string" }, "description": "ID do contato" }
        ],
        "responses": {
          "200": {
            "description": "Dados do contato",
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "properties": {
                    "contact": { "$ref": "#/components/schemas/Contact" }
                  }
                }
              }
            }
          },
          "400": { "$ref": "#/components/responses/BadRequest" },
          "401": { "$ref": "#/components/responses/Unauthorized" },
          "403": { "$ref": "#/components/responses/Forbidden" },
          "404": { "$ref": "#/components/responses/NotFound" },
          "500": { "$ref": "#/components/responses/InternalError" }
        }
      }
    },
    "/api/v1/contacts/update": {
      "post": {
        "tags": ["Contatos"],
        "summary": "Atualizar contato",
        "description": "Atualiza os campos de um contato existente. Requer permissão contacts: view na chave de API.",
        "operationId": "updateContact",
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object",
                "required": ["contactId"],
                "properties": {
                  "contactId": { "type": "string", "description": "ID do contato" },
                  "firstName": { "type": "string", "description": "Primeiro nome" },
                  "lastName": { "type": "string", "description": "Sobrenome" },
                  "email": { "type": "string", "format": "email", "description": "Email" },
                  "phone": { "type": "string", "description": "Telefone" },
                  "company": { "type": "string", "description": "Empresa" },
                  "title": { "type": "string", "description": "Cargo" },
                  "whatsappNumber": { "type": "string", "description": "Número WhatsApp" },
                  "telegramUsername": { "type": "string", "description": "Usuário Telegram" },
                  "tags": { "type": "array", "items": { "type": "string" }, "description": "Tags" },
                  "photoUrl": { "type": "string", "format": "uri", "description": "URL da foto" },
                  "bio": { "type": "string", "description": "Biografia" },
                  "linkedinUrl": { "type": "string", "format": "uri", "description": "URL do LinkedIn" },
                  "instagramUrl": { "type": "string", "format": "uri", "description": "URL do Instagram" },
                  "facebookUrl": { "type": "string", "format": "uri", "description": "URL do Facebook" },
                  "twitterUrl": { "type": "string", "format": "uri", "description": "URL do Twitter/X" },
                  "city": { "type": "string", "description": "Cidade" },
                  "state": { "type": "string", "description": "Estado" },
                  "country": { "type": "string", "description": "País" },
                  "industry": { "type": "string", "description": "Indústria" },
                  "companySize": { "type": "string", "description": "Tamanho da empresa" },
                  "cnpj": { "type": "string", "description": "CNPJ da empresa" },
                  "companyWebsite": { "type": "string", "format": "uri", "description": "Website da empresa" },
                  "preferredContactTime": { "type": "string", "enum": ["morning", "afternoon", "evening"], "description": "Horário preferido para contato" },
                  "deviceType": { "type": "string", "enum": ["android", "iphone", "desktop", "unknown"], "description": "Tipo de dispositivo" },
                  "utmSource": { "type": "string", "description": "UTM source" },
                  "acquisitionChannel": { "type": "string", "description": "Canal de aquisição" },
                  "instagramFollowers": { "type": "number", "description": "Seguidores no Instagram" },
                  "linkedinConnections": { "type": "number", "description": "Conexões no LinkedIn" },
                  "socialInfluenceScore": { "type": "number", "minimum": 0, "maximum": 100, "description": "Score de influência social (0-100)" },
                  "customFields": { "type": "object", "additionalProperties": true, "description": "Campos personalizados" }
                }
              }
            }
          }
        },
        "responses": {
          "200": { "$ref": "#/components/responses/Success" },
          "400": { "$ref": "#/components/responses/BadRequest" },
          "401": { "$ref": "#/components/responses/Unauthorized" },
          "403": { "$ref": "#/components/responses/Forbidden" },
          "500": { "$ref": "#/components/responses/InternalError" }
        }
      }
    },
    "/api/v1/contacts/enrich": {
      "post": {
        "tags": ["Contatos"],
        "summary": "Enriquecer contato",
        "description": "Enriquece um contato com dados de uma fonte externa. Usado por agentes de IA para adicionar informações descobertas. Requer permissão contacts: edit na chave de API.",
        "operationId": "enrichContact",
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object",
                "required": ["contactId", "fields", "source"],
                "properties": {
                  "contactId": { "type": "string", "description": "ID do contato" },
                  "fields": { "type": "object", "additionalProperties": true, "description": "Campos e valores a enriquecer" },
                  "source": { "type": "string", "description": "Nome da fonte dos dados (ex: linkedin, google)" },
                  "confidence": { "type": "number", "minimum": 0, "maximum": 1, "description": "Score de confiança dos dados (0-1)" }
                }
              }
            }
          }
        },
        "responses": {
          "200": { "$ref": "#/components/responses/Success" },
          "400": { "$ref": "#/components/responses/BadRequest" },
          "401": { "$ref": "#/components/responses/Unauthorized" },
          "403": { "$ref": "#/components/responses/Forbidden" },
          "500": { "$ref": "#/components/responses/InternalError" }
        }
      }
    },
    "/api/v1/contacts/gaps": {
      "get": {
        "tags": ["Contatos"],
        "summary": "Lacunas de enriquecimento",
        "description": "Identifica campos faltantes ou enriquecíveis em um contato. Requer permissão contacts: view na chave de API.",
        "operationId": "getContactGaps",
        "parameters": [
          { "name": "id", "in": "query", "required": true, "schema": { "type": "string" }, "description": "ID do contato" }
        ],
        "responses": {
          "200": {
            "description": "Dados de lacunas do contato",
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "properties": {
                    "contact": { "type": "object", "description": "Contato com informações de lacunas e metadados de enriquecimento" }
                  }
                }
              }
            }
          },
          "400": { "$ref": "#/components/responses/BadRequest" },
          "401": { "$ref": "#/components/responses/Unauthorized" },
          "403": { "$ref": "#/components/responses/Forbidden" },
          "404": { "$ref": "#/components/responses/NotFound" },
          "500": { "$ref": "#/components/responses/InternalError" }
        }
      }
    },
    "/api/v1/contacts/search": {
      "get": {
        "tags": ["Contatos"],
        "summary": "Buscar contatos",
        "description": "Busca contatos por texto (nome, email, empresa, etc). Requer permissão contacts: view na chave de API.",
        "operationId": "searchContacts",
        "parameters": [
          { "name": "q", "in": "query", "required": true, "schema": { "type": "string" }, "description": "Texto de busca" },
          { "name": "limit", "in": "query", "schema": { "type": "integer", "default": 20, "maximum": 100 }, "description": "Limite de resultados" }
        ],
        "responses": {
          "200": {
            "description": "Contatos encontrados",
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "properties": {
                    "contacts": { "type": "array", "items": { "$ref": "#/components/schemas/Contact" } }
                  }
                }
              }
            }
          },
          "400": { "$ref": "#/components/responses/BadRequest" },
          "401": { "$ref": "#/components/responses/Unauthorized" },
          "403": { "$ref": "#/components/responses/Forbidden" },
          "500": { "$ref": "#/components/responses/InternalError" }
        }
      }
    },
    "/api/v1/conversations": {
      "get": {
        "tags": ["Conversas"],
        "summary": "Listar conversas",
        "description": "Retorna a lista de conversas da organização com filtro opcional por lead. Requer permissão inbox: view_own na chave de API.",
        "operationId": "listConversations",
        "parameters": [
          { "name": "leadId", "in": "query", "schema": { "type": "string" }, "description": "Filtrar por lead" },
          { "name": "limit", "in": "query", "schema": { "type": "integer", "default": 200, "maximum": 500 }, "description": "Limite de resultados" },
          { "name": "cursor", "in": "query", "schema": { "type": "string" }, "description": "Cursor para paginação" }
        ],
        "responses": {
          "200": {
            "description": "Lista de conversas",
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "properties": {
                    "conversations": { "type": "array", "items": { "$ref": "#/components/schemas/Conversation" } },
                    "nextCursor": { "type": "string", "nullable": true, "description": "Cursor para a próxima página" },
                    "hasMore": { "type": "boolean", "description": "Indica se há mais resultados" }
                  }
                }
              }
            }
          },
          "401": { "$ref": "#/components/responses/Unauthorized" },
          "403": { "$ref": "#/components/responses/Forbidden" },
          "500": { "$ref": "#/components/responses/InternalError" }
        }
      }
    },
    "/api/v1/conversations/messages": {
      "get": {
        "tags": ["Conversas"],
        "summary": "Listar mensagens",
        "description": "Retorna todas as mensagens de uma conversa. Requer permissão inbox: view_own na chave de API.",
        "operationId": "getMessages",
        "parameters": [
          { "name": "conversationId", "in": "query", "required": true, "schema": { "type": "string" }, "description": "ID da conversa" }
        ],
        "responses": {
          "200": {
            "description": "Lista de mensagens",
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "properties": {
                    "messages": { "type": "array", "items": { "$ref": "#/components/schemas/Message" } }
                  }
                }
              }
            }
          },
          "400": { "$ref": "#/components/responses/BadRequest" },
          "401": { "$ref": "#/components/responses/Unauthorized" },
          "403": { "$ref": "#/components/responses/Forbidden" },
          "500": { "$ref": "#/components/responses/InternalError" }
        }
      }
    },
    "/api/v1/conversations/send": {
      "post": {
        "tags": ["Conversas"],
        "summary": "Enviar mensagem",
        "description": "Envia uma mensagem em uma conversa existente. Requer permissão inbox: view_own na chave de API.",
        "operationId": "sendMessage",
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object",
                "required": ["conversationId", "content"],
                "properties": {
                  "conversationId": { "type": "string", "description": "ID da conversa" },
                  "content": { "type": "string", "description": "Conteúdo da mensagem" },
                  "contentType": { "type": "string", "enum": ["text", "image", "file", "audio"], "default": "text", "description": "Tipo do conteúdo" },
                  "isInternal": { "type": "boolean", "default": false, "description": "Nota interna (não visível ao contato)" }
                }
              }
            }
          }
        },
        "responses": {
          "201": {
            "description": "Mensagem enviada com sucesso",
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "properties": {
                    "success": { "type": "boolean", "const": true },
                    "messageId": { "type": "string", "description": "ID da mensagem criada" }
                  }
                }
              }
            }
          },
          "400": { "$ref": "#/components/responses/BadRequest" },
          "401": { "$ref": "#/components/responses/Unauthorized" },
          "403": { "$ref": "#/components/responses/Forbidden" },
          "500": { "$ref": "#/components/responses/InternalError" }
        }
      }
    },
    "/api/v1/handoffs": {
      "get": {
        "tags": ["Handoffs"],
        "summary": "Listar handoffs",
        "description": "Retorna a lista de handoffs da organização com filtro opcional por status. Requer permissão inbox: view_own na chave de API.",
        "operationId": "listHandoffs",
        "parameters": [
          { "name": "status", "in": "query", "schema": { "type": "string", "enum": ["pending", "accepted", "rejected", "canceled"] }, "description": "Filtrar por status" },
          { "name": "limit", "in": "query", "schema": { "type": "integer", "default": 200, "maximum": 500 }, "description": "Limite de resultados" },
          { "name": "cursor", "in": "query", "schema": { "type": "string" }, "description": "Cursor para paginação" }
        ],
        "responses": {
          "200": {
            "description": "Lista de handoffs",
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "properties": {
                    "handoffs": { "type": "array", "items": { "$ref": "#/components/schemas/Handoff" } },
                    "nextCursor": { "type": "string", "nullable": true, "description": "Cursor para a próxima página" },
                    "hasMore": { "type": "boolean", "description": "Indica se há mais resultados" }
                  }
                }
              }
            }
          },
          "401": { "$ref": "#/components/responses/Unauthorized" },
          "403": { "$ref": "#/components/responses/Forbidden" },
          "500": { "$ref": "#/components/responses/InternalError" }
        }
      }
    },
    "/api/v1/handoffs/pending": {
      "get": {
        "tags": ["Handoffs"],
        "summary": "Listar handoffs pendentes",
        "description": "Atalho para listar apenas handoffs com status pendente. Requer permissão inbox: view_own na chave de API.",
        "operationId": "listPendingHandoffs",
        "responses": {
          "200": {
            "description": "Lista de handoffs pendentes",
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "properties": {
                    "handoffs": { "type": "array", "items": { "$ref": "#/components/schemas/Handoff" } }
                  }
                }
              }
            }
          },
          "401": { "$ref": "#/components/responses/Unauthorized" },
          "403": { "$ref": "#/components/responses/Forbidden" },
          "500": { "$ref": "#/components/responses/InternalError" }
        }
      }
    },
    "/api/v1/handoffs/accept": {
      "post": {
        "tags": ["Handoffs"],
        "summary": "Aceitar handoff",
        "description": "Aceita uma solicitação de handoff pendente. Requer permissão inbox: reply na chave de API.",
        "operationId": "acceptHandoff",
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object",
                "required": ["handoffId"],
                "properties": {
                  "handoffId": { "type": "string", "description": "ID do handoff" },
                  "notes": { "type": "string", "description": "Notas adicionais" }
                }
              }
            }
          }
        },
        "responses": {
          "200": { "$ref": "#/components/responses/Success" },
          "400": { "$ref": "#/components/responses/BadRequest" },
          "401": { "$ref": "#/components/responses/Unauthorized" },
          "403": { "$ref": "#/components/responses/Forbidden" },
          "500": { "$ref": "#/components/responses/InternalError" }
        }
      }
    },
    "/api/v1/handoffs/reject": {
      "post": {
        "tags": ["Handoffs"],
        "summary": "Rejeitar handoff",
        "description": "Rejeita uma solicitação de handoff pendente. Requer permissão inbox: reply na chave de API.",
        "operationId": "rejectHandoff",
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object",
                "required": ["handoffId"],
                "properties": {
                  "handoffId": { "type": "string", "description": "ID do handoff" },
                  "notes": { "type": "string", "description": "Notas adicionais" }
                }
              }
            }
          }
        },
        "responses": {
          "200": { "$ref": "#/components/responses/Success" },
          "400": { "$ref": "#/components/responses/BadRequest" },
          "401": { "$ref": "#/components/responses/Unauthorized" },
          "403": { "$ref": "#/components/responses/Forbidden" },
          "500": { "$ref": "#/components/responses/InternalError" }
        }
      }
    },
    "/api/v1/boards": {
      "get": {
        "tags": ["Referência"],
        "summary": "Listar boards com estágios",
        "description": "Retorna todos os boards (pipelines) da organização com seus estágios. Requer permissão leads: view_own na chave de API.",
        "operationId": "listBoards",
        "responses": {
          "200": {
            "description": "Lista de boards com estágios",
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "properties": {
                    "boards": {
                      "type": "array",
                      "items": {
                        "allOf": [
                          { "$ref": "#/components/schemas/Board" },
                          {
                            "type": "object",
                            "properties": {
                              "stages": { "type": "array", "items": { "$ref": "#/components/schemas/Stage" } }
                            }
                          }
                        ]
                      }
                    }
                  }
                }
              }
            }
          },
          "401": { "$ref": "#/components/responses/Unauthorized" },
          "403": { "$ref": "#/components/responses/Forbidden" },
          "500": { "$ref": "#/components/responses/InternalError" }
        }
      }
    },
    "/api/v1/team-members": {
      "get": {
        "tags": ["Referência"],
        "summary": "Listar membros da equipe",
        "description": "Retorna todos os membros da equipe (humanos e agentes IA). Cada membro inclui um campo opcional 'permissions' com 9 categorias RBAC. Operacoes de gerenciamento (convite, edicao, remocao) sao mutacoes Convex e nao estao disponiveis via REST. Requer apenas API key válida (espelha o app: qualquer membro vê a equipe).",
        "operationId": "listTeamMembers",
        "responses": {
          "200": {
            "description": "Lista de membros",
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "properties": {
                    "members": { "type": "array", "items": { "$ref": "#/components/schemas/TeamMember" } }
                  }
                }
              }
            }
          },
          "401": { "$ref": "#/components/responses/Unauthorized" },
          "403": { "$ref": "#/components/responses/Forbidden" },
          "500": { "$ref": "#/components/responses/InternalError" }
        }
      }
    },
    "/api/v1/field-definitions": {
      "get": {
        "tags": ["Referência"],
        "summary": "Listar definições de campos",
        "description": "Retorna as definições de campos personalizados da organização. Requer permissão leads: view_own na chave de API.",
        "operationId": "listFieldDefinitions",
        "responses": {
          "200": {
            "description": "Lista de definições de campos",
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "properties": {
                    "fields": { "type": "array", "items": { "$ref": "#/components/schemas/FieldDefinition" } }
                  }
                }
              }
            }
          },
          "401": { "$ref": "#/components/responses/Unauthorized" },
          "403": { "$ref": "#/components/responses/Forbidden" },
          "500": { "$ref": "#/components/responses/InternalError" }
        }
      }
    },
    "/api/v1/activities": {
      "get": {
        "tags": ["Atividades"],
        "summary": "Listar atividades",
        "description": "Retorna as atividades de um lead específico. Requer permissão leads: view_own na chave de API.",
        "operationId": "listActivities",
        "parameters": [
          { "name": "leadId", "in": "query", "required": true, "schema": { "type": "string" }, "description": "ID do lead" },
          { "name": "limit", "in": "query", "schema": { "type": "integer", "default": 50, "maximum": 200 }, "description": "Limite de resultados" },
          { "name": "cursor", "in": "query", "schema": { "type": "string" }, "description": "Cursor para paginação" }
        ],
        "responses": {
          "200": {
            "description": "Lista de atividades",
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "properties": {
                    "activities": { "type": "array", "items": { "$ref": "#/components/schemas/Activity" } },
                    "nextCursor": { "type": "string", "nullable": true, "description": "Cursor para a próxima página" },
                    "hasMore": { "type": "boolean", "description": "Indica se há mais resultados" }
                  }
                }
              }
            }
          },
          "400": { "$ref": "#/components/responses/BadRequest" },
          "401": { "$ref": "#/components/responses/Unauthorized" },
          "403": { "$ref": "#/components/responses/Forbidden" },
          "500": { "$ref": "#/components/responses/InternalError" }
        }
      },
      "post": {
        "tags": ["Atividades"],
        "summary": "Criar atividade",
        "description": "Registra uma nova atividade em um lead. Requer permissão leads: view_own na chave de API.",
        "operationId": "createActivity",
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object",
                "required": ["leadId", "type"],
                "properties": {
                  "leadId": { "type": "string", "description": "ID do lead" },
                  "type": { "type": "string", "enum": ["note", "call", "email", "meeting", "task"], "description": "Tipo da atividade" },
                  "content": { "type": "string", "description": "Conteúdo ou descrição da atividade" },
                  "metadata": { "type": "object", "additionalProperties": true, "description": "Metadados adicionais" }
                }
              }
            }
          }
        },
        "responses": {
          "201": {
            "description": "Atividade criada com sucesso",
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "properties": {
                    "success": { "type": "boolean", "const": true },
                    "activityId": { "type": "string", "description": "ID da atividade criada" }
                  }
                }
              }
            }
          },
          "400": { "$ref": "#/components/responses/BadRequest" },
          "401": { "$ref": "#/components/responses/Unauthorized" },
          "403": { "$ref": "#/components/responses/Forbidden" },
          "500": { "$ref": "#/components/responses/InternalError" }
        }
      }
    },
    "/api/v1/dashboard": {
      "get": {
        "tags": ["Dashboard"],
        "summary": "Obter estatísticas do dashboard",
        "description": "Retorna métricas agregadas da organização: total de leads, leads do mês, taxa de conversão, valor total e leads por estágio. Requer permissão reports: view na chave de API.",
        "operationId": "getDashboardStats",
        "responses": {
          "200": {
            "description": "Estatísticas do dashboard",
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "properties": {
                    "totalLeads": { "type": "integer", "description": "Total de leads" },
                    "leadsThisMonth": { "type": "integer", "description": "Leads criados este mês" },
                    "conversionRate": { "type": "number", "description": "Taxa de conversão (0-1)" },
                    "totalValue": { "type": "number", "description": "Valor total do pipeline" },
                    "leadsByStage": { "type": "object", "additionalProperties": { "type": "integer" }, "description": "Contagem de leads por estágio (chave: nome do estágio)" }
                  }
                }
              }
            }
          },
          "401": { "$ref": "#/components/responses/Unauthorized" },
          "403": { "$ref": "#/components/responses/Forbidden" },
          "500": { "$ref": "#/components/responses/InternalError" }
        }
      }
    },
    "/api/v1/lead-sources": {
      "get": {
        "tags": ["Fontes"],
        "summary": "Listar fontes de leads",
        "description": "Retorna todas as fontes de captação de leads da organização. Requer permissão leads: view_own na chave de API.",
        "operationId": "listLeadSources",
        "responses": {
          "200": {
            "description": "Lista de fontes",
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "properties": {
                    "sources": { "type": "array", "items": { "$ref": "#/components/schemas/LeadSource" } }
                  }
                }
              }
            }
          },
          "401": { "$ref": "#/components/responses/Unauthorized" },
          "403": { "$ref": "#/components/responses/Forbidden" },
          "500": { "$ref": "#/components/responses/InternalError" }
        }
      }
    },
    "/api/v1/tasks": {
      "get": {
        "tags": ["Tarefas"],
        "summary": "Listar tarefas",
        "description": "Retorna tarefas da organização com filtros opcionais. Requer permissão tasks: view_own na chave de API.",
        "operationId": "listTasks",
        "parameters": [
          { "name": "status", "in": "query", "schema": { "type": "string", "enum": ["pending", "in_progress", "completed", "cancelled"] }, "description": "Filtrar por status" },
          { "name": "priority", "in": "query", "schema": { "type": "string", "enum": ["low", "medium", "high", "urgent"] }, "description": "Filtrar por prioridade" },
          { "name": "assignedTo", "in": "query", "schema": { "type": "string" }, "description": "Filtrar por responsável" },
          { "name": "leadId", "in": "query", "schema": { "type": "string" }, "description": "Filtrar por lead" },
          { "name": "contactId", "in": "query", "schema": { "type": "string" }, "description": "Filtrar por contato" },
          { "name": "type", "in": "query", "schema": { "type": "string", "enum": ["task", "reminder"] }, "description": "Filtrar por tipo" },
          { "name": "activityType", "in": "query", "schema": { "type": "string", "enum": ["todo", "call", "email", "follow_up", "meeting", "research"] }, "description": "Filtrar por tipo de atividade" },
          { "name": "dueBefore", "in": "query", "schema": { "type": "number" }, "description": "Data limite antes de (timestamp ms)" },
          { "name": "dueAfter", "in": "query", "schema": { "type": "number" }, "description": "Data limite após (timestamp ms)" },
          { "name": "limit", "in": "query", "schema": { "type": "integer", "default": 200, "maximum": 500 }, "description": "Limite de resultados" },
          { "name": "cursor", "in": "query", "schema": { "type": "string" }, "description": "Cursor para paginação" }
        ],
        "responses": {
          "200": {
            "description": "Lista de tarefas",
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "properties": {
                    "tasks": { "type": "array", "items": { "$ref": "#/components/schemas/Task" } },
                    "nextCursor": { "type": "string", "nullable": true },
                    "hasMore": { "type": "boolean" }
                  }
                }
              }
            }
          },
          "401": { "$ref": "#/components/responses/Unauthorized" },
          "403": { "$ref": "#/components/responses/Forbidden" },
          "500": { "$ref": "#/components/responses/InternalError" }
        }
      }
    },
    "/api/v1/tasks/get": {
      "get": {
        "tags": ["Tarefas"],
        "summary": "Obter tarefa",
        "description": "Retorna os dados de uma tarefa específica pelo ID. Requer permissão tasks: view_own na chave de API.",
        "operationId": "getTask",
        "parameters": [
          { "name": "id", "in": "query", "required": true, "schema": { "type": "string" }, "description": "ID da tarefa" }
        ],
        "responses": {
          "200": {
            "description": "Dados da tarefa",
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "properties": {
                    "task": { "$ref": "#/components/schemas/Task" }
                  }
                }
              }
            }
          },
          "400": { "$ref": "#/components/responses/BadRequest" },
          "401": { "$ref": "#/components/responses/Unauthorized" },
          "403": { "$ref": "#/components/responses/Forbidden" },
          "404": { "$ref": "#/components/responses/NotFound" },
          "500": { "$ref": "#/components/responses/InternalError" }
        }
      }
    },
    "/api/v1/tasks/my": {
      "get": {
        "tags": ["Tarefas"],
        "summary": "Minhas tarefas",
        "description": "Retorna tarefas pendentes e em andamento do agente autenticado. Requer permissão tasks: view_own na chave de API.",
        "operationId": "getMyTasks",
        "responses": {
          "200": {
            "description": "Tarefas do agente",
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "properties": {
                    "tasks": { "type": "array", "items": { "$ref": "#/components/schemas/Task" } }
                  }
                }
              }
            }
          },
          "401": { "$ref": "#/components/responses/Unauthorized" },
          "403": { "$ref": "#/components/responses/Forbidden" },
          "500": { "$ref": "#/components/responses/InternalError" }
        }
      }
    },
    "/api/v1/tasks/overdue": {
      "get": {
        "tags": ["Tarefas"],
        "summary": "Tarefas atrasadas",
        "description": "Lista tarefas com data de vencimento no passado e status pendente ou em andamento. Requer permissão tasks: view_own na chave de API.",
        "operationId": "getOverdueTasks",
        "parameters": [
          { "name": "limit", "in": "query", "schema": { "type": "integer", "default": 200, "maximum": 500 }, "description": "Limite de resultados" },
          { "name": "cursor", "in": "query", "schema": { "type": "string" }, "description": "Cursor para paginação" }
        ],
        "responses": {
          "200": {
            "description": "Tarefas atrasadas",
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "properties": {
                    "tasks": { "type": "array", "items": { "$ref": "#/components/schemas/Task" } },
                    "nextCursor": { "type": "string", "nullable": true },
                    "hasMore": { "type": "boolean" }
                  }
                }
              }
            }
          },
          "401": { "$ref": "#/components/responses/Unauthorized" },
          "403": { "$ref": "#/components/responses/Forbidden" },
          "500": { "$ref": "#/components/responses/InternalError" }
        }
      }
    },
    "/api/v1/tasks/search": {
      "get": {
        "tags": ["Tarefas"],
        "summary": "Buscar tarefas",
        "description": "Busca tarefas por texto (título, descrição). Requer permissão tasks: view_own na chave de API.",
        "operationId": "searchTasks",
        "parameters": [
          { "name": "q", "in": "query", "required": true, "schema": { "type": "string" }, "description": "Texto de busca" },
          { "name": "limit", "in": "query", "schema": { "type": "integer", "default": 50, "maximum": 100 }, "description": "Limite de resultados" }
        ],
        "responses": {
          "200": {
            "description": "Tarefas encontradas",
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "properties": {
                    "tasks": { "type": "array", "items": { "$ref": "#/components/schemas/Task" } }
                  }
                }
              }
            }
          },
          "400": { "$ref": "#/components/responses/BadRequest" },
          "401": { "$ref": "#/components/responses/Unauthorized" },
          "403": { "$ref": "#/components/responses/Forbidden" },
          "500": { "$ref": "#/components/responses/InternalError" }
        }
      }
    },
    "/api/v1/tasks/create": {
      "post": {
        "tags": ["Tarefas"],
        "summary": "Criar tarefa",
        "description": "Cria uma nova tarefa ou lembrete. Requer permissão tasks: view_own na chave de API.",
        "operationId": "createTask",
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object",
                "required": ["title"],
                "properties": {
                  "title": { "type": "string", "description": "Título da tarefa" },
                  "type": { "type": "string", "enum": ["task", "reminder"], "default": "task", "description": "Tipo" },
                  "priority": { "type": "string", "enum": ["low", "medium", "high", "urgent"], "default": "medium", "description": "Prioridade" },
                  "activityType": { "type": "string", "enum": ["todo", "call", "email", "follow_up", "meeting", "research"], "description": "Tipo de atividade CRM" },
                  "description": { "type": "string", "description": "Descrição detalhada" },
                  "dueDate": { "type": "number", "description": "Data de vencimento (timestamp ms)" },
                  "leadId": { "type": "string", "description": "ID do lead associado" },
                  "contactId": { "type": "string", "description": "ID do contato associado" },
                  "assignedTo": { "type": "string", "description": "ID do membro responsável" },
                  "recurrence": {
                    "type": "object",
                    "properties": {
                      "pattern": { "type": "string", "enum": ["daily", "weekly", "biweekly", "monthly"], "description": "Padrão de recorrência" },
                      "endDate": { "type": "number", "description": "Data final da recorrência (timestamp ms)" }
                    }
                  },
                  "checklist": { "type": "array", "items": { "type": "object", "properties": { "id": { "type": "string" }, "title": { "type": "string" }, "completed": { "type": "boolean" } } }, "description": "Itens do checklist" },
                  "tags": { "type": "array", "items": { "type": "string" }, "description": "Tags" }
                }
              }
            }
          }
        },
        "responses": {
          "201": {
            "description": "Tarefa criada",
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "properties": {
                    "success": { "type": "boolean", "const": true },
                    "taskId": { "type": "string", "description": "ID da tarefa criada" }
                  }
                }
              }
            }
          },
          "400": { "$ref": "#/components/responses/BadRequest" },
          "401": { "$ref": "#/components/responses/Unauthorized" },
          "403": { "$ref": "#/components/responses/Forbidden" },
          "500": { "$ref": "#/components/responses/InternalError" }
        }
      }
    },
    "/api/v1/tasks/update": {
      "post": {
        "tags": ["Tarefas"],
        "summary": "Atualizar tarefa",
        "description": "Atualiza campos de uma tarefa existente. Requer permissão tasks: view_own na chave de API.",
        "operationId": "updateTask",
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object",
                "required": ["taskId"],
                "properties": {
                  "taskId": { "type": "string", "description": "ID da tarefa" },
                  "title": { "type": "string", "description": "Novo título" },
                  "description": { "type": "string", "description": "Nova descrição" },
                  "priority": { "type": "string", "enum": ["low", "medium", "high", "urgent"], "description": "Nova prioridade" },
                  "activityType": { "type": "string", "enum": ["todo", "call", "email", "follow_up", "meeting", "research"], "description": "Novo tipo de atividade" },
                  "dueDate": { "type": "number", "description": "Nova data de vencimento (timestamp ms)" },
                  "tags": { "type": "array", "items": { "type": "string" }, "description": "Novas tags" }
                }
              }
            }
          }
        },
        "responses": {
          "200": { "$ref": "#/components/responses/Success" },
          "400": { "$ref": "#/components/responses/BadRequest" },
          "401": { "$ref": "#/components/responses/Unauthorized" },
          "403": { "$ref": "#/components/responses/Forbidden" },
          "500": { "$ref": "#/components/responses/InternalError" }
        }
      }
    },
    "/api/v1/tasks/complete": {
      "post": {
        "tags": ["Tarefas"],
        "summary": "Concluir tarefa",
        "description": "Marca uma tarefa como concluída. Requer permissão tasks: view_own na chave de API.",
        "operationId": "completeTask",
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object",
                "required": ["taskId"],
                "properties": {
                  "taskId": { "type": "string", "description": "ID da tarefa" }
                }
              }
            }
          }
        },
        "responses": {
          "200": { "$ref": "#/components/responses/Success" },
          "400": { "$ref": "#/components/responses/BadRequest" },
          "401": { "$ref": "#/components/responses/Unauthorized" },
          "403": { "$ref": "#/components/responses/Forbidden" },
          "500": { "$ref": "#/components/responses/InternalError" }
        }
      }
    },
    "/api/v1/tasks/delete": {
      "post": {
        "tags": ["Tarefas"],
        "summary": "Excluir tarefa",
        "description": "Remove uma tarefa permanentemente. Requer permissão tasks: view_own na chave de API.",
        "operationId": "deleteTask",
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object",
                "required": ["taskId"],
                "properties": {
                  "taskId": { "type": "string", "description": "ID da tarefa a excluir" }
                }
              }
            }
          }
        },
        "responses": {
          "200": { "$ref": "#/components/responses/Success" },
          "400": { "$ref": "#/components/responses/BadRequest" },
          "401": { "$ref": "#/components/responses/Unauthorized" },
          "403": { "$ref": "#/components/responses/Forbidden" },
          "500": { "$ref": "#/components/responses/InternalError" }
        }
      }
    },
    "/api/v1/tasks/assign": {
      "post": {
        "tags": ["Tarefas"],
        "summary": "Atribuir tarefa",
        "description": "Atribui ou desatribui uma tarefa a um membro da equipe. Requer permissão tasks: view_own na chave de API.",
        "operationId": "assignTask",
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object",
                "required": ["taskId"],
                "properties": {
                  "taskId": { "type": "string", "description": "ID da tarefa" },
                  "assignedTo": { "type": "string", "description": "ID do membro (omita para desatribuir)" }
                }
              }
            }
          }
        },
        "responses": {
          "200": { "$ref": "#/components/responses/Success" },
          "400": { "$ref": "#/components/responses/BadRequest" },
          "401": { "$ref": "#/components/responses/Unauthorized" },
          "403": { "$ref": "#/components/responses/Forbidden" },
          "500": { "$ref": "#/components/responses/InternalError" }
        }
      }
    },
    "/api/v1/tasks/snooze": {
      "post": {
        "tags": ["Tarefas"],
        "summary": "Definir lembrete",
        "description": "Define um lembrete para uma tarefa. Requer permissão tasks: view_own na chave de API.",
        "operationId": "snoozeTask",
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object",
                "required": ["taskId", "snoozedUntil"],
                "properties": {
                  "taskId": { "type": "string", "description": "ID da tarefa" },
                  "snoozedUntil": { "type": "number", "description": "Data/hora do lembrete (timestamp ms)" }
                }
              }
            }
          }
        },
        "responses": {
          "200": { "$ref": "#/components/responses/Success" },
          "400": { "$ref": "#/components/responses/BadRequest" },
          "401": { "$ref": "#/components/responses/Unauthorized" },
          "403": { "$ref": "#/components/responses/Forbidden" },
          "500": { "$ref": "#/components/responses/InternalError" }
        }
      }
    },
    "/api/v1/tasks/bulk": {
      "post": {
        "tags": ["Tarefas"],
        "summary": "Operações em lote",
        "description": "Executa operações em lote em múltiplas tarefas (completar, deletar, atribuir). Requer permissão tasks: view_own na chave de API.",
        "operationId": "bulkTaskUpdate",
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object",
                "required": ["taskIds", "action"],
                "properties": {
                  "taskIds": { "type": "array", "items": { "type": "string" }, "description": "IDs das tarefas" },
                  "action": { "type": "string", "enum": ["complete", "delete", "assign"], "description": "Ação a executar" },
                  "assignedTo": { "type": "string", "description": "ID do membro (apenas para ação assign)" }
                }
              }
            }
          }
        },
        "responses": {
          "200": { "$ref": "#/components/responses/Success" },
          "400": { "$ref": "#/components/responses/BadRequest" },
          "401": { "$ref": "#/components/responses/Unauthorized" },
          "403": { "$ref": "#/components/responses/Forbidden" },
          "500": { "$ref": "#/components/responses/InternalError" }
        }
      }
    },
    "/api/v1/tasks/comments": {
      "get": {
        "tags": ["Tarefas"],
        "summary": "Listar comentários de tarefa",
        "description": "Retorna comentários de uma tarefa com paginação. Requer permissão tasks: view_own na chave de API.",
        "operationId": "listTaskComments",
        "parameters": [
          { "name": "taskId", "in": "query", "required": true, "schema": { "type": "string" }, "description": "ID da tarefa" },
          { "name": "limit", "in": "query", "schema": { "type": "integer", "default": 200, "maximum": 500 }, "description": "Limite de resultados" },
          { "name": "cursor", "in": "query", "schema": { "type": "string" }, "description": "Cursor para paginação" }
        ],
        "responses": {
          "200": {
            "description": "Lista de comentários",
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "properties": {
                    "comments": { "type": "array", "items": { "$ref": "#/components/schemas/TaskComment" } },
                    "nextCursor": { "type": "string", "nullable": true },
                    "hasMore": { "type": "boolean" }
                  }
                }
              }
            }
          },
          "400": { "$ref": "#/components/responses/BadRequest" },
          "401": { "$ref": "#/components/responses/Unauthorized" },
          "403": { "$ref": "#/components/responses/Forbidden" },
          "500": { "$ref": "#/components/responses/InternalError" }
        }
      }
    },
    "/api/v1/tasks/comments/add": {
      "post": {
        "tags": ["Tarefas"],
        "summary": "Adicionar comentário",
        "description": "Adiciona um comentário a uma tarefa. Requer permissão tasks: view_own na chave de API.",
        "operationId": "addTaskComment",
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object",
                "required": ["taskId", "content"],
                "properties": {
                  "taskId": { "type": "string", "description": "ID da tarefa" },
                  "content": { "type": "string", "description": "Conteúdo do comentário" },
                  "mentionedUserIds": { "type": "array", "items": { "type": "string" }, "description": "IDs de membros mencionados" }
                }
              }
            }
          }
        },
        "responses": {
          "201": {
            "description": "Comentário adicionado",
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "properties": {
                    "success": { "type": "boolean", "const": true },
                    "commentId": { "type": "string", "description": "ID do comentário criado" }
                  }
                }
              }
            }
          },
          "400": { "$ref": "#/components/responses/BadRequest" },
          "401": { "$ref": "#/components/responses/Unauthorized" },
          "403": { "$ref": "#/components/responses/Forbidden" },
          "500": { "$ref": "#/components/responses/InternalError" }
        }
      }
    },
    "/api/v1/audit-logs": {
      "get": {
        "tags": ["Auditoria"],
        "summary": "Listar logs de auditoria",
        "description": "Retorna logs de auditoria da organização com filtros e paginação por cursor. Requer permissão auditLogs: view na chave de API.",
        "operationId": "listAuditLogs",
        "parameters": [
          { "name": "entityType", "in": "query", "schema": { "type": "string" }, "description": "Filtrar por tipo de entidade (ex: lead, contact)" },
          { "name": "action", "in": "query", "schema": { "type": "string", "enum": ["create", "update", "delete", "move", "assign", "handoff"] }, "description": "Filtrar por ação" },
          { "name": "severity", "in": "query", "schema": { "type": "string", "enum": ["low", "medium", "high", "critical"] }, "description": "Filtrar por severidade" },
          { "name": "actorId", "in": "query", "schema": { "type": "string" }, "description": "Filtrar por ID do ator" },
          { "name": "startDate", "in": "query", "schema": { "type": "number" }, "description": "Timestamp inicial (ms)" },
          { "name": "endDate", "in": "query", "schema": { "type": "number" }, "description": "Timestamp final (ms)" },
          { "name": "cursor", "in": "query", "schema": { "type": "string" }, "description": "Cursor para paginação" },
          { "name": "limit", "in": "query", "schema": { "type": "integer", "maximum": 200 }, "description": "Limite de resultados" }
        ],
        "responses": {
          "200": {
            "description": "Lista de logs de auditoria",
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "properties": {
                    "logs": { "type": "array", "items": { "$ref": "#/components/schemas/AuditLog" } },
                    "nextCursor": { "type": "string", "description": "Cursor para a próxima página" },
                    "hasMore": { "type": "boolean", "description": "Indica se há mais resultados" }
                  }
                }
              }
            }
          },
          "401": { "$ref": "#/components/responses/Unauthorized" },
          "403": { "$ref": "#/components/responses/Forbidden" },
          "500": { "$ref": "#/components/responses/InternalError" }
        }
      }
    },
    "/api/v1/calendar/events": {
      "get": {
        "tags": ["Calendario"],
        "summary": "Listar eventos do calendario",
        "description": "Retorna eventos do calendario em um intervalo de datas com filtros opcionais. Pode incluir tarefas com data de vencimento no intervalo. Requer permissão tasks: view_own na chave de API.",
        "operationId": "listCalendarEvents",
        "parameters": [
          { "name": "startDate", "in": "query", "required": true, "schema": { "type": "number" }, "description": "Inicio do intervalo (timestamp ms)" },
          { "name": "endDate", "in": "query", "required": true, "schema": { "type": "number" }, "description": "Fim do intervalo (timestamp ms)" },
          { "name": "assignedTo", "in": "query", "schema": { "type": "string" }, "description": "Filtrar por responsavel" },
          { "name": "eventType", "in": "query", "schema": { "type": "string", "enum": ["call", "meeting", "follow_up", "demo", "task", "reminder", "other"] }, "description": "Filtrar por tipo de evento" },
          { "name": "status", "in": "query", "schema": { "type": "string", "enum": ["scheduled", "completed", "cancelled"] }, "description": "Filtrar por status" },
          { "name": "leadId", "in": "query", "schema": { "type": "string" }, "description": "Filtrar por lead" },
          { "name": "contactId", "in": "query", "schema": { "type": "string" }, "description": "Filtrar por contato" },
          { "name": "includeTasks", "in": "query", "schema": { "type": "boolean", "default": true }, "description": "Incluir tarefas com dueDate no intervalo" }
        ],
        "responses": {
          "200": {
            "description": "Lista de eventos",
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "properties": {
                    "events": { "type": "array", "items": { "$ref": "#/components/schemas/CalendarEvent" } }
                  }
                }
              }
            }
          },
          "400": { "$ref": "#/components/responses/BadRequest" },
          "401": { "$ref": "#/components/responses/Unauthorized" },
          "403": { "$ref": "#/components/responses/Forbidden" },
          "500": { "$ref": "#/components/responses/InternalError" }
        }
      }
    },
    "/api/v1/calendar/events/get": {
      "get": {
        "tags": ["Calendario"],
        "summary": "Obter evento",
        "description": "Retorna os dados de um evento especifico pelo ID. Requer permissão tasks: view_own na chave de API.",
        "operationId": "getCalendarEvent",
        "parameters": [
          { "name": "id", "in": "query", "required": true, "schema": { "type": "string" }, "description": "ID do evento" }
        ],
        "responses": {
          "200": {
            "description": "Dados do evento",
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "properties": {
                    "event": { "$ref": "#/components/schemas/CalendarEvent" }
                  }
                }
              }
            }
          },
          "400": { "$ref": "#/components/responses/BadRequest" },
          "401": { "$ref": "#/components/responses/Unauthorized" },
          "403": { "$ref": "#/components/responses/Forbidden" },
          "404": { "$ref": "#/components/responses/NotFound" },
          "500": { "$ref": "#/components/responses/InternalError" }
        }
      }
    },
    "/api/v1/calendar/events/create": {
      "post": {
        "tags": ["Calendario"],
        "summary": "Criar evento",
        "description": "Cria um novo evento no calendario. Requer permissão tasks: view_own na chave de API.",
        "operationId": "createCalendarEvent",
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object",
                "required": ["title", "eventType", "startTime", "endTime"],
                "properties": {
                  "title": { "type": "string", "description": "Titulo do evento" },
                  "eventType": { "type": "string", "enum": ["call", "meeting", "follow_up", "demo", "task", "reminder", "other"], "description": "Tipo do evento" },
                  "startTime": { "type": "number", "description": "Inicio (timestamp ms)" },
                  "endTime": { "type": "number", "description": "Fim (timestamp ms)" },
                  "allDay": { "type": "boolean", "default": false, "description": "Evento de dia inteiro" },
                  "description": { "type": "string", "description": "Descricao" },
                  "leadId": { "type": "string", "description": "ID do lead associado" },
                  "contactId": { "type": "string", "description": "ID do contato associado" },
                  "assignedTo": { "type": "string", "description": "ID do responsavel" },
                  "attendees": { "type": "array", "items": { "type": "string" }, "description": "IDs dos participantes" },
                  "location": { "type": "string", "description": "Local" },
                  "meetingUrl": { "type": "string", "description": "URL da reuniao" },
                  "recurrence": { "type": "object", "properties": { "pattern": { "type": "string", "enum": ["daily", "weekly", "biweekly", "monthly"] }, "endDate": { "type": "number" } } },
                  "notes": { "type": "string", "description": "Notas" }
                }
              }
            }
          }
        },
        "responses": {
          "201": {
            "description": "Evento criado",
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "properties": {
                    "success": { "type": "boolean", "const": true },
                    "eventId": { "type": "string", "description": "ID do evento criado" }
                  }
                }
              }
            }
          },
          "400": { "$ref": "#/components/responses/BadRequest" },
          "401": { "$ref": "#/components/responses/Unauthorized" },
          "403": { "$ref": "#/components/responses/Forbidden" },
          "500": { "$ref": "#/components/responses/InternalError" }
        }
      }
    },
    "/api/v1/calendar/events/update": {
      "post": {
        "tags": ["Calendario"],
        "summary": "Atualizar evento",
        "description": "Atualiza campos de um evento existente. Requer permissão tasks: view_own na chave de API.",
        "operationId": "updateCalendarEvent",
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object",
                "required": ["eventId"],
                "properties": {
                  "eventId": { "type": "string", "description": "ID do evento" },
                  "title": { "type": "string" },
                  "description": { "type": "string" },
                  "eventType": { "type": "string", "enum": ["call", "meeting", "follow_up", "demo", "task", "reminder", "other"] },
                  "startTime": { "type": "number" },
                  "endTime": { "type": "number" },
                  "allDay": { "type": "boolean" },
                  "location": { "type": "string" },
                  "meetingUrl": { "type": "string" },
                  "notes": { "type": "string" }
                }
              }
            }
          }
        },
        "responses": {
          "200": { "$ref": "#/components/responses/Success" },
          "400": { "$ref": "#/components/responses/BadRequest" },
          "401": { "$ref": "#/components/responses/Unauthorized" },
          "403": { "$ref": "#/components/responses/Forbidden" },
          "500": { "$ref": "#/components/responses/InternalError" }
        }
      }
    },
    "/api/v1/calendar/events/delete": {
      "post": {
        "tags": ["Calendario"],
        "summary": "Excluir evento",
        "description": "Remove um evento do calendario. Exclui tambem eventos recorrentes filhos. Requer permissão tasks: view_own na chave de API.",
        "operationId": "deleteCalendarEvent",
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object",
                "required": ["eventId"],
                "properties": {
                  "eventId": { "type": "string", "description": "ID do evento" }
                }
              }
            }
          }
        },
        "responses": {
          "200": { "$ref": "#/components/responses/Success" },
          "400": { "$ref": "#/components/responses/BadRequest" },
          "401": { "$ref": "#/components/responses/Unauthorized" },
          "403": { "$ref": "#/components/responses/Forbidden" },
          "500": { "$ref": "#/components/responses/InternalError" }
        }
      }
    },
    "/api/v1/calendar/events/reschedule": {
      "post": {
        "tags": ["Calendario"],
        "summary": "Reagendar evento",
        "description": "Reagenda um evento para novo horario. Se newEndTime nao for fornecido, a duracao original e mantida. Requer permissão tasks: view_own na chave de API.",
        "operationId": "rescheduleCalendarEvent",
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object",
                "required": ["eventId", "newStartTime"],
                "properties": {
                  "eventId": { "type": "string", "description": "ID do evento" },
                  "newStartTime": { "type": "number", "description": "Novo inicio (timestamp ms)" },
                  "newEndTime": { "type": "number", "description": "Novo fim (timestamp ms, opcional)" }
                }
              }
            }
          }
        },
        "responses": {
          "200": { "$ref": "#/components/responses/Success" },
          "400": { "$ref": "#/components/responses/BadRequest" },
          "401": { "$ref": "#/components/responses/Unauthorized" },
          "403": { "$ref": "#/components/responses/Forbidden" },
          "500": { "$ref": "#/components/responses/InternalError" }
        }
      }
    },
    "/api/v1/calendar/events/complete": {
      "post": {
        "tags": ["Calendario"],
        "summary": "Concluir evento",
        "description": "Marca um evento como concluido. Se o evento tiver recorrencia, gera automaticamente a proxima instancia. Requer permissão tasks: view_own na chave de API.",
        "operationId": "completeCalendarEvent",
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object",
                "required": ["eventId"],
                "properties": {
                  "eventId": { "type": "string", "description": "ID do evento" }
                }
              }
            }
          }
        },
        "responses": {
          "200": { "$ref": "#/components/responses/Success" },
          "400": { "$ref": "#/components/responses/BadRequest" },
          "401": { "$ref": "#/components/responses/Unauthorized" },
          "403": { "$ref": "#/components/responses/Forbidden" },
          "500": { "$ref": "#/components/responses/InternalError" }
        }
      }
    },
    "/api/v1/exports": {
      "post": {
        "tags": ["Dados"],
        "summary": "Criar exportação",
        "description": "Cria um job assíncrono de exportação e o coloca na fila. Combinações válidas: scope=entity exige format=csv e entity; scope=full_backup exige format=json. Só um job de exportação ativo por organização. Requer settings: manage.",
        "operationId": "createExportJob",
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object",
                "required": ["format", "scope"],
                "properties": {
                  "format": { "type": "string", "enum": ["csv", "json"], "description": "csv para exportação por entidade, json para backup completo" },
                  "scope": { "type": "string", "enum": ["entity", "full_backup"], "description": "entity = uma tabela em CSV; full_backup = backup JSON da organização" },
                  "entity": { "type": "string", "enum": ["contacts", "leads", "tasks"], "description": "Obrigatório quando scope=entity" },
                  "columns": { "type": "array", "items": { "type": "string" }, "description": "Subconjunto de colunas do CSV (opcional; padrão = todas)" }
                }
              }
            }
          }
        },
        "responses": {
          "201": {
            "description": "Job criado e enfileirado",
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "properties": {
                    "success": { "type": "boolean", "const": true },
                    "jobId": { "type": "string", "description": "ID do job de exportação" }
                  }
                }
              }
            }
          },
          "400": { "$ref": "#/components/responses/BadRequest" },
          "401": { "$ref": "#/components/responses/Unauthorized" },
          "403": { "$ref": "#/components/responses/Forbidden" },
          "500": { "$ref": "#/components/responses/InternalError" }
        }
      },
      "get": {
        "tags": ["Dados"],
        "summary": "Listar exportações",
        "description": "Últimos 20 jobs de exportação da organização, do mais recente para o mais antigo. Requer settings: manage.",
        "operationId": "listExportJobs",
        "responses": {
          "200": {
            "description": "Lista de jobs",
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "properties": {
                    "jobs": { "type": "array", "items": { "$ref": "#/components/schemas/ExportJob" } }
                  }
                }
              }
            }
          },
          "401": { "$ref": "#/components/responses/Unauthorized" },
          "403": { "$ref": "#/components/responses/Forbidden" },
          "500": { "$ref": "#/components/responses/InternalError" }
        }
      }
    },
    "/api/v1/exports/get": {
      "get": {
        "tags": ["Dados"],
        "summary": "Consultar exportação",
        "description": "Estado de um job de exportação (use para acompanhar progress.processed até status=completed). Requer settings: manage.",
        "operationId": "getExportJob",
        "parameters": [
          { "name": "id", "in": "query", "required": true, "schema": { "type": "string" }, "description": "ID do job de exportação" }
        ],
        "responses": {
          "200": {
            "description": "Job encontrado",
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "properties": { "job": { "$ref": "#/components/schemas/ExportJob" } }
                }
              }
            }
          },
          "400": { "$ref": "#/components/responses/BadRequest" },
          "401": { "$ref": "#/components/responses/Unauthorized" },
          "403": { "$ref": "#/components/responses/Forbidden" },
          "404": { "$ref": "#/components/responses/NotFound" },
          "500": { "$ref": "#/components/responses/InternalError" }
        }
      }
    },
    "/api/v1/exports/download": {
      "get": {
        "tags": ["Dados"],
        "summary": "Baixar arquivo da exportação",
        "description": "Devolve o arquivo gerado como anexo (Content-Disposition: attachment). Só funciona com status=completed e antes de expiresAt (7 dias); depois disso o blob é apagado pelo cron e a rota responde 404. Requer settings: manage.",
        "operationId": "downloadExportJob",
        "parameters": [
          { "name": "id", "in": "query", "required": true, "schema": { "type": "string" }, "description": "ID do job de exportação" }
        ],
        "responses": {
          "200": {
            "description": "Arquivo da exportação",
            "headers": {
              "Content-Disposition": { "schema": { "type": "string" }, "description": "attachment; filename=\\"hnbcrm-contatos-2026-08-23.csv\\"" }
            },
            "content": {
              "text/csv": { "schema": { "type": "string" } },
              "application/json": { "schema": { "type": "string" } }
            }
          },
          "400": { "$ref": "#/components/responses/BadRequest" },
          "401": { "$ref": "#/components/responses/Unauthorized" },
          "403": { "$ref": "#/components/responses/Forbidden" },
          "404": { "$ref": "#/components/responses/NotFound" },
          "500": { "$ref": "#/components/responses/InternalError" }
        }
      }
    },
    "/api/v1/imports": {
      "post": {
        "tags": ["Dados"],
        "summary": "Criar importação",
        "description": "Cria um job de importação de CSV e dispara a detecção de cabeçalhos (status inicial mapping). Envie o conteúdo em csv (máx. 5 MB no corpo) OU o fileId de um upload prévio via /api/v1/files (fileType import_file, máx. 10 MB). Só um job de importação ativo por organização. Requer settings: manage.",
        "operationId": "createImportJob",
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object",
                "required": ["entity", "duplicateStrategy", "fileName"],
                "properties": {
                  "entity": { "type": "string", "enum": ["contacts", "leads"], "description": "Entidade de destino" },
                  "duplicateStrategy": { "type": "string", "enum": ["skip", "update", "create"], "description": "O que fazer quando o contato já existe (match por email, depois telefone)" },
                  "fileName": { "type": "string", "description": "Nome do arquivo (aparece no histórico)" },
                  "csv": { "type": "string", "description": "Conteúdo do CSV embutido (máx. 5 MB). Alternativa a fileId" },
                  "fileId": { "type": "string", "description": "ID de um arquivo já salvo via /api/v1/files. Alternativa a csv" }
                }
              }
            }
          }
        },
        "responses": {
          "201": {
            "description": "Job criado; a detecção de cabeçalhos roda em segundo plano",
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "properties": {
                    "success": { "type": "boolean", "const": true },
                    "jobId": { "type": "string", "description": "ID do job de importação" },
                    "fileId": { "type": "string", "description": "ID do arquivo (o criado a partir do csv embutido, ou o informado)" }
                  }
                }
              }
            }
          },
          "400": { "$ref": "#/components/responses/BadRequest" },
          "401": { "$ref": "#/components/responses/Unauthorized" },
          "403": { "$ref": "#/components/responses/Forbidden" },
          "500": { "$ref": "#/components/responses/InternalError" }
        }
      },
      "get": {
        "tags": ["Dados"],
        "summary": "Listar importações",
        "description": "Últimos 20 jobs de importação da organização. Requer settings: manage.",
        "operationId": "listImportJobs",
        "responses": {
          "200": {
            "description": "Lista de jobs",
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "properties": {
                    "jobs": { "type": "array", "items": { "$ref": "#/components/schemas/ImportJob" } }
                  }
                }
              }
            }
          },
          "401": { "$ref": "#/components/responses/Unauthorized" },
          "403": { "$ref": "#/components/responses/Forbidden" },
          "500": { "$ref": "#/components/responses/InternalError" }
        }
      }
    },
    "/api/v1/imports/get": {
      "get": {
        "tags": ["Dados"],
        "summary": "Consultar importação",
        "description": "Estado de um job de importação, incluindo detectedHeaders, suggestedMapping, mapping, dryRun e progress. Requer settings: manage.",
        "operationId": "getImportJob",
        "parameters": [
          { "name": "id", "in": "query", "required": true, "schema": { "type": "string" }, "description": "ID do job de importação" }
        ],
        "responses": {
          "200": {
            "description": "Job encontrado",
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "properties": { "job": { "$ref": "#/components/schemas/ImportJob" } }
                }
              }
            }
          },
          "400": { "$ref": "#/components/responses/BadRequest" },
          "401": { "$ref": "#/components/responses/Unauthorized" },
          "403": { "$ref": "#/components/responses/Forbidden" },
          "404": { "$ref": "#/components/responses/NotFound" },
          "500": { "$ref": "#/components/responses/InternalError" }
        }
      }
    },
    "/api/v1/imports/mapping": {
      "post": {
        "tags": ["Dados"],
        "summary": "Definir mapeamento",
        "description": "Define o mapeamento coluna do arquivo → campo do CRM. As chaves são os CABEÇALHOS CRUS do arquivo. Valores: nome do campo (firstName, email, title, boardName, ...), cf:<chave> para campo personalizado, ou __ignore__ para ignorar a coluna. Alterar o mapeamento invalida o dry-run anterior. Só antes da execução. Requer settings: manage.",
        "operationId": "updateImportMapping",
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object",
                "required": ["jobId", "mapping"],
                "properties": {
                  "jobId": { "type": "string", "description": "ID do job de importação" },
                  "mapping": { "type": "object", "additionalProperties": { "type": "string" }, "description": "Objeto { \\"Cabeçalho do arquivo\\": \\"campo\\" }", "example": { "Nome": "firstName", "E-mail": "email", "Observações": "__ignore__" } }
                }
              }
            }
          }
        },
        "responses": {
          "200": { "$ref": "#/components/responses/Success" },
          "400": { "$ref": "#/components/responses/BadRequest" },
          "401": { "$ref": "#/components/responses/Unauthorized" },
          "403": { "$ref": "#/components/responses/Forbidden" },
          "404": { "$ref": "#/components/responses/NotFound" },
          "500": { "$ref": "#/components/responses/InternalError" }
        }
      }
    },
    "/api/v1/imports/preview": {
      "post": {
        "tags": ["Dados"],
        "summary": "Rodar dry-run",
        "description": "Enfileira o dry-run (status previewing). Quando terminar, o job fica em preview_ready com o resumo em dryRun — consulte por /api/v1/imports/get. Requer settings: manage.",
        "operationId": "runImportPreview",
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object",
                "required": ["jobId"],
                "properties": { "jobId": { "type": "string", "description": "ID do job de importação" } }
              }
            }
          }
        },
        "responses": {
          "200": { "$ref": "#/components/responses/Success" },
          "400": { "$ref": "#/components/responses/BadRequest" },
          "401": { "$ref": "#/components/responses/Unauthorized" },
          "403": { "$ref": "#/components/responses/Forbidden" },
          "404": { "$ref": "#/components/responses/NotFound" },
          "500": { "$ref": "#/components/responses/InternalError" }
        }
      }
    },
    "/api/v1/imports/confirm": {
      "post": {
        "tags": ["Dados"],
        "summary": "Confirmar importação",
        "description": "Executa a importação de verdade, em lotes de 50 linhas (status running → completed | completed_with_errors). Só a partir de preview_ready e com pelo menos uma linha válida. Requer settings: manage.",
        "operationId": "confirmImport",
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object",
                "required": ["jobId"],
                "properties": { "jobId": { "type": "string", "description": "ID do job de importação" } }
              }
            }
          }
        },
        "responses": {
          "200": { "$ref": "#/components/responses/Success" },
          "400": { "$ref": "#/components/responses/BadRequest" },
          "401": { "$ref": "#/components/responses/Unauthorized" },
          "403": { "$ref": "#/components/responses/Forbidden" },
          "404": { "$ref": "#/components/responses/NotFound" },
          "500": { "$ref": "#/components/responses/InternalError" }
        }
      }
    },
    "/api/v1/imports/rollback": {
      "post": {
        "tags": ["Dados"],
        "summary": "Desfazer importação",
        "description": "Apaga os registros criados e reverte os atualizados pela importação (status rolled_back). Só para jobs completed ou completed_with_errors. Efeitos colaterais já disparados (atividades, webhooks) não são revertidos. Requer settings: manage.",
        "operationId": "rollbackImport",
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object",
                "required": ["jobId"],
                "properties": { "jobId": { "type": "string", "description": "ID do job de importação" } }
              }
            }
          }
        },
        "responses": {
          "200": { "$ref": "#/components/responses/Success" },
          "400": { "$ref": "#/components/responses/BadRequest" },
          "401": { "$ref": "#/components/responses/Unauthorized" },
          "403": { "$ref": "#/components/responses/Forbidden" },
          "404": { "$ref": "#/components/responses/NotFound" },
          "500": { "$ref": "#/components/responses/InternalError" }
        }
      }
    },
    "/api/v1/imports/failed-rows": {
      "get": {
        "tags": ["Dados"],
        "summary": "Baixar linhas com erro",
        "description": "CSV com as linhas que falharam (colunas originais + coluna \\"erro\\"), para corrigir e reimportar. Devolve corpo vazio quando não há erros. Requer settings: manage.",
        "operationId": "getImportFailedRows",
        "parameters": [
          { "name": "id", "in": "query", "required": true, "schema": { "type": "string" }, "description": "ID do job de importação" }
        ],
        "responses": {
          "200": {
            "description": "CSV das linhas com erro",
            "headers": {
              "Content-Disposition": { "schema": { "type": "string" }, "description": "attachment; filename=\\"erros-contatos.csv\\"" }
            },
            "content": { "text/csv": { "schema": { "type": "string" } } }
          },
          "400": { "$ref": "#/components/responses/BadRequest" },
          "401": { "$ref": "#/components/responses/Unauthorized" },
          "403": { "$ref": "#/components/responses/Forbidden" },
          "404": { "$ref": "#/components/responses/NotFound" },
          "500": { "$ref": "#/components/responses/InternalError" }
        }
      }
    }
  },
  "components": {
    "securitySchemes": {
      "ApiKeyAuth": {
        "type": "apiKey",
        "in": "header",
        "name": "X-API-Key",
        "description": "Chave de API vinculada a um membro da equipe e organização. A chave é armazenada como hash SHA-256. As permissões efetivas são resolvidas na ordem chave > membro > padrão do papel e conferidas em toda rota /api/v1 (403 quando insuficientes). Rate limit: 300 requisições por minuto por chave (429 ao exceder)."
      }
    },
    "schemas": {
      "Lead": {
        "type": "object",
        "properties": {
          "_id": { "type": "string", "description": "ID único do lead" },
          "_creationTime": { "type": "number", "description": "Timestamp de criação" },
          "organizationId": { "type": "string", "description": "ID da organização" },
          "title": { "type": "string", "description": "Título do lead" },
          "contactId": { "type": "string", "description": "ID do contato associado" },
          "boardId": { "type": "string", "description": "ID do board (pipeline)" },
          "stageId": { "type": "string", "description": "ID do estágio atual" },
          "assignedTo": { "type": "string", "description": "ID do membro responsável" },
          "value": { "type": "number", "description": "Valor monetário" },
          "currency": { "type": "string", "description": "Código da moeda" },
          "priority": { "type": "string", "enum": ["low", "medium", "high", "urgent"], "description": "Prioridade" },
          "temperature": { "type": "string", "enum": ["cold", "warm", "hot"], "description": "Temperatura" },
          "sourceId": { "type": "string", "description": "ID da fonte de captação" },
          "tags": { "type": "array", "items": { "type": "string" }, "description": "Tags" },
          "customFields": { "type": "object", "additionalProperties": true, "description": "Campos personalizados" },
          "conversationStatus": { "type": "string", "enum": ["new", "active", "waiting", "closed"], "description": "Status da conversa" },
          "closedAt": { "type": "number", "description": "Timestamp de fechamento" },
          "closedType": { "type": "string", "enum": ["won", "lost"], "description": "Tipo de fechamento" }
        }
      },
      "Contact": {
        "type": "object",
        "properties": {
          "_id": { "type": "string", "description": "ID único do contato" },
          "_creationTime": { "type": "number", "description": "Timestamp de criação" },
          "organizationId": { "type": "string", "description": "ID da organização" },
          "firstName": { "type": "string", "description": "Primeiro nome" },
          "lastName": { "type": "string", "description": "Sobrenome" },
          "email": { "type": "string", "description": "Email" },
          "phone": { "type": "string", "description": "Telefone" },
          "company": { "type": "string", "description": "Empresa" },
          "title": { "type": "string", "description": "Cargo" },
          "tags": { "type": "array", "items": { "type": "string" }, "description": "Tags" },
          "city": { "type": "string", "description": "Cidade" },
          "state": { "type": "string", "description": "Estado" },
          "country": { "type": "string", "description": "País" },
          "industry": { "type": "string", "description": "Indústria" },
          "customFields": { "type": "object", "additionalProperties": true, "description": "Campos personalizados" }
        }
      },
      "Conversation": {
        "type": "object",
        "properties": {
          "_id": { "type": "string", "description": "ID único da conversa" },
          "_creationTime": { "type": "number", "description": "Timestamp de criação" },
          "organizationId": { "type": "string", "description": "ID da organização" },
          "leadId": { "type": "string", "description": "ID do lead associado" },
          "channel": { "type": "string", "enum": ["whatsapp", "telegram", "email", "webchat", "internal"], "description": "Canal da conversa" },
          "status": { "type": "string", "enum": ["active", "closed"], "description": "Status da conversa" },
          "messageCount": { "type": "integer", "description": "Total de mensagens" }
        }
      },
      "Message": {
        "type": "object",
        "properties": {
          "_id": { "type": "string", "description": "ID único da mensagem" },
          "_creationTime": { "type": "number", "description": "Timestamp de criação" },
          "conversationId": { "type": "string", "description": "ID da conversa" },
          "leadId": { "type": "string", "description": "ID do lead" },
          "direction": { "type": "string", "enum": ["inbound", "outbound", "internal"], "description": "Direção da mensagem" },
          "senderId": { "type": "string", "description": "ID do remetente" },
          "senderType": { "type": "string", "enum": ["contact", "human", "ai"], "description": "Tipo do remetente" },
          "content": { "type": "string", "description": "Conteúdo da mensagem" },
          "contentType": { "type": "string", "enum": ["text", "image", "file", "audio"], "description": "Tipo do conteúdo" },
          "isInternal": { "type": "boolean", "description": "Nota interna" }
        }
      },
      "Handoff": {
        "type": "object",
        "properties": {
          "_id": { "type": "string", "description": "ID único do handoff" },
          "_creationTime": { "type": "number", "description": "Timestamp de criação" },
          "organizationId": { "type": "string", "description": "ID da organização" },
          "leadId": { "type": "string", "description": "ID do lead" },
          "conversationId": { "type": "string", "nullable": true, "description": "ID da conversa de origem (nulo quando não pôde ser resolvida)" },
          "fromMemberId": { "type": "string", "description": "ID do membro solicitante" },
          "toMemberId": { "type": "string", "description": "ID do membro destino" },
          "reason": { "type": "string", "description": "Motivo do handoff" },
          "summary": { "type": "string", "description": "Resumo da conversa" },
          "suggestedActions": { "type": "array", "items": { "type": "string" }, "description": "Ações sugeridas" },
          "status": { "type": "string", "enum": ["pending", "accepted", "rejected", "canceled"], "description": "Status do handoff" }
        }
      },
      "Board": {
        "type": "object",
        "properties": {
          "_id": { "type": "string", "description": "ID único do board" },
          "_creationTime": { "type": "number", "description": "Timestamp de criação" },
          "organizationId": { "type": "string", "description": "ID da organização" },
          "name": { "type": "string", "description": "Nome do board" },
          "description": { "type": "string", "description": "Descrição" },
          "color": { "type": "string", "description": "Cor de exibição" },
          "isDefault": { "type": "boolean", "description": "Se é o board padrão para novos leads" },
          "order": { "type": "integer", "description": "Ordem de exibição" }
        }
      },
      "Stage": {
        "type": "object",
        "properties": {
          "_id": { "type": "string", "description": "ID único do estágio" },
          "_creationTime": { "type": "number", "description": "Timestamp de criação" },
          "boardId": { "type": "string", "description": "ID do board pai" },
          "name": { "type": "string", "description": "Nome do estágio" },
          "color": { "type": "string", "description": "Cor de exibição" },
          "order": { "type": "integer", "description": "Ordem de exibição" },
          "isClosedWon": { "type": "boolean", "description": "Marca como estágio de ganho" },
          "isClosedLost": { "type": "boolean", "description": "Marca como estágio de perda" }
        }
      },
      "TeamMember": {
        "type": "object",
        "properties": {
          "_id": { "type": "string", "description": "ID único do membro" },
          "_creationTime": { "type": "number", "description": "Timestamp de criação" },
          "organizationId": { "type": "string", "description": "ID da organização" },
          "name": { "type": "string", "description": "Nome de exibição" },
          "email": { "type": "string", "description": "Email (humanos)" },
          "role": { "type": "string", "enum": ["admin", "manager", "agent", "ai"], "description": "Papel na equipe" },
          "type": { "type": "string", "enum": ["human", "ai"], "description": "Tipo de membro" },
          "status": { "type": "string", "enum": ["active", "inactive", "busy"], "description": "Status atual" },
          "capabilities": { "type": "array", "items": { "type": "string" }, "description": "Capacidades do membro" },
          "permissions": { "type": "object", "nullable": true, "description": "Permissões RBAC granulares (9 categorias). Null = usar padrões do papel" },
          "mustChangePassword": { "type": "boolean", "description": "Força troca de senha no próximo login" },
          "invitedBy": { "type": "string", "nullable": true, "description": "ID do membro que convidou" }
        }
      },
      "FieldDefinition": {
        "type": "object",
        "properties": {
          "_id": { "type": "string", "description": "ID único da definição" },
          "_creationTime": { "type": "number", "description": "Timestamp de criação" },
          "organizationId": { "type": "string", "description": "ID da organização" },
          "name": { "type": "string", "description": "Nome de exibição" },
          "key": { "type": "string", "description": "Chave única para armazenamento" },
          "type": { "type": "string", "enum": ["text", "number", "boolean", "date", "select", "multiselect"], "description": "Tipo do campo" },
          "entityType": { "type": "string", "enum": ["lead", "contact"], "description": "Tipo de entidade (null = ambos)" },
          "options": { "type": "array", "items": { "type": "string" }, "description": "Opções para select/multiselect" },
          "isRequired": { "type": "boolean", "description": "Se o campo é obrigatório" },
          "order": { "type": "integer", "description": "Ordem de exibição" }
        }
      },
      "Activity": {
        "type": "object",
        "properties": {
          "_id": { "type": "string", "description": "ID único da atividade" },
          "_creationTime": { "type": "number", "description": "Timestamp de criação" },
          "organizationId": { "type": "string", "description": "ID da organização" },
          "leadId": { "type": "string", "description": "ID do lead" },
          "type": { "type": "string", "description": "Tipo da atividade" },
          "actorId": { "type": "string", "description": "ID do ator" },
          "actorType": { "type": "string", "enum": ["human", "ai", "system"], "description": "Tipo do ator" },
          "content": { "type": "string", "description": "Conteúdo da atividade" },
          "metadata": { "type": "object", "additionalProperties": true, "description": "Metadados adicionais" },
          "createdAt": { "type": "number", "description": "Timestamp de criação" }
        }
      },
      "LeadSource": {
        "type": "object",
        "properties": {
          "_id": { "type": "string", "description": "ID único da fonte" },
          "_creationTime": { "type": "number", "description": "Timestamp de criação" },
          "organizationId": { "type": "string", "description": "ID da organização" },
          "name": { "type": "string", "description": "Nome da fonte" },
          "type": { "type": "string", "enum": ["website", "social", "email", "phone", "referral", "api", "other"], "description": "Tipo da fonte" },
          "isActive": { "type": "boolean", "description": "Se está ativa" }
        }
      },
      "Task": {
        "type": "object",
        "properties": {
          "_id": { "type": "string", "description": "ID único da tarefa" },
          "_creationTime": { "type": "number", "description": "Timestamp de criação" },
          "organizationId": { "type": "string", "description": "ID da organização" },
          "title": { "type": "string", "description": "Título da tarefa" },
          "description": { "type": "string", "description": "Descrição detalhada" },
          "type": { "type": "string", "enum": ["task", "reminder"], "description": "Tipo" },
          "status": { "type": "string", "enum": ["pending", "in_progress", "completed", "cancelled"], "description": "Status" },
          "priority": { "type": "string", "enum": ["low", "medium", "high", "urgent"], "description": "Prioridade" },
          "activityType": { "type": "string", "enum": ["todo", "call", "email", "follow_up", "meeting", "research"], "description": "Tipo de atividade CRM" },
          "dueDate": { "type": "number", "description": "Data de vencimento (timestamp ms)" },
          "completedAt": { "type": "number", "description": "Timestamp de conclusão" },
          "snoozedUntil": { "type": "number", "description": "Adiada até (timestamp ms)" },
          "leadId": { "type": "string", "description": "ID do lead associado" },
          "contactId": { "type": "string", "description": "ID do contato associado" },
          "assignedTo": { "type": "string", "description": "ID do membro responsável (sempre = assigneeIds[0])" },
          "assigneeIds": { "type": "array", "items": { "type": "string" }, "description": "IDs de todos os responsáveis, humanos ou IA" },
          "createdBy": { "type": "string", "description": "ID do criador" },
          "recurrence": {
            "type": "object",
            "properties": {
              "pattern": { "type": "string", "enum": ["daily", "weekly", "biweekly", "monthly"] },
              "endDate": { "type": "number" }
            }
          },
          "recurrenceSourceId": { "type": "string", "description": "Instância anterior na cadeia de recorrência (linhagem)" },
          "parentTaskId": { "type": "string", "description": "Tarefa pai — hierarquia de subtarefas" },
          "blockedBy": { "type": "array", "items": { "type": "string" }, "description": "IDs de tarefas bloqueadoras — apenas informativo, não bloqueia conclusão" },
          "projectId": { "type": "string", "description": "ID do projeto/lista de tarefas" },
          "columnId": { "type": "string", "description": "ID da coluna do kanban dentro do projeto" },
          "order": { "type": "number", "description": "Posição manual dentro da coluna" },
          "labelIds": { "type": "array", "items": { "type": "string" }, "description": "IDs das etiquetas com cor" },
          "reminderMinutesBefore": { "type": "number", "description": "Minutos antes do vencimento para disparar lembrete antecipado" },
          "preDueReminderSentAt": { "type": "number", "description": "Timestamp em que o lembrete antecipado foi enviado (uso interno)" },
          "checklist": { "type": "array", "items": { "type": "object", "properties": { "id": { "type": "string" }, "title": { "type": "string" }, "completed": { "type": "boolean" } } } },
          "tags": { "type": "array", "items": { "type": "string" }, "description": "Tags" }
        }
      },
      "TaskComment": {
        "type": "object",
        "properties": {
          "_id": { "type": "string", "description": "ID único do comentário" },
          "_creationTime": { "type": "number", "description": "Timestamp de criação" },
          "organizationId": { "type": "string", "description": "ID da organização" },
          "taskId": { "type": "string", "description": "ID da tarefa" },
          "authorId": { "type": "string", "description": "ID do autor" },
          "authorType": { "type": "string", "enum": ["human", "ai"], "description": "Tipo do autor" },
          "content": { "type": "string", "description": "Conteúdo do comentário" },
          "mentionedUserIds": { "type": "array", "items": { "type": "string" }, "description": "IDs mencionados" }
        }
      },
      "CalendarEvent": {
        "type": "object",
        "properties": {
          "_id": { "type": "string", "description": "ID unico do evento" },
          "_creationTime": { "type": "number", "description": "Timestamp de criacao" },
          "organizationId": { "type": "string", "description": "ID da organizacao" },
          "title": { "type": "string", "description": "Titulo do evento" },
          "description": { "type": "string", "description": "Descricao" },
          "eventType": { "type": "string", "enum": ["call", "meeting", "follow_up", "demo", "task", "reminder", "other"], "description": "Tipo do evento" },
          "startTime": { "type": "number", "description": "Inicio (timestamp ms)" },
          "endTime": { "type": "number", "description": "Fim (timestamp ms)" },
          "allDay": { "type": "boolean", "description": "Evento de dia inteiro" },
          "status": { "type": "string", "enum": ["scheduled", "completed", "cancelled"], "description": "Status do evento" },
          "leadId": { "type": "string", "description": "ID do lead associado" },
          "contactId": { "type": "string", "description": "ID do contato associado" },
          "taskId": { "type": "string", "description": "ID da tarefa vinculada" },
          "attendees": { "type": "array", "items": { "type": "string" }, "description": "IDs dos participantes" },
          "createdBy": { "type": "string", "description": "ID do criador" },
          "assignedTo": { "type": "string", "description": "ID do responsavel" },
          "location": { "type": "string", "description": "Local" },
          "meetingUrl": { "type": "string", "description": "URL da reuniao" },
          "color": { "type": "string", "description": "Cor customizada" },
          "recurrence": { "type": "object", "properties": { "pattern": { "type": "string", "enum": ["daily", "weekly", "biweekly", "monthly"] }, "endDate": { "type": "number" } } },
          "parentEventId": { "type": "string", "description": "ID do evento pai (recorrencia)" },
          "notes": { "type": "string", "description": "Notas adicionais" },
          "createdAt": { "type": "number", "description": "Timestamp de criacao" },
          "updatedAt": { "type": "number", "description": "Timestamp de atualizacao" }
        }
      },
      "AuditLog": {
        "type": "object",
        "properties": {
          "_id": { "type": "string", "description": "ID único do log" },
          "_creationTime": { "type": "number", "description": "Timestamp de criação" },
          "organizationId": { "type": "string", "description": "ID da organização" },
          "entityType": { "type": "string", "description": "Tipo da entidade (ex: lead, contact)" },
          "entityId": { "type": "string", "description": "ID da entidade" },
          "action": { "type": "string", "enum": ["create", "update", "delete", "move", "assign", "handoff"], "description": "Ação realizada" },
          "actorId": { "type": "string", "description": "ID do ator" },
          "actorType": { "type": "string", "enum": ["human", "ai", "system"], "description": "Tipo do ator" },
          "changes": {
            "type": "object",
            "properties": {
              "before": { "type": "object", "additionalProperties": true, "description": "Estado anterior" },
              "after": { "type": "object", "additionalProperties": true, "description": "Estado posterior" }
            },
            "description": "Alterações realizadas"
          },
          "description": { "type": "string", "description": "Descrição legível da ação" },
          "severity": { "type": "string", "enum": ["low", "medium", "high", "critical"], "description": "Severidade" },
          "createdAt": { "type": "number", "description": "Timestamp de criação" }
        }
      },
      "ExportJob": {
        "type": "object",
        "properties": {
          "_id": { "type": "string", "description": "ID do job" },
          "_creationTime": { "type": "number", "description": "Timestamp de criação" },
          "organizationId": { "type": "string", "description": "ID da organização" },
          "requestedBy": { "type": "string", "description": "Membro que solicitou" },
          "status": { "type": "string", "enum": ["queued", "running", "completed", "failed"], "description": "Estado do job" },
          "format": { "type": "string", "enum": ["csv", "json"], "description": "Formato do arquivo" },
          "scope": { "type": "string", "enum": ["entity", "full_backup"], "description": "Escopo da exportação" },
          "entity": { "type": "string", "enum": ["contacts", "leads", "tasks"], "description": "Entidade exportada (scope=entity)" },
          "columns": { "type": "array", "items": { "type": "string" }, "description": "Colunas escolhidas para o CSV" },
          "progress": {
            "type": "object",
            "properties": {
              "processed": { "type": "number", "description": "Registros já processados" },
              "total": { "type": "number", "description": "Total conhecido (quando disponível)" },
              "currentEntity": { "type": "string", "description": "Tabela sendo lida no momento" }
            }
          },
          "resultFileName": { "type": "string", "description": "Nome do arquivo gerado" },
          "resultSize": { "type": "number", "description": "Tamanho do arquivo em bytes" },
          "rowCount": { "type": "number", "description": "Linhas (CSV) ou documentos (backup) exportados" },
          "error": { "type": "string", "description": "Mensagem de erro quando status=failed" },
          "expiresAt": { "type": "number", "description": "Timestamp em que o arquivo é apagado (7 dias)" },
          "createdAt": { "type": "number", "description": "Timestamp de criação" },
          "startedAt": { "type": "number", "description": "Timestamp de início da execução" },
          "finishedAt": { "type": "number", "description": "Timestamp de término" }
        }
      },
      "ImportJob": {
        "type": "object",
        "properties": {
          "_id": { "type": "string", "description": "ID do job" },
          "_creationTime": { "type": "number", "description": "Timestamp de criação" },
          "organizationId": { "type": "string", "description": "ID da organização" },
          "requestedBy": { "type": "string", "description": "Membro que solicitou" },
          "status": { "type": "string", "enum": ["mapping", "previewing", "preview_ready", "running", "completed", "completed_with_errors", "failed", "rolled_back", "canceled"], "description": "Estado do wizard" },
          "entity": { "type": "string", "enum": ["contacts", "leads"], "description": "Entidade de destino" },
          "fileId": { "type": "string", "description": "Arquivo CSV de origem (tabela files)" },
          "fileName": { "type": "string", "description": "Nome do arquivo" },
          "detectedHeaders": { "type": "array", "items": { "type": "string" }, "description": "Cabeçalhos detectados no arquivo, na ordem original" },
          "suggestedMapping": { "type": "object", "additionalProperties": { "type": "string" }, "description": "Mapeamento sugerido — chaves são os cabeçalhos crus" },
          "mapping": { "type": "object", "additionalProperties": { "type": "string" }, "description": "Mapeamento em uso — chaves são os cabeçalhos crus" },
          "duplicateStrategy": { "type": "string", "enum": ["skip", "update", "create"], "description": "Tratamento de duplicatas" },
          "matchFields": { "type": "array", "items": { "type": "string" }, "description": "Campos usados no match de duplicata (contatos: email, phone)" },
          "dryRun": {
            "type": "object",
            "description": "Resultado da pré-visualização (status preview_ready)",
            "properties": {
              "totalRows": { "type": "number" },
              "validRows": { "type": "number" },
              "errorRows": { "type": "number" },
              "newRows": { "type": "number" },
              "updateRows": { "type": "number" },
              "skipRows": { "type": "number" },
              "sampleErrors": { "type": "array", "description": "Até 50 erros de amostra", "items": { "type": "object", "properties": { "row": { "type": "number" }, "field": { "type": "string" }, "message": { "type": "string" } } } },
              "preview": { "type": "array", "description": "Até 10 linhas já mapeadas", "items": { "type": "object", "additionalProperties": true } }
            }
          },
          "progress": {
            "type": "object",
            "properties": {
              "processed": { "type": "number" },
              "total": { "type": "number" },
              "created": { "type": "number" },
              "updated": { "type": "number" },
              "skipped": { "type": "number" },
              "failed": { "type": "number" }
            }
          },
          "error": { "type": "string", "description": "Mensagem de erro quando status=failed" },
          "createdAt": { "type": "number", "description": "Timestamp de criação" },
          "startedAt": { "type": "number", "description": "Timestamp de início da execução" },
          "finishedAt": { "type": "number", "description": "Timestamp de término" }
        }
      }
    },
    "responses": {
      "Success": {
        "description": "Operação realizada com sucesso",
        "content": {
          "application/json": {
            "schema": {
              "type": "object",
              "properties": {
                "success": { "type": "boolean", "const": true }
              }
            }
          }
        }
      },
      "BadRequest": {
        "description": "Requisição inválida — parâmetros obrigatórios ausentes ou inválidos",
        "content": {
          "application/json": {
            "schema": {
              "type": "object",
              "properties": {
                "error": { "type": "string", "description": "Mensagem de erro" },
                "code": { "type": "integer", "example": 400 }
              }
            }
          }
        }
      },
      "Unauthorized": {
        "description": "Não autorizado — chave de API ausente ou inválida",
        "content": {
          "application/json": {
            "schema": {
              "type": "object",
              "properties": {
                "error": { "type": "string", "description": "Mensagem de erro" },
                "code": { "type": "integer", "example": 401 }
              }
            }
          }
        }
      },
      "Forbidden": {
        "description": "Permissão insuficiente — a chave de API não tem a categoria/nível exigidos pela rota (ver a descrição da operação). Corpo: {\\\"error\\\": \\\"Permissão insuficiente\\\", \\\"code\\\": 403}",
        "content": {
          "application/json": {
            "schema": {
              "type": "object",
              "properties": {
                "error": { "type": "string", "description": "Mensagem de erro" },
                "code": { "type": "integer", "example": 403 }
              }
            }
          }
        }
      },
      "NotFound": {
        "description": "Recurso não encontrado",
        "content": {
          "application/json": {
            "schema": {
              "type": "object",
              "properties": {
                "error": { "type": "string", "description": "Mensagem de erro" },
                "code": { "type": "integer", "example": 404 }
              }
            }
          }
        }
      },
      "InternalError": {
        "description": "Erro interno do servidor",
        "content": {
          "application/json": {
            "schema": {
              "type": "object",
              "properties": {
                "error": { "type": "string", "description": "Mensagem de erro" },
                "code": { "type": "integer", "example": 500 }
              }
            }
          }
        }
      }
    }
  }
}`;
