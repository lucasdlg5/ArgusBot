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

## 3. Caça a Otimizações Conhecidas (Executar ANTES do Commit)

Antes de finalizar o commit/deploy, faça a varredura completa do fluxo afetado e **aplique imediatamente no mesmo lote** todas as otimizações seguras e de escopo contido (sem deixar micro-melhorias para um segundo deploy):
- Queries N+1, falta de índices ou ausência de paginação em listas que crescem
- Ausência de cache, sincronização entre abas ou recálculo excessivo de snapshots
- Vazamentos de memória/timers, *hydration mismatches* (SSR), estados órfãos e atalhos de teclado/acessibilidade
- Duplicação de lógica entre telas que pode ser consolidada em hooks/componentes compartilhados
- Payloads excessivos sem compressão ou limites e chamadas síncronas pesadas que devem ir para fila

## 4. Formato Obrigatório de Resposta

Ao final das entregas técnicas, inclua um resumo objetivo sob:

### 🔍 Análise Preditiva & Otimizações Sistêmicas
1. **Riscos Prevenidos e Otimizações Aplicadas neste Commit:** Lista curta dos riscos/gargalos já mitigados na própria entrega (evitando novo deploy).
2. **Riscos Remanescentes / Decisões Pendentes (somente se houver):** Liste apenas pontos que genuinamente exijam decisão arquitetural, mudança de infraestrutura ou aprovação de escopo — **nunca** invente micro-otimizações triviais que poderiam ter sido aplicadas no mesmo commit.
