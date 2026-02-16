// OpenAPI 3.1.0 specification for the ClawCRM REST API
// Served at /api/v1/openapi.json

export const OPENAPI_SPEC = `{
  "openapi": "3.1.0",
  "info": {
    "title": "ClawCRM API",
    "description": "API REST do ClawCRM — CRM multi-tenant com colaboração entre humanos e agentes de IA. Todos os endpoints requerem autenticação via header X-API-Key.",
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
    { "name": "Fontes", "description": "Fontes de captação de leads" },
    { "name": "Auditoria", "description": "Logs de auditoria" }
  ],
  "paths": {
    "/api/v1/inbound/lead": {
      "post": {
        "tags": ["Leads"],
        "summary": "Criar lead via captura universal",
        "description": "Cria um novo lead com contato e mensagem opcionais. Se o contato não existir, será criado automaticamente. Se uma mensagem for fornecida, uma conversa será criada.",
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
          "500": { "$ref": "#/components/responses/InternalError" }
        }
      }
    },
    "/api/v1/leads": {
      "get": {
        "tags": ["Leads"],
        "summary": "Listar leads",
        "description": "Retorna a lista de leads da organização com filtros opcionais.",
        "operationId": "listLeads",
        "parameters": [
          { "name": "boardId", "in": "query", "schema": { "type": "string" }, "description": "Filtrar por board (pipeline)" },
          { "name": "stageId", "in": "query", "schema": { "type": "string" }, "description": "Filtrar por estágio" },
          { "name": "assignedTo", "in": "query", "schema": { "type": "string" }, "description": "Filtrar por membro responsável" },
          { "name": "limit", "in": "query", "schema": { "type": "integer", "default": 200, "maximum": 500 }, "description": "Limite de resultados" }
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
                    "hasMore": { "type": "boolean", "description": "Indica se há mais resultados" }
                  }
                }
              }
            }
          },
          "401": { "$ref": "#/components/responses/Unauthorized" },
          "500": { "$ref": "#/components/responses/InternalError" }
        }
      }
    },
    "/api/v1/leads/get": {
      "get": {
        "tags": ["Leads"],
        "summary": "Obter lead",
        "description": "Retorna os dados de um lead específico pelo ID.",
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
          "404": { "$ref": "#/components/responses/NotFound" },
          "500": { "$ref": "#/components/responses/InternalError" }
        }
      }
    },
    "/api/v1/leads/update": {
      "post": {
        "tags": ["Leads"],
        "summary": "Atualizar lead",
        "description": "Atualiza os campos de um lead existente.",
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
          "500": { "$ref": "#/components/responses/InternalError" }
        }
      }
    },
    "/api/v1/leads/delete": {
      "post": {
        "tags": ["Leads"],
        "summary": "Excluir lead",
        "description": "Remove um lead permanentemente.",
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
          "500": { "$ref": "#/components/responses/InternalError" }
        }
      }
    },
    "/api/v1/leads/move-stage": {
      "post": {
        "tags": ["Leads"],
        "summary": "Mover lead de estágio",
        "description": "Move um lead para um estágio diferente no pipeline.",
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
          "500": { "$ref": "#/components/responses/InternalError" }
        }
      }
    },
    "/api/v1/leads/assign": {
      "post": {
        "tags": ["Leads"],
        "summary": "Atribuir lead",
        "description": "Atribui ou desatribui um lead a um membro da equipe. Omita assignedTo para desatribuir.",
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
          "500": { "$ref": "#/components/responses/InternalError" }
        }
      }
    },
    "/api/v1/leads/handoff": {
      "post": {
        "tags": ["Leads", "Handoffs"],
        "summary": "Solicitar handoff",
        "description": "Solicita uma transferência (handoff) do lead para outro membro da equipe.",
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
          "500": { "$ref": "#/components/responses/InternalError" }
        }
      }
    },
    "/api/v1/contacts": {
      "get": {
        "tags": ["Contatos"],
        "summary": "Listar contatos",
        "description": "Retorna a lista de contatos da organização.",
        "operationId": "listContacts",
        "parameters": [
          { "name": "limit", "in": "query", "schema": { "type": "integer", "default": 500, "maximum": 500 }, "description": "Limite de resultados" }
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
                    "hasMore": { "type": "boolean", "description": "Indica se há mais resultados" }
                  }
                }
              }
            }
          },
          "401": { "$ref": "#/components/responses/Unauthorized" },
          "500": { "$ref": "#/components/responses/InternalError" }
        }
      }
    },
    "/api/v1/contacts/create": {
      "post": {
        "tags": ["Contatos"],
        "summary": "Criar contato",
        "description": "Cria um novo contato na organização.",
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
          "500": { "$ref": "#/components/responses/InternalError" }
        }
      }
    },
    "/api/v1/contacts/get": {
      "get": {
        "tags": ["Contatos"],
        "summary": "Obter contato",
        "description": "Retorna os dados de um contato específico pelo ID.",
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
          "404": { "$ref": "#/components/responses/NotFound" },
          "500": { "$ref": "#/components/responses/InternalError" }
        }
      }
    },
    "/api/v1/contacts/update": {
      "post": {
        "tags": ["Contatos"],
        "summary": "Atualizar contato",
        "description": "Atualiza os campos de um contato existente.",
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
          "500": { "$ref": "#/components/responses/InternalError" }
        }
      }
    },
    "/api/v1/contacts/enrich": {
      "post": {
        "tags": ["Contatos"],
        "summary": "Enriquecer contato",
        "description": "Enriquece um contato com dados de uma fonte externa. Usado por agentes de IA para adicionar informações descobertas.",
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
          "500": { "$ref": "#/components/responses/InternalError" }
        }
      }
    },
    "/api/v1/contacts/gaps": {
      "get": {
        "tags": ["Contatos"],
        "summary": "Lacunas de enriquecimento",
        "description": "Identifica campos faltantes ou enriquecíveis em um contato.",
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
          "404": { "$ref": "#/components/responses/NotFound" },
          "500": { "$ref": "#/components/responses/InternalError" }
        }
      }
    },
    "/api/v1/contacts/search": {
      "get": {
        "tags": ["Contatos"],
        "summary": "Buscar contatos",
        "description": "Busca contatos por texto (nome, email, empresa, etc).",
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
          "500": { "$ref": "#/components/responses/InternalError" }
        }
      }
    },
    "/api/v1/conversations": {
      "get": {
        "tags": ["Conversas"],
        "summary": "Listar conversas",
        "description": "Retorna a lista de conversas da organização com filtro opcional por lead.",
        "operationId": "listConversations",
        "parameters": [
          { "name": "leadId", "in": "query", "schema": { "type": "string" }, "description": "Filtrar por lead" },
          { "name": "limit", "in": "query", "schema": { "type": "integer", "default": 200, "maximum": 500 }, "description": "Limite de resultados" }
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
                    "hasMore": { "type": "boolean", "description": "Indica se há mais resultados" }
                  }
                }
              }
            }
          },
          "401": { "$ref": "#/components/responses/Unauthorized" },
          "500": { "$ref": "#/components/responses/InternalError" }
        }
      }
    },
    "/api/v1/conversations/messages": {
      "get": {
        "tags": ["Conversas"],
        "summary": "Listar mensagens",
        "description": "Retorna todas as mensagens de uma conversa.",
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
          "500": { "$ref": "#/components/responses/InternalError" }
        }
      }
    },
    "/api/v1/conversations/send": {
      "post": {
        "tags": ["Conversas"],
        "summary": "Enviar mensagem",
        "description": "Envia uma mensagem em uma conversa existente.",
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
          "500": { "$ref": "#/components/responses/InternalError" }
        }
      }
    },
    "/api/v1/handoffs": {
      "get": {
        "tags": ["Handoffs"],
        "summary": "Listar handoffs",
        "description": "Retorna a lista de handoffs da organização com filtro opcional por status.",
        "operationId": "listHandoffs",
        "parameters": [
          { "name": "status", "in": "query", "schema": { "type": "string", "enum": ["pending", "accepted", "rejected"] }, "description": "Filtrar por status" },
          { "name": "limit", "in": "query", "schema": { "type": "integer", "default": 200, "maximum": 500 }, "description": "Limite de resultados" }
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
                    "hasMore": { "type": "boolean", "description": "Indica se há mais resultados" }
                  }
                }
              }
            }
          },
          "401": { "$ref": "#/components/responses/Unauthorized" },
          "500": { "$ref": "#/components/responses/InternalError" }
        }
      }
    },
    "/api/v1/handoffs/pending": {
      "get": {
        "tags": ["Handoffs"],
        "summary": "Listar handoffs pendentes",
        "description": "Atalho para listar apenas handoffs com status pendente.",
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
          "500": { "$ref": "#/components/responses/InternalError" }
        }
      }
    },
    "/api/v1/handoffs/accept": {
      "post": {
        "tags": ["Handoffs"],
        "summary": "Aceitar handoff",
        "description": "Aceita uma solicitação de handoff pendente.",
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
          "500": { "$ref": "#/components/responses/InternalError" }
        }
      }
    },
    "/api/v1/handoffs/reject": {
      "post": {
        "tags": ["Handoffs"],
        "summary": "Rejeitar handoff",
        "description": "Rejeita uma solicitação de handoff pendente.",
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
          "500": { "$ref": "#/components/responses/InternalError" }
        }
      }
    },
    "/api/v1/boards": {
      "get": {
        "tags": ["Referência"],
        "summary": "Listar boards com estágios",
        "description": "Retorna todos os boards (pipelines) da organização com seus estágios.",
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
          "500": { "$ref": "#/components/responses/InternalError" }
        }
      }
    },
    "/api/v1/team-members": {
      "get": {
        "tags": ["Referência"],
        "summary": "Listar membros da equipe",
        "description": "Retorna todos os membros da equipe (humanos e agentes IA).",
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
          "500": { "$ref": "#/components/responses/InternalError" }
        }
      }
    },
    "/api/v1/field-definitions": {
      "get": {
        "tags": ["Referência"],
        "summary": "Listar definições de campos",
        "description": "Retorna as definições de campos personalizados da organização.",
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
          "500": { "$ref": "#/components/responses/InternalError" }
        }
      }
    },
    "/api/v1/activities": {
      "get": {
        "tags": ["Atividades"],
        "summary": "Listar atividades",
        "description": "Retorna as atividades de um lead específico.",
        "operationId": "listActivities",
        "parameters": [
          { "name": "leadId", "in": "query", "required": true, "schema": { "type": "string" }, "description": "ID do lead" },
          { "name": "limit", "in": "query", "schema": { "type": "integer", "default": 50, "maximum": 200 }, "description": "Limite de resultados" }
        ],
        "responses": {
          "200": {
            "description": "Lista de atividades",
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "properties": {
                    "activities": { "type": "array", "items": { "$ref": "#/components/schemas/Activity" } }
                  }
                }
              }
            }
          },
          "400": { "$ref": "#/components/responses/BadRequest" },
          "401": { "$ref": "#/components/responses/Unauthorized" },
          "500": { "$ref": "#/components/responses/InternalError" }
        }
      },
      "post": {
        "tags": ["Atividades"],
        "summary": "Criar atividade",
        "description": "Registra uma nova atividade em um lead.",
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
          "500": { "$ref": "#/components/responses/InternalError" }
        }
      }
    },
    "/api/v1/dashboard": {
      "get": {
        "tags": ["Dashboard"],
        "summary": "Obter estatísticas do dashboard",
        "description": "Retorna métricas agregadas da organização: total de leads, leads do mês, taxa de conversão, valor total e leads por estágio.",
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
          "500": { "$ref": "#/components/responses/InternalError" }
        }
      }
    },
    "/api/v1/lead-sources": {
      "get": {
        "tags": ["Fontes"],
        "summary": "Listar fontes de leads",
        "description": "Retorna todas as fontes de captação de leads da organização.",
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
          "500": { "$ref": "#/components/responses/InternalError" }
        }
      }
    },
    "/api/v1/audit-logs": {
      "get": {
        "tags": ["Auditoria"],
        "summary": "Listar logs de auditoria",
        "description": "Retorna logs de auditoria da organização com filtros e paginação por cursor.",
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
        "description": "Chave de API vinculada a um membro da equipe e organização. A chave é armazenada como hash SHA-256."
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
          "fromMemberId": { "type": "string", "description": "ID do membro solicitante" },
          "toMemberId": { "type": "string", "description": "ID do membro destino" },
          "reason": { "type": "string", "description": "Motivo do handoff" },
          "summary": { "type": "string", "description": "Resumo da conversa" },
          "suggestedActions": { "type": "array", "items": { "type": "string" }, "description": "Ações sugeridas" },
          "status": { "type": "string", "enum": ["pending", "accepted", "rejected"], "description": "Status do handoff" }
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
          "capabilities": { "type": "array", "items": { "type": "string" }, "description": "Capacidades do membro" }
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
