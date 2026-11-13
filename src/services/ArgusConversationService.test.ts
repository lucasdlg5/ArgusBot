import { describe, it, expect } from 'vitest';
import { ArgusConversationService } from './ArgusConversationService';
import { createArgusBot } from '../bot/index';

describe('ArgusConversationService — Conversa natural e guia de comandos', () => {
  const service = new ArgusConversationService();

  it('responde saudações básicas de forma breve e guia para /produto arroz', () => {
    const res = service.buildRuleBasedReply('Oi, tudo bem?');
    expect(res.replyText.length).toBeLessThan(260);
    expect(res.suggestedCommand).toContain('/produto');
    expect(res.replyText).toContain('/produto arroz');
  });

  it('detecta pergunta natural sobre produto e explica como usar /produto <item>', () => {
    const res = service.buildRuleBasedReply('Quanto tá o arroz hoje?');
    expect(res.suggestedAction).toBe('PRECO');
    expect(res.suggestedProductQuery).toBe('arroz');
    expect(res.suggestedCommand).toBe('/produto arroz');
    expect(res.replyText).toContain('/produto arroz');
  });

  it('guia para /receita, /otimizar, /reconciliar e /fila conforme o assunto', () => {
    const rec = service.buildRuleBasedReply('Quero calcular o custo das minhas marmitas');
    expect(rec.suggestedAction).toBe('RECEITA');
    expect(rec.replyText).toContain('/receita');

    const route = service.buildRuleBasedReply('Compensa ir de Uber ou gasolina?');
    expect(route.suggestedAction).toBe('OTIMIZAR');
    expect(route.replyText).toContain('/otimizar');

    const bank = service.buildRuleBasedReply('Como concilio meu extrato do banco e VR?');
    expect(bank.suggestedAction).toBe('RECONCILIAR');
    expect(bank.replyText).toContain('/reconciliar');

    const queue = service.buildRuleBasedReply('A foto ficou pendente na fila');
    expect(queue.suggestedAction).toBe('FILA');
    expect(queue.replyText).toContain('/fila');
  });

  it('trata comandos desconhecidos orientando para opções válidas como /produto arroz', () => {
    const res = service.buildRuleBasedReply('/desconhecido');
    expect(res.replyText).toContain('/produto arroz');
    expect(res.suggestedAction).toBe('START');
  });

  it('instancia o bot do Telegram com /produto e suporte a conversa em texto', () => {
    const bot = createArgusBot();
    expect(bot).toBeDefined();
  });

  it('detecta intenção de adicionar receita (WAIT_RECIPE), salvar receita por texto (SAVE_RECIPE_TEXT) e consultar custo de receita específica (ASK_RECIPE_PRICE)', () => {
    const waitRes = service.buildRuleBasedReply('Quero adicionar uma receita');
    expect(waitRes.suggestedAction).toBe('WAIT_RECIPE');
    expect(waitRes.replyText.toLowerCase()).toContain('ingredientes');

    const saveRes = service.buildRuleBasedReply(
      'Adicione esta receita: Omelete Simples\nIngredientes:\n- 3 ovos\n- 50g queijo mussarela\nModo de preparo: bata os ovos e grelhe.'
    );
    expect(saveRes.suggestedAction).toBe('SAVE_RECIPE_TEXT');

    const askPriceRes = service.buildRuleBasedReply('Quanto custa fazer strogonoff?');
    expect(askPriceRes.suggestedAction).toBe('ASK_RECIPE_PRICE');
    expect(askPriceRes.suggestedRecipeQuery).toContain('strogonoff');
  });

  it('extrai primeira URL limpando pontuação final e detecta SAVE_RECIPE_URL em links de receita', () => {
    const cleanUrl = service.extractFirstUrl(
      'Olha esse bolo (https://www.tudogostoso.com.br/receita/23-bolo-de-cenoura.html)!'
    );
    expect(cleanUrl).toBe('https://www.tudogostoso.com.br/receita/23-bolo-de-cenoura.html');

    const culinaryReply = service.buildRuleBasedReply(
      'https://www.tudogostoso.com.br/receita/23-bolo-de-cenoura.html'
    );
    expect(culinaryReply.suggestedAction).toBe('SAVE_RECIPE_URL');
    expect(culinaryReply.suggestedRecipeUrl).toBe(
      'https://www.tudogostoso.com.br/receita/23-bolo-de-cenoura.html'
    );

    const intentReply = service.buildRuleBasedReply(
      'adiciona essa receita https://exemplo.com/bolo'
    );
    expect(intentReply.suggestedAction).toBe('SAVE_RECIPE_URL');
    expect(intentReply.suggestedRecipeUrl).toBe('https://exemplo.com/bolo');
  });
});
