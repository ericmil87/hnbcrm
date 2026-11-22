"""Gera as 5 specs de org de cenário (cenarios/orgs.json). Nomes fictícios. Datas por dayOffset relativo a HOJE (fuso da org)."""
import json, sys, os
D = os.path.dirname(os.path.abspath(__file__))
def wk(days, *shifts):
    return [{"weekday": d, "start": s, "end": e} for d in days for (s, e) in shifts]
SEG_SEX = [1,2,3,4,5]; SEG_SAB = [1,2,3,4,5,6]

PERSONA_BASE = ("Você atende o WhatsApp da {nome}. Fala como alguém da equipe: português do Brasil, simpático, mensagens curtas (2 a 5 linhas), uma pergunta por vez, sem markdown. "
 "Tira dúvidas de valor, endereço e funcionamento usando só o conhecimento abaixo e ajuda a pessoa a marcar horário usando as ferramentas de agenda. "
 "Não diagnostica nem promete resultado. Quando não souber, diga que a equipe responde.")

orgs = {}

# 1. Clínica com salas (caso-guia): 3 salas (uma dupla), 4 profissionais, almoço, modo inteligente, dias com 2 e 1 sala
orgs["clinica"] = {
 "slug": "sim-agenda-clinica", "name": "Clínica Sakura",
 "persona": PERSONA_BASE.format(nome="Clínica Sakura (terapias orientais)") + " Atendimento sempre com hora marcada; quem confirma o horário é a equipe da clínica.",
 "knowledge": "Clínica Sakura. Massoterapia e acupuntura. Sessão de 50 minutos, R$ 140. Primeira visita pede sinal de 50% pelo Pix (a equipe passa a chave). Endereço: Rua das Flores, 120, centro. Funcionamento: segunda a sábado, 9h às 12h e 14h às 18h (sábado só de manhã). Estacionamento na rua. Trazer roupa confortável.",
 "resources": [
   {"key":"s1","kind":"room","name":"Sala 1","capacity":1,"weekly":wk(SEG_SEX,("09:00","12:00"),("14:00","18:00"))+wk([6],("09:00","12:00"))},
   {"key":"s2","kind":"room","name":"Sala 2","capacity":1,"weekly":wk(SEG_SEX,("09:00","12:00"),("14:00","18:00"))+wk([6],("09:00","12:00"))},
   {"key":"sd","kind":"room","name":"Sala dupla","capacity":2,"weekly":wk(SEG_SEX,("09:00","12:00"),("14:00","18:00"))+wk([6],("09:00","12:00"))},
   {"key":"p1","kind":"person","name":"Terapeuta Ana","capacity":1,"weekly":wk(SEG_SEX,("09:00","12:00"),("14:00","18:00"))+wk([6],("09:00","12:00"))},
   {"key":"p2","kind":"person","name":"Terapeuta Bruno","capacity":1,"weekly":wk(SEG_SEX,("09:00","12:00"),("14:00","18:00"))+wk([6],("09:00","12:00"))},
   {"key":"p3","kind":"person","name":"Terapeuta Carla","capacity":1,"weekly":wk(SEG_SEX,("09:00","12:00"),("14:00","18:00"))+wk([6],("09:00","12:00"))},
   {"key":"p4","kind":"person","name":"Terapeuta Davi","capacity":1,"weekly":wk(SEG_SEX,("09:00","12:00"),("14:00","18:00"))+wk([6],("09:00","12:00"))},
 ],
 "services": [
   {"name":"Massoterapia","durationMin":50,"bufferAfterMin":10,"priceCents":14000,"requirements":[{"role":"Sala","kind":"room"},{"role":"Terapeuta","kind":"person"}]},
   {"name":"Acupuntura","durationMin":50,"bufferAfterMin":10,"priceCents":14000,"requirements":[{"role":"Sala","kind":"room"},{"role":"Terapeuta","kind":"person"}]},
 ],
 "settings": {"gridMinutes":30,"minNoticeMin":120,"maxAdvanceDays":30,"smartMode":"restrict","aiBook":"propose"},
 # dia +2: só Sala 1 e Sala 2 (dupla fechada por equipe incompleta); dia +3: só a Sala 1 aberta (equipe incompleta)
 "exceptions": [
   {"resourceKey":"sd","dayOffset":2,"mode":"closed","reasonCode":"no_staff"},
   {"resourceKey":"sd","dayOffset":3,"mode":"closed","reasonCode":"no_staff"},
   {"resourceKey":"s2","dayOffset":3,"mode":"closed","reasonCode":"no_staff"},
   {"resourceKey":"p3","dayOffset":3,"mode":"closed","reasonCode":"day_off"},
   {"resourceKey":"p4","dayOffset":3,"mode":"closed","reasonCode":"day_off"},
 ],
 # agenda existente no dia +1 para testar "encostado": 10:00 e 15:00 em salas diferentes + sala dupla 11:00 com 1 pessoa
 "appointments": [
   {"service":"Massoterapia","dayOffset":1,"time":"10:00","resourceKeys":["s1","p1"],"name":"Paciente Fictícia 1"},
   {"service":"Acupuntura","dayOffset":1,"time":"15:00","resourceKeys":["s1","p1"],"name":"Paciente Fictícia 2"},
   {"service":"Massoterapia","dayOffset":1,"time":"11:00","resourceKeys":["sd","p2"],"name":"Paciente Fictícia 3"},
 ],
}

