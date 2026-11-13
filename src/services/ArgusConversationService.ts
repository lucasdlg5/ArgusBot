import { GoogleGenAI, ThinkingLevel, Type } from '@google/genai';
import { env } from '../config/env';
import { logger } from '../config/logger';

export type ArgusSuggestedAction =
  | 'PRECO'
  | 'RECEITA'
  | 'OTIMIZAR'
  | 'RECONCILIAR'
  | 'DASHBOARD'
  | 'FILA'
  | 'LOJA'
  | 'SEGURANCA'
  | 'ENVIAR_MIDIA'
  | 'START';

export interface ArgusConversationReply {
  replyText: string;
  suggestedAction: ArgusSuggestedAction;
  suggestedCommand: string;
  suggestedProductQuery?: string;
  usedAi: boolean;
}

interface ChatTurn {
  role: 'user' | 'model';
  text: string;
}

const MAX_HISTORY_TURNS = 6;

const PRODUCT_STOPWORDS = new Set([
  'o',
  'a',
  'os',
  'as',
  'um',
  'uma',
  'uns',
  'umas',
  'de',
  'do',
  'da',
  'dos',
  'das',
  'em',
  'no',
  'na',
  'nos',
  'nas',
  'por',
  'para',
  'pra',
  'com',
  'sem',
  'que',
  'qual',
  'quais',
  'quanto',
  'quanta',
  'quantos',
  'quantas',
  'custa',
  'custando',
  'ta',
  'tá',
  'esta',
  'está',
  'estao',
  'estão',
  'valor',
  'preco',
  'preço',
  'precos',
  'preços',
  'produto',
  'produtos',
  'item',
  'itens',
  'mercado',
  'supermercado',
  'onde',
  'tem',
  'achar',
  'acho',
  'encontrar',
  'barato',
  'barata',
  'mais',
  'menos',
  'hoje',
  'agora',
  'ver',
  'consultar',
  'busca',
  'buscar',
  'procurar',
  'pesquisar',
  'saber',
  'quero',
  'gostaria',
  'me',
  'diz',
  'fala',
  'ai',
  'aí',
  'sobre',
  'kg',
  'g',
  'l',
  'ml'
]);

const SYSTEM_INSTRUCTION = `Você é o ARGUS (@MonetaArgusBot), o Olho Fiscal do ecossistema Moneta.
Sua missão nesta conversa por texto livre no Telegram:
1. Responder coisas básicas (saudações, perguntas simples do dia a dia ou dúvidas rápidas sobre como o bot funciona) de forma NATURAL, SIMPÁTICA e BREVE (máximo de 2 a 3 frases curtas, sem elaborar profundamente e sem textão).
2. SEMPRE guiar o usuário para uma opção próxima disponível no bot OU explicar rapidamente como usar o comando correspondente com um exemplo prático.
3. NUNCA invente preços, saldos, cupons ou números que não foram consultados nos comandos reais.

Opções e comandos reais disponíveis no bot:
- /produto <item> (ou /preco <item>): consulta preço atual e mínima histórica de um item (ex: /produto arroz, /produto frango).
- /receita: calcula custo proporcional por porção vs. desembolso de caixa das receitas.
- /otimizar: simula rota OSRM (Mercado Único vs. Compra Dividida; Gasolina vs. Uber).
- /reconciliar: cruza cupons fiscais com Open Finance (Pluggy) e atualiza a planilha Argus Ledger.
- /dashboard: mostra resumo executivo de gastos, reduflação e oportunidades.
- /fila: lista mídias processadas, fila de reprocessamento e últimos preços coletados.
- /loja <Nome | Bairro>: vincula ou corrige a loja da última foto/vídeo de gôndola (ex: /loja Atacadão | Centro).
- /seguranca: exibe relatório de bloqueios e auditoria de segurança.
- /start: menu completo de comandos.
- Envio direto de mídia: o usuário pode mandar foto/PDF de cupom fiscal, foto de gôndola/flyer ou vídeo do corredor direto no chat.

Regras para os campos JSON:
- replyText: resposta curta em português do Brasil (sem markdown complexo), respondendo de forma básica e terminando com uma orientação clara ou exemplo (ex: "Experimente enviar /produto arroz").
- suggestedAction: escolha exatamente a opção mais próxima da lista.
- suggestedCommand: comando ou ação sugerida em formato curto (ex: "/produto arroz", "/receita", "Enviar foto do cupom").
- suggestedProductQuery: se o usuário mencionou um produto específico de mercado (ex: "arroz", "café", "feijão", "frango"), preencha apenas o nome curto do item; caso contrário deixe string vazia "".`;

