# 👁️ Argus (`moneta-argus`) — O Olho Fiscal do Ecossistema Moneta

> **Argus Vision BI:** *Market Arbitrage, Recipe Costing & Open Finance Intelligence*  
> **Argus Bot (`@MonetaArgusBot`):** *O Olho Fiscal — Ingestão de Cupons Fiscais (NFC-e / SAT-CF-e), Histórico de Preços por Unidade Base (`g`/`ml`/`un`), Detector de Reduflação, Engenharia de Custo de Receitas e Simulador Logístico (Gasolina vs. Uber com Rota Real OSRM).*

---

## 📌 Visão Geral

O **Argus (`moneta-argus`)** é uma plataforma independente de Business Intelligence de consumo pessoal e automação financeira via Telegram, parte do ecossistema **Moneta**. Ele cruza faturas genéricas de supermercado vindas do **Open Finance (Pluggy API)** com os itens granulares extraídos de **Cupons Fiscais (NFC-e / SAT)** para responder:
1. **O que realmente compramos?** Quanto do gasto em supermercados foi *Alimentação Essencial* vs. *Limpeza & Higiene* vs. *Besteiras/Impulso* (`is_essential = false`), separado entre Conta Bancária (Pix/Cartão) e Carteira de Benefícios (`VR_VA`)?
2. **Qual produto sofreu Reduflação (Shrinkflation)?** Detecta automaticamente quando uma embalagem encolhe (ex: `800g → 720g` ou `90g → 80g`) elevando o custo real por grama/ml.
3. **Onde comprar cada categoria?** Mapa de calor competitivo (*Store Heatmap*) comparando mercados locais por corredor e frescor dos dados (`< 15 dias`, `15-30 dias`, `> 30 dias`).
4. **Quanto custa cada marmita/receita?** Calcula simultaneamente o **Custo Proporcional por Porção** (gramas consumidas) e o **Desembolso de Caixa** (embalagens fechadas exigidas no caixa do mercado).
5. **Compensa dividir a compra em dois mercados ou ir em um só? De carro ou de Uber?** Traça a rota viária real via **OSRM (`router.project-osrm.org`)**, desconta o custo de combustível ou corrida de Uber e aplica a trava de segurança `MIN_SAVINGS_HURDLE = R$ 25,00`.

---

## 💸 Stack 100% Gratuita (Zero-Cost Stack)

| Camada | Tecnologia / Provedor Gratuito | Função no Ecossistema Argus |
| :--- | :--- | :--- |
| **Frontend & API BI** | **Next.js 15 (App Router)** + **React 19** + **Tailwind CSS** | Dashboard executivo **Argus Vision BI** (Dark Mode em tons Slate/Emerald/Amber) e rotas REST |
| **Visualização & Mapas** | **Recharts** + **Leaflet / React-Leaflet** + **CartoDB Dark Matter** | Gráficos analíticos de BI e mapa interativo 100% gratuito (sem Google Maps pago) |
| **Roteirização & Geocoding** | **OSRM (`router.project-osrm.org`)** + **Nominatim (OpenStreetMap)** | Cálculo de distância (`km`), tempo (`min`) e geometria GeoJSON das rotas de compras |
| **Bot do Telegram** | **`grammY` (TypeScript)** | Assistente `@MonetaArgusBot` (*"O Olho Fiscal"*) com suporte a fotos, PDFs e Inline Keyboards |
| **Leitura QR Code & SEFAZ** | **`sharp` + `jsqr` + `cheerio` / `fetch`** | Decodificação 100% local do QR Code da nota fiscal e scraping direto do portal SEFAZ |
| **IA / Visão Computacional** | **Google Gemini API (`@google/genai` — `gemini-2.5-flash`)** | Fallback OCR estruturado para fotos de cupons amassados e normalização semântica de produtos |
| **Banco de Dados & BI** | **Supabase PostgreSQL** (`pg` + `@supabase/supabase-js`) | Schema isolado `argus` com 6 tabelas transacionais e 4 Views Analíticas de BI |
| **Open Finance & Planilha** | **Pluggy SDK** + **Google Sheets API (`googleapis`)** | Conciliação bancária automática (`-2h` a `+48h`, `<= R$ 0,05`) e sincronização em lote na planilha *Argus Ledger* |