# 2. Barbearia: 3 barbeiros, 30/45/60, sábado cheio
barb_week = wk(SEG_SAB, ("09:00","12:00"),("13:00","19:00"))
orgs["barbearia"] = {
 "slug": "sim-agenda-barbearia", "name": "Barbearia Navalha",
 "persona": PERSONA_BASE.format(nome="Barbearia Navalha") + " O cliente pode pedir um barbeiro específico.",
 "knowledge": "Barbearia Navalha. Corte R$ 45 (30 min), Barba R$ 35 (30 min), Corte + barba R$ 70 (60 min), Corte social com degradê R$ 55 (45 min). Barbeiros: Rui, Tato e Léo. Funcionamos de segunda a sábado, das 9h às 19h, com pausa das 12h às 13h. Rua do Comércio, 45. Aceitamos Pix e cartão.",
 "resources": [
   {"key":"rui","kind":"person","name":"Rui","capacity":1,"weekly":barb_week},
   {"key":"tato","kind":"person","name":"Tato","capacity":1,"weekly":barb_week},
   {"key":"leo","kind":"person","name":"Léo","capacity":1,"weekly":barb_week},
 ],
 "services": [
   {"name":"Corte","durationMin":30,"priceCents":4500,"requirements":[{"role":"Barbeiro","kind":"person"}]},
   {"name":"Barba","durationMin":30,"priceCents":3500,"requirements":[{"role":"Barbeiro","kind":"person"}]},
   {"name":"Corte social com degradê","durationMin":45,"priceCents":5500,"requirements":[{"role":"Barbeiro","kind":"person"}]},
   {"name":"Corte e barba","durationMin":60,"priceCents":7000,"requirements":[{"role":"Barbeiro","kind":"person"}]},
 ],
 "settings": {"gridMinutes":15,"minNoticeMin":60,"maxAdvanceDays":30,"smartMode":"rank","aiBook":"propose"},
 "exceptions": [{"resourceKey":"tato","dayOffset":2,"mode":"closed","reasonCode":"day_off"}],
 "appointments": [],  # sábado cheio é preenchido por script (ver fill_saturday.py) depois do seed
}

