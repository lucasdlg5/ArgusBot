# 👁️ Argus (`@MonetaArgusBot`) — Seu Assistente de Mercado, Receitas e Economia

Olá! O **Argus** é o bot do Telegram do ecossistema **Moneta**, criado para ajudar você a **pagar menos no supermercado, acompanhar preços reais e entender para onde está indo o seu dinheiro** — tudo direto pelo chat, sem planilhas complicadas na mão.

Basta mandar uma foto de cupom fiscal, um vídeo da gôndola do mercado, uma receita ou simplesmente conversar com ele. O Argus lê tudo, organiza os dados e mostra onde vale mais a pena comprar.

---

## ✨ O que o Argus faz por você?

- **🧾 Lê seus cupons fiscais automaticamente:** Envie a foto, PDF ou link da SEFAZ da sua nota fiscal. O bot lê os itens, guarda o histórico de preços por grama/ml/unidade e avisa se algum produto encolheu de tamanho (**reduflação**).
- **🏷️ Coleta preços direto da prateleira ou encarte:** Está no mercado ou viu um panfleto de ofertas? Mande uma foto da gôndola, do flyer ou um vídeo rápido do corredor. O Argus extrai os produtos e preços e mostra o nível de confiabilidade da leitura.
- **🍲 Calcula o custo real das suas receitas:** Descubra quanto custa fazer um prato comprando tudo em um único mercado ou dividindo a compra entre mercados diferentes — já pensando na ordem certa para não estragar itens gelados/perecíveis.
- **🚗 Compara Carro vs. Uber na ida ao mercado:** Simula a rota real pelas ruas e calcula se vale a pena ir a dois mercados para economizar, já descontando o gasto com gasolina ou corrida de Uber.
- **🏦 Concilia com sua conta bancária e planilha:** Cruza os cupons fiscais com suas transações do Open Finance (Pluggy) e mantém sua planilha no Google Sheets atualizada.
- **📊 Painel Web (Argus Vision BI):** Além do Telegram, você pode acompanhar gráficos, mapa de rotas, notas, produtos e receitas em um dashboard web.

---

## 💬 Como usar no Telegram (sem precisar decorar comandos)

Você não precisa usar comandos o tempo todo — pode **enviar mensagens e mídias direto no chat**:

| O que você enviar | O que o Argus faz |
| :--- | :--- |
| **💬 Texto livre** | Responde dúvidas rápidas de forma natural e sugere o comando certo (ex.: *"quanto tá o arroz?"*). |
| **📸 Foto ou PDF de Cupom Fiscal** | Lê o QR Code ou faz leitura por IA da nota, mostra o resumo e pede confirmação para salvar os itens. |
| **🔗 Link da SEFAZ (QR Code)** | Consulta a nota fiscal direto no portal da Fazenda e registra os produtos automaticamente. |
| **🎥 Vídeo do corredor / Foto de gôndola ou panfleto** | Extrai os produtos e preços visíveis, calcula a confiabilidade da leitura e salva no histórico. |
| **🍳 Receita (texto, foto/print ou link)** | Extrai os ingredientes e o modo de preparo, salva a receita e já calcula onde sai mais barato comprar. |

---

## 🤖 Comandos do Bot (`@MonetaArgusBot`)

Se preferir ir direto ao ponto, use os comandos abaixo no chat:

### 🔍 Preços e Coletas
- **`/produto <item>`** *(ou `/preco <item>`)*  
  Mostra o preço atual estimado por embalagem e por unidade (`g`, `ml`, `un`) em cada mercado, além de avisar com **`🔥 MÍNIMA HISTÓRICA (ESTOCAR)`** quando o item está muito barato.  
  *Exemplo:* `/produto arroz` ou `/preco frango`

- **`/loja <Nome do Mercado | Bairro>`**  
  Define ou corrige o nome do mercado da última foto/vídeo de gôndola ou panfleto que você enviou, melhorando a precisão dos dados.  
  *Exemplo:* `/loja Atacadão | Paulista`

- **`/fila`**  
  Mostra o status das fotos e vídeos processados, o que está aguardando reprocessamento automático e os últimos preços coletados de gôndolas e panfletos.

### 🍲 Receitas e Compras
- **`/receita [nome]`**  
  Lista suas receitas cadastradas (ou busca uma específica) com:
  - **Menor preço possível** (dividindo a compra entre mercados);
  - **Melhor mercado único** (comprando tudo em um só lugar);
  - **Custo por porção** e **ordem anti-perecíveis** para fazer as compras.  
  *Exemplo:* `/receita` ou `/receita strogonoff`

- **`/otimizar`**  
  Roda o simulador de compras e compara **Mercado Único vs. Compra Dividida**, levando em conta distância real, tempo de trajeto, **Gasolina vs. Uber** e uma margem mínima de economia para garantir que o deslocamento realmente compense.

### 📊 Finanças, Painel e Segurança
- **`/dashboard`**  
  Envia um resumo rápido direto no Telegram com os gastos do mês, produtos com reduflação detectada, melhores ofertas atuais e o link para o painel web **Argus Vision BI** (quando configurado).

- **`/reconciliar`**  
  Cruza os cupons fiscais salvos com as transações bancárias do Open Finance (Pluggy) e sincroniza os dados na planilha **Argus Ledger** do Google Sheets.

- **`/seguranca`**  
  Exibe o relatório de tentativas de acesso não autorizado bloqueadas pelo bot.

- **`/start`** e **`/ajuda`** *(ou `/help`)*  
  Mostra a apresentação do Argus com botões de acesso rápido para as principais funções.

---

## 🚀 Quer rodar o projeto localmente?

Se você é desenvolvedor e quer subir o bot e o painel web na sua máquina:

### 1. Pré-requisitos
- **Node.js 20.11+** instalado.

### 2. Instalação e configuração
```bash
# Instale as dependências
npm install --legacy-peer-deps

# Crie seu arquivo de configuração a partir do exemplo
cp .env.example .env
```

Preencha no `.env` as chaves que for utilizar (como `DATABASE_URL`, `TELEGRAM_BOT_TOKEN`, `GEMINI_API_KEY`, credenciais do Pluggy, Google Sheets e suas coordenadas `HOME_LAT` / `HOME_LNG`).

### 3. Banco de dados e diagnóstico
```bash
# Testa as variáveis do .env e a conexão com os serviços
npm run setup:env

# Cria as tabelas e views no banco (ou provisiona banco + planilha)
npm run db:migrate
# ou: npm run setup:resources
```

> **Quer testar com dados de exemplo?**  
> Rode `npm run db:seed-demo` para popular mercados, produtos, cupons e receitas fictícias. Para limpar depois, use `npm run db:clear-demo`.

### 4. Subindo o Bot e o Painel Web
```bash
# Iniciar o bot do Telegram em modo desenvolvimento (hot-reload)
npm run bot:dev

# Iniciar o painel web Argus Vision BI (http://localhost:3000)
npm run dev
```

Para produção, utilize `npm run build` + `npm start` para o painel web, e `npm run bot:start` para o bot.

---

## 🧪 Testes e Verificação

```bash
# Verifica erros de TypeScript
npm run typecheck

# Roda os testes automatizados (Vitest)
npm test
```

> 📖 Quer saber mais sobre a arquitetura técnica, banco de dados (schema `argus`), segurança e integrações? Veja o arquivo [`ARCHITECTURE.md`](ARCHITECTURE.md).