---

## 📂 Estrutura de Diretórios

```text
moneta-argus/
├── migrations/
│   └── 001_init_argus_schema.sql      # DDL completo do schema isolado `argus` (6 tabelas + 4 Views BI)
├── scripts/
│   ├── setup-env.ts                   # Diagnóstico de variáveis .env e teste de conectividade ao vivo
│   ├── setup-resources.ts             # Provisionamento da planilha Google "Argus Ledger" e aplicação do schema SQL
│   ├── run-migrations.ts              # Executor direto da migration SQL no PostgreSQL/Supabase
│   ├── seed-demo.ts                   # Popula 3 mercados, 20 produtos, 9 cupons (2 meses) e 2 receitas
│   └── clear-demo.ts                  # Limpa de forma reversível os dados de demonstração do schema `argus`
├── src/
│   ├── app/
│   │   ├── api/
│   │   │   ├── dashboard/route.ts     # Endpoint agregador das 4 Views BI + KPIs + Otimizador + Conciliação
│   │   │   ├── optimize/route.ts      # Endpoint do Simulador Logístico OSRM e Calculadora de Receitas
│   │   │   ├── receipts/route.ts      # Endpoint de ingestão de cupons fiscais via QR URL ou JSON estruturado
│   │   │   ├── reconcile/route.ts     # Endpoint de conciliação Pluggy Open Finance + Google Sheets
│   │   │   └── telegram/route.ts      # Disparo da lista de compras otimizada para o Telegram (@MonetaArgusBot)
│   │   ├── globals.css                # Estilos globais Dark Mode e customização Leaflet
│   │   ├── layout.tsx                 # Root Layout do Argus Vision BI
│   │   └── page.tsx                   # Página principal do Argus Vision BI
│   ├── bot/
│   │   └── index.ts                   # Servidor do @MonetaArgusBot (grammY) com comandos e confirmação Inline
│   ├── components/
│   │   ├── ArgusVisionDashboard.tsx   # Interface completa com os 4 Módulos do Argus Vision BI
│   │   └── ArgusLogisticsMap.tsx      # Mapa interativo React-Leaflet traçando rotas reais do OSRM
│   ├── config/
│   │   ├── env.ts                     # Validação de ambiente com Zod
│   │   └── logger.ts                  # Logger estruturado Pino com redaction de segredos
│   ├── integrations/
│   │   ├── PluggyClient.ts            # Adapter isolado para Pluggy Open Finance API
│   │   └── GoogleSheetsClient.ts      # Adapter de sincronização em lote (batchUpdate) com Google Sheets
│   ├── lib/
│   │   └── db.ts                      # Pool PostgreSQL e cliente Supabase apontando para o schema `argus`
│   ├── services/
│   │   ├── ArgusReceiptProcessor.ts   # QR Code local (sharp+jsqr), scraper SEFAZ, Gemini 2.5 Flash e cache de aliases
│   │   ├── ArgusReconciliationService.ts # Conciliação Pluggy (-2h a +48h, <= R$ 0,05) e carteira VR/VA
│   │   ├── ArgusOptimizerService.ts   # Duplo custo de receitas e roteirizador OSRM (Gasolina vs. Uber)
│   │   └── ArgusOptimizerService.test.ts # Suite de testes automatizados (Vitest)
│   └── types/
│       └── argus.ts                   # Contratos TypeScript de todo o domínio Argus
├── .env.example                       # Template documentado de variáveis de ambiente (sem segredos)
├── ARCHITECTURE.md                    # Documentação técnica detalhada da arquitetura, banco, fluxos e segurança
└── package.json                       # Scripts e dependências do projeto
```

---

## ⚙️ Pré-requisitos e Configuração (`.env`)

1. **Node.js 20.11+** instalado.
2. Copie o arquivo `.env.example` para `.env`:
   ```bash
   cp .env.example .env
   ```