export class ArgusConversationService {
  private readonly ai: GoogleGenAI | null;
  private readonly historyByChat = new Map<string, ChatTurn[]>();

  constructor() {
    this.ai = env.GEMINI_API_KEY
      ? new GoogleGenAI({
          apiKey: env.GEMINI_API_KEY,
          httpOptions: {
            headers: {
              'User-Agent': 'aistudio-build'
            }
          }
        })
      : null;
  }

  /**
   * Extrai um possível termo de produto de uma pergunta em linguagem natural
   * (ex: "quanto tá o arroz?" -> "arroz").
   */
  extractProductCandidate(message: string): string | undefined {
    const cleaned = message
      .toLowerCase()
      .replace(/[?!.,;:"'()[\]{}]/g, ' ')
      .replace(/^\/\S+\s*/, '')
      .trim();

    if (!cleaned) return undefined;

    const tokens = cleaned
      .split(/\s+/)
      .filter((t) => t.length >= 2 && !PRODUCT_STOPWORDS.has(t));

    if (tokens.length === 0) return undefined;
    return tokens.slice(0, 3).join(' ');
  }

  private pushHistory(chatKey: string, userText: string, modelText: string) {
    const history = this.historyByChat.get(chatKey) ?? [];
    history.push({ role: 'user', text: userText.slice(0, 300) });
    history.push({ role: 'model', text: modelText.slice(0, 400) });
    while (history.length > MAX_HISTORY_TURNS * 2) {
      history.shift();
    }
    this.historyByChat.set(chatKey, history);
  }

  private getRecentHistoryText(chatKey: string): string {
    const history = this.historyByChat.get(chatKey);
    if (!history || history.length === 0) return '';
    return history
      .slice(-4)
      .map((h) => `${h.role === 'user' ? 'Usuário' : 'Argus'}: ${h.text}`)
      .join('\n');
  }

  /**
   * Fallback determinístico (offline / sem GEMINI_API_KEY):
   * Responde de forma breve e sempre direciona para a opção mais próxima ou exemplo de comando.
   */
  buildRuleBasedReply(rawMessage: string): ArgusConversationReply {
    const msg = rawMessage.trim();
    const norm = msg
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');

    // 1. Comando desconhecido ou /ajuda
    if (norm.startsWith('/')) {
      const cmdToken = norm.split(/\s+/)[0];
      if (cmdToken === '/ajuda' || cmdToken === '/help' || cmdToken === '/menu' || cmdToken === '/comandos') {
        return {
          replyText:
            '👁️ Aqui vai um resumo rápido do que posso fazer por você:\n' +
            '• Consultar item: /produto arroz\n' +
            '• Ver custo de pratos: /receita\n' +
            '• Simular melhor rota: /otimizar\n' +
            '• Ou mande direto a foto do cupom/gôndola aqui!',
          suggestedAction: 'START',
          suggestedCommand: '/produto arroz',
          suggestedProductQuery: 'arroz',
          usedAi: false
        };
      }

      const candidate = this.extractProductCandidate(msg);
      if (candidate && (norm.includes('prod') || norm.includes('prec') || norm.includes('item'))) {
        return {
          replyText:
            `Ainda não tenho o comando "${cmdToken}", mas acho que você quer consultar um item!\n\n` +
            `👉 Use assim: /produto ${candidate}`,
          suggestedAction: 'PRECO',
          suggestedCommand: `/produto ${candidate}`,
          suggestedProductQuery: candidate,
          usedAi: false
        };
      }

      return {
        replyText:
          `Não reconheci o comando "${cmdToken}". Sem problemas!\n\n` +
          '👉 Para ver preços, tente por exemplo /produto arroz — ou toque em uma opção abaixo.',
        suggestedAction: 'START',
        suggestedCommand: '/produto arroz',
        suggestedProductQuery: 'arroz',
        usedAi: false
      };
    }

    // 2. Saudações e cordialidades simples
    if (
      /^(oi+|ola+|opa+|e ai|eai|fala|salve|bom dia|boa tarde|boa noite|tudo bem|td bem|beleza|blz|como vai|obrigad[oa]|valeu|vlw|show|top|blz)\b/.test(
        norm
      ) &&
      norm.length <= 65
    ) {
      const isThanks = /^(obrigad[oa]|valeu|vlw|show|top)\b/.test(norm);
      return {
        replyText: isThanks
          ? 'Por nada! Estou sempre de olho por aqui. 👁️\n\nSe quiser checar algum preço rápido, tente /produto arroz ou mande a foto de um cupom.'
          : 'Oi! Tudo certo por aqui — sigo vigiando seus preços e cupons. 👁️\n\nVocê pode me mandar uma foto de cupom/gôndola ou começar buscando um item com /produto arroz.',
        suggestedAction: 'PRECO',
        suggestedCommand: '/produto arroz',
        suggestedProductQuery: 'arroz',
        usedAi: false
      };
    }

    // 3. Perguntas sobre identidade / como usar
    if (
      /(quem e voce|o que voce faz|como funciona|como uso|como usar|me ajuda|ajuda|comandos|o que eu posso)/.test(
        norm
      )
    ) {
      return {
        replyText:
          'Sou o Argus, seu auditor de mercado e gastos! Leio cupons fiscais, gôndolas, receitas e rotas sem complicação.\n\n' +
          '👉 Para testar agora, digite /produto arroz ou envie a foto de uma nota fiscal.',
        suggestedAction: 'PRECO',
        suggestedCommand: '/produto arroz',
        suggestedProductQuery: 'arroz',
        usedAi: false
      };
    }

    // 4. Receitas / Marmitas
    if (/(receita|marmita|porcao|porcoes|cozinhar|prato|ingrediente|strogonoff|almoco|janta)/.test(norm)) {
      return {
        replyText:
          'Consigo calcular na hora o custo proporcional por porção e o gasto de caixa das suas receitas.\n\n' +
          '👉 Envie /receita para abrir o comparativo completo.',
        suggestedAction: 'RECEITA',
        suggestedCommand: '/receita',
        usedAi: false
      };
    }

    // 5. Logística / Rota / Uber vs Gasolina
    if (/(uber|gasolina|combustivel|carro|rota|distancia|onde comprar|dividir compra|otimizar|economia|economizar)/.test(norm)) {
      return {
        replyText:
          'Posso simular se compensa comprar tudo em um mercado só ou dividir a compra (comparando gasolina vs. Uber).\n\n' +
          '👉 Use /otimizar para rodar o simulador de rota agora.',
        suggestedAction: 'OTIMIZAR',
        suggestedCommand: '/otimizar',
        usedAi: false
      };
    }

    // 6. Conciliação / Open Finance / Banco / Planilha
    if (/(banco|extrato|pluggy|open finance|vr|va|vale|planilha|sheets|conciliar|pix|cartao)/.test(norm)) {
      return {
        replyText:
          'Eu cruzo seus cupons com as transações do Open Finance e sincronizo tudo na planilha Argus Ledger.\n\n' +
          '👉 Envie /reconciliar para atualizar a conciliação.',
        suggestedAction: 'RECONCILIAR',
        suggestedCommand: '/reconciliar',
        usedAi: false
      };
    }

    // 7. Fila / Loja / Mídias
    if (/(fila|reprocessar|travou|pendente|tentativa)/.test(norm)) {
      return {
        replyText:
          'Todas as fotos e vídeos com pendência ficam salvos na fila automática para não perder nada.\n\n' +
          '👉 Confira o status ou force a tentativa com /fila.',
        suggestedAction: 'FILA',
        suggestedCommand: '/fila',
        usedAi: false
      };
    }

    if (/(corrigir loja|mudar loja|qual loja|nome da loja|bairro|filial)/.test(norm)) {
      return {
        replyText:
          'Você pode vincular ou corrigir o mercado da última coleta de gôndola/vídeo rapidinho.\n\n' +
          '👉 Exemplo de uso: /loja Atacadão | Centro',
        suggestedAction: 'LOJA',
        suggestedCommand: '/loja Atacadão | Centro',
        usedAi: false
      };
    }

    // 8. Fotos / Notas / Vídeos / Panfletos
    if (/(cupom|nota fiscal|nfce|sat|foto|pdf|video|gondola|prateleira|panfleto|flyer|encarte)/.test(norm)) {
      return {
        replyText:
          'Para registrar cupons ou ofertas, basta enviar a foto/PDF da nota, foto da gôndola/flyer ou vídeo do corredor direto aqui!\n\n' +
          '👉 Depois de enviar, acompanhe seus lançamentos em /dashboard ou /fila.',
        suggestedAction: 'ENVIAR_MIDIA',
        suggestedCommand: '/fila',
        usedAi: false
      };
    }

    // 9. Dashboard / Resumo / Reduflação / Inflação
    if (/(dashboard|resumo|painel|grafico|reduflacao|inflacao|gastos|gastei|quanto gastei)/.test(norm)) {
      return {
        replyText:
          'Posso te mostrar um resumo direto dos seus gastos, alertas de reduflação e itens na mínima histórica.\n\n' +
          '👉 Digite /dashboard para ver agora.',
        suggestedAction: 'DASHBOARD',
        suggestedCommand: '/dashboard',
        usedAi: false
      };
    }

    // 10. Segurança
    if (/(seguranca|ataque|invasao|intruso|bloqueio|auditoria)/.test(norm)) {
      return {
        replyText:
          'Monitoro e registro qualquer tentativa não autorizada de acesso ao bot.\n\n' +
          '👉 Veja o relatório completo enviando /seguranca.',
        suggestedAction: 'SEGURANCA',
        suggestedCommand: '/seguranca',
        usedAi: false
      };
    }

    // 11. Consulta de produto / preço em linguagem natural
    const candidate = this.extractProductCandidate(msg);
    if (
      candidate &&
      /(preco|valor|quanto|custa|barato|mercado|comprar|achei|tem|arroz|feijao|frango|carne|leite|cafe|azeite|ovo|ovos|oleo|acucar|macarrao|sabao|papel|manteiga|batata|cebola)/.test(
        norm
      )
    ) {
      return {
        replyText:
          `Para ver o preço atualizado e onde "${candidate}" está mais barato, consulte direto na base:\n\n` +
          `👉 Digite: /produto ${candidate}`,
        suggestedAction: 'PRECO',
        suggestedCommand: `/produto ${candidate}`,
        suggestedProductQuery: candidate,
        usedAi: false
      };
    }

    // 12. Conversa genérica / fora de tópico
    return {
      replyText:
        'Entendi! Meu foco aqui é facilitar suas compras, receitas e gastos sem complicação.\n\n' +
        '👉 Experimente consultar um item (ex: /produto arroz), simular rotas com /otimizar ou enviar a foto de um cupom!',
      suggestedAction: candidate ? 'PRECO' : 'START',
      suggestedCommand: candidate ? `/produto ${candidate}` : '/produto arroz',
      suggestedProductQuery: candidate || 'arroz',
      usedAi: false
    };
  }

  async replyToMessage(
    userMessage: string,
    chatId?: string | number
  ): Promise<ArgusConversationReply> {
    const trimmed = userMessage.trim();
    if (!trimmed) {
      return this.buildRuleBasedReply('oi');
    }

    const chatKey = String(chatId ?? 'default');
    const ruleFallback = this.buildRuleBasedReply(trimmed);

    // Comandos /ajuda ou sem chave Gemini configurada usam resposta instantânea
    if (!this.ai || trimmed.startsWith('/ajuda') || trimmed.startsWith('/help')) {
      this.pushHistory(chatKey, trimmed, ruleFallback.replyText);
      return ruleFallback;
    }

    const recentHistory = this.getRecentHistoryText(chatKey);
    const prompt = recentHistory
      ? `Histórico recente:\n${recentHistory}\n\nMensagem atual do usuário: "${trimmed}"`
      : `Mensagem do usuário: "${trimmed}"`;

    const candidateModels = Array.from(
      new Set([
        'gemini-4-hydrogen',
        env.GEMINI_MODEL,
        'gemini-3.6-flash',
        'gemini-3.5-flash-lite',
        'gemini-3.8-flash'
      ])
    );

    for (const modelName of candidateModels) {
      let timer: NodeJS.Timeout | undefined;
      try {
        const timeoutPromise = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`Timeout no modelo ${modelName}`)), 9000);
        });

