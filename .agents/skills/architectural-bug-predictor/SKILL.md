---
name: architectural-bug-predictor
description: >-
  Use this skill obligatorily after fixing any bug, before proposing a new
  architecture or feature, or during code reviews/audits in the ArgusBot
  repository to map system topology, predict future production failures, and
  identify structural optimizations.
---

# Architectural Bug Predictor — Análise Sistêmica e Preditiva

Sempre que corrigir um bug, desenhar uma nova feature/arquitetura ou auditar o projeto, adote visão sistêmica (código, runtime, rede, banco de dados, filas, containers e serviços externos) para antecipar falhas antes que virem incidentes em produção.

## 1. Mapeamento Sistêmico e de Dependências (Topologia)

Mapeie o fluxo completo da requisição/dado:
`Cliente -> Rede/Proxy -> Servidor/Runtime -> Serviços/APIs -> Banco de Dados/Cache`

Identifique explicitamente:
- Pontos únicos de falha (SPOF)
- Acoplamento forte entre módulos ou serviços
- Dependências implícitas (ex.: planos Free Tier com hibernação, limites de RAM, cotas de APIs externas, pooler de banco)

## 2. Checklist Preditivo de Bugs Futuros (Análise de Risco)

Antes de finalizar qualquer entrega técnica, avalie ativamente os seguintes cenários:

- **Rede & Comunicação:** Falta de *timeouts*, ausência de *retries* com *exponential backoff*, falta de *circuit breakers*, problemas de CORS, DNS ou limites de payload/conexões simultâneas.
- **Concorrência & Estado:** *Race conditions*, *deadlocks*, falta de idempotência em endpoints críticos ou jobs, estado mantido apenas em memória em ambientes com restart/hibernação.
- **Recursos & Servidor:** Vazamentos de memória (*memory leaks*), *connection pools* esgotados (banco/HTTP), falta de paginação em consultas que crescem ao longo do tempo, bloqueio da *event loop* ou threads principais.
- **Resiliência & Falhas Silenciosas:** Exceções engolidas sem log adequado (`.catch(() => {})` sem observabilidade), falta de validação de contratos/schemas na entrada e saída de serviços, ausência de *graceful shutdown* ou *health checks* reais.

## 3. Caça a Otimizações Conhecidas

Identifique gargalos clássicos e sugira/aplique padrões consolidados para a stack (`Node.js/TypeScript`, `Next.js`, `PostgreSQL/Supabase`, `Python/FastAPI/OpenCV`, `Render`):
- Queries N+1 e falta de índices em colunas filtradas/ordenadas
- Ausência de cache para dados quentes ou recálculo excessivo de snapshots
- Payloads excessivos sem compressão ou limites
- Chamadas síncronas pesadas que deveriam ser assíncronas via fila

## 4. Formato Obrigatório de Resposta

Ao final das entregas técnicas (correções de bugs, propostas de arquitetura ou auditorias), inclua a seção curta e objetiva:

### 🔍 Análise Preditiva & Otimizações Sistêmicas
1. **Riscos Futuros Detectados:** O que pode quebrar com aumento de carga, latência de rede ou falha de serviço vizinho (com severidade: **Alta** / **Média** / **Baixa**).
2. **Otimizações Recomendadas:** Melhorias práticas de performance, segurança ou resiliência aplicáveis agora.
3. **Próximo Passo Prático:** Uma ação imediata que podemos executar para mitigar o risco principal.