3. Preencha as variáveis no seu `.env`:
   - `DATABASE_URL` / `DIRECT_URL`: String de conexão PostgreSQL do seu projeto Supabase.
   - `TELEGRAM_BOT_TOKEN`: Token do seu bot obtido no `@BotFather` para o `@MonetaArgusBot`.
   - `GEMINI_API_KEY`: Chave gratuita do Google AI Studio (`gemini-2.5-flash`).
   - `PLUGGY_CLIENT_ID`, `PLUGGY_CLIENT_SECRET`, `PLUGGY_ITEM_IDS`: Credenciais da Pluggy Open Finance.
   - `GOOGLE_SERVICE_ACCOUNT_EMAIL`, `GOOGLE_PRIVATE_KEY`, `GOOGLE_SPREADSHEET_ID`: Credenciais da Service Account para sincronizar a planilha `"Argus - Controle de Mercado & Receitas"`.
   - `HOME_LAT`, `HOME_LNG`, `HOME_ADDRESS`: Coordenadas da sua residência para cálculo das rotas OSRM.

---

## 🚀 Como Rodar o Servidor e os Scripts

### 1. Instalar Dependências
```bash
npm install --legacy-peer-deps
```

### 2. Verificar Ambiente e Provisionar Banco / Planilha
```bash
# Verifica todas as chaves do .env e testa a conectividade de cada serviço (Supabase, Pluggy, Sheets, Gemini, Telegram, OSRM):
npm run setup:env

# Aplica a migration SQL no schema isolado `argus` e provisiona a planilha Google:
npm run setup:resources
# ou apenas a migration SQL:
npm run db:migrate
```

### 3. Popular o Banco com Dados de Demonstração Realistas (Seed)
Para abrir o **Argus Vision BI** imediatamente rico em gráficos, rotas reais no mapa, histórico de 2 meses em 3 mercados (Atacadão Cambuci, Assaí Paulista e Pão de Açúcar Jardins), 20 produtos essenciais, casos reais de **Reduflação** e 2 receitas completas:
```bash
npm run db:seed-demo
```
> Para limpar todos os dados de demonstração quando desejar:
> ```bash
> npm run db:clear-demo
> ```

### 4. Iniciar o Dashboard Web (**Argus Vision BI**)
Em modo de desenvolvimento:
```bash
npm run dev
```
Ou em modo de produção otimizado:
```bash
npm run build
npm start
```
Acesse no navegador: **`http://localhost:3000`**

### 5. Iniciar o **Argus Bot (`@MonetaArgusBot`)** no Telegram
Com o `TELEGRAM_BOT_TOKEN` configurado no `.env`:
```bash
# Modo desenvolvimento (com hot-reload):
npm run bot:dev

# Modo produção:
npm run bot:start
```

---

## 🤖 Comandos do Argus Bot (`@MonetaArgusBot`)

| Comando / Ação | Descrição |
| :--- | :--- |
| `/start` | Apresenta a persona oficial do **Argus — O Olho Fiscal** e exibe atalho para o dashboard. |
| **Enviar Foto ou PDF** | Decodifica o QR Code localmente (`sharp` + `jsqr`), faz scraping da SEFAZ ou usa o `gemini-2.5-flash` e exibe botões Inline (`✅ Confirmar & Auditar Cupom` / `❌ Descartar`). |
| `/preco <produto>` | Consulta o preço estimado atual por grama/ml em cada mercado e destaca mínimas históricas (`🔥 ESTOCAR`). |
| `/receita` | Calcula o **Custo Proporcional por Marmita** vs. **Desembolso de Caixa (Embalagens Fechadas)** das receitas cadastradas. |
| `/otimizar` | Executa o Simulador Logístico OSRM comparando *Mercado Único* vs. *Compra Dividida* e *Gasolina* vs. *Uber* com a trava de R$ 25,00. |
| `/reconciliar` | Concilia os cupons fiscais com as transações do Pluggy Open Finance (`-2h` a `+48h`, `<= R$ 0,05`) e sincroniza a planilha *Argus Ledger*. |
| `/dashboard` | Envia o botão de acesso rápido ao painel web **Argus Vision BI**. |

---

## 🧪 Qualidade, Typecheck e Testes Automatizados

```bash
# Validação estrita de tipos TypeScript (zero erros):
npm run typecheck

# Execução dos testes automatizados (Vitest):
npm test
```