        const isGemini4 = modelName.startsWith('gemini-4') || modelName.startsWith('gemini-3.');
        const response = await Promise.race([
          this.ai.models.generateContent({
            model: modelName,
            contents: prompt,
            config: {
              systemInstruction: SYSTEM_INSTRUCTION,
              ...(isGemini4 ? { thinkingConfig: { thinkingLevel: ThinkingLevel.LOW } } : {}),
              responseMimeType: 'application/json',
              responseSchema: {
                type: Type.OBJECT,
                properties: {
                  replyText: {
                    type: Type.STRING,
                    description:
                      'Resposta curta e amigável em português (2 a 3 frases curtas, sem elaborar demais), sempre guiando para uma opção disponível ou explicando como usar um comando com exemplo (ex: /produto arroz).'
                  },
                  suggestedAction: {
                    type: Type.STRING,
                    enum: [
                      'PRECO',
                      'RECEITA',
                      'OTIMIZAR',
                      'RECONCILIAR',
                      'DASHBOARD',
                      'FILA',
                      'LOJA',
                      'SEGURANCA',
                      'ENVIAR_MIDIA',
                      'START'
                    ]
                  },
                  suggestedCommand: {
                    type: Type.STRING,
                    description: 'Exemplo curto de comando (ex: /produto arroz, /receita, /otimizar).'
                  },
                  suggestedProductQuery: {
                    type: Type.STRING,
                    description:
                      'Termo curto do produto se o usuário perguntou sobre um item específico (ex: arroz), senão string vazia.'
                  }
                },
                required: ['replyText', 'suggestedAction', 'suggestedCommand']
              }
            }
          }),
          timeoutPromise
        ]);
        if (timer) clearTimeout(timer);

        const rawJson = (response.text ?? '').trim();
        if (!rawJson) continue;

        const parsed = JSON.parse(rawJson) as Partial<ArgusConversationReply>;
        if (!parsed.replyText || !parsed.suggestedAction) continue;

        const cleanProduct = (parsed.suggestedProductQuery ?? '')
          .trim()
          .replace(/^\/\S+\s*/, '')
          .slice(0, 40);

        const result: ArgusConversationReply = {
          replyText: parsed.replyText.trim().slice(0, 700),
          suggestedAction: parsed.suggestedAction,
          suggestedCommand: (parsed.suggestedCommand || '/produto arroz').trim().slice(0, 60),
          suggestedProductQuery: cleanProduct || ruleFallback.suggestedProductQuery,
          usedAi: true
        };

        this.pushHistory(chatKey, trimmed, result.replyText);
        return result;
      } catch (err) {
        if (timer) clearTimeout(timer);
        logger.warn(
          { modelName, err: (err as Error).message },
          '[ArgusConversationService] Falha ao responder via Gemini; tentando fallback'
        );
      }
    }

    this.pushHistory(chatKey, trimmed, ruleFallback.replyText);
    return ruleFallback;
  }
}