# 3. Consultório: 2 profissionais, avaliação 30 min x procedimento 90 min, antecedência mínima 4h, um de folga
dent_week = wk(SEG_SEX, ("08:00","12:00"),("14:00","18:00"))
orgs["consultorio"] = {
 "slug": "sim-agenda-consultorio", "name": "Consultório Odonto Lótus",
 "persona": PERSONA_BASE.format(nome="Consultório Odonto Lótus") + " Não faz diagnóstico nem dá orientação clínica.",
 "knowledge": "Consultório Odonto Lótus. Avaliação inicial de 30 minutos (R$ 120). Procedimento (limpeza, restauração, clareamento em consulta) de 90 minutos, valor depois da avaliação. Dra. Helena e Dr. Marcos. Atendemos de segunda a sexta, 8h às 12h e 14h às 18h. Av. Central, 800, sala 12. Convênios: consulte a equipe.",
 "resources": [
   {"key":"helena","kind":"person","name":"Dra. Helena","capacity":1,"weekly":dent_week},
   {"key":"marcos","kind":"person","name":"Dr. Marcos","capacity":1,"weekly":dent_week},
 ],
 "services": [
   {"name":"Avaliação","durationMin":30,"priceCents":12000,"requirements":[{"role":"Dentista","kind":"person"}]},
   {"name":"Procedimento","durationMin":90,"bufferAfterMin":15,"requirements":[{"role":"Dentista","kind":"person"}]},
 ],
 "settings": {"gridMinutes":30,"minNoticeMin":240,"maxAdvanceDays":45,"smartMode":"rank","aiBook":"propose"},
 "exceptions": [{"resourceKey":"marcos","dayOffset":1,"mode":"closed","reasonCode":"day_off"}],
 "appointments": [
   {"service":"Avaliação","dayOffset":1,"time":"09:00","resourceKeys":["helena"],"name":"Paciente Fictício 4"},
   {"service":"Procedimento","dayOffset":2,"time":"14:00","resourceKeys":["helena"],"name":"Paciente Fictício 5"},
 ],
}

# 4. Advogado solo: 60 min, só tardes, sem sábado, antecedência 24h, 14 dias à frente
orgs["advogado"] = {
 "slug": "sim-agenda-advogado", "name": "Dr. Paulo Menezes Advocacia",
 "persona": PERSONA_BASE.format(nome="escritório do Dr. Paulo Menezes (advocacia)") + " Não dá parecer jurídico por mensagem; só agenda a consulta.",
 "knowledge": "Escritório Dr. Paulo Menezes. Consulta jurídica de 60 minutos, R$ 300. Atendimento presencial ou por vídeo. Só à tarde (14h às 18h), de segunda a sexta. Rua Direita, 15, sala 4. Agendamentos com pelo menos 24 horas de antecedência e até 14 dias à frente.",
 "resources": [{"key":"paulo","kind":"person","name":"Dr. Paulo","capacity":1,"weekly":wk(SEG_SEX,("14:00","18:00"))}],
 "services": [{"name":"Consulta jurídica","durationMin":60,"priceCents":30000,"requirements":[{"role":"Advogado","kind":"person"}]}],
 "settings": {"gridMinutes":60,"minNoticeMin":1440,"maxAdvanceDays":14,"smartMode":"rank","aiBook":"propose"},
 "exceptions": [],
 "appointments": [{"service":"Consulta jurídica","dayOffset":3,"time":"15:00","name":"Cliente Fictício 6"}],
}

# 5. Estúdio de pilates: sala com capacidade 4, turmas fixas
pil = lambda days: wk(days, ("07:00","08:00"),("09:00","10:00"),("18:00","19:00"),("19:00","20:00"))
orgs["pilates"] = {
 "slug": "sim-agenda-pilates", "name": "Estúdio Fluir Pilates",
 "persona": PERSONA_BASE.format(nome="Estúdio Fluir Pilates") + " As aulas são em turma, com vagas limitadas.",
 "knowledge": "Estúdio Fluir Pilates. Aula de pilates em grupo de 50 minutos, no máximo 4 pessoas por turma, R$ 60 a aula avulsa. Turmas de segunda a sexta às 7h, 9h, 18h e 19h. Av. das Palmeiras, 300. Traga roupa confortável e meias antiderrapantes. Aula experimental gratuita para quem nunca fez.",
 "resources": [{"key":"studio","kind":"room","name":"Sala de pilates","capacity":4,"weekly":pil(SEG_SEX)}],
 "services": [{"name":"Aula de pilates","durationMin":50,"slotIntervalMin":60,"priceCents":6000,"requirements":[{"role":"Sala","kind":"room","units":1}]}],
 "settings": {"gridMinutes":60,"minNoticeMin":120,"maxAdvanceDays":30,"smartMode":"off","aiBook":"propose"},
 "exceptions": [],
 "appointments": [],
}
ROOT = os.environ.get("AGENDA_SIM_OUT", os.path.abspath(os.path.join(D, "..", "..", "temp", "agenda-sim")))
os.makedirs(os.path.join(ROOT, "cenarios"), exist_ok=True)
json.dump(orgs, open(os.path.join(ROOT, "cenarios", "orgs.json"), "w"), ensure_ascii=False, indent=1)
print("ok", list(orgs))
