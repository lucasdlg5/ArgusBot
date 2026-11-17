import { env } from '../config/env';
import { logger } from '../config/logger';

export interface LlmFallbackRequest {
  prompt: string;
  imageBase64?: string;
  imageMimeType?: string;
  expectJson?: boolean;
  timeoutMs?: number;
}

export interface LlmFallbackResponse {
  provider: 'openai' | 'claude';
  model: string;
  text: string;
}

function stripJsonCodeFences(raw: string): string {
  const trimmed = raw.trim();
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match ? match[1].trim() : trimmed;
}

export class LlmFallbackProvider {
  hasOpenAi(): boolean {
    return Boolean(env.OPENAI_API_KEY);
  }

  hasClaude(): boolean {
    return Boolean(env.ANTHROPIC_API_KEY);
  }

  hasAnyFallbackConfigured(): boolean {
    return this.hasOpenAi() || this.hasClaude();
  }

  /**
   * Executa a cadeia de fallback secundária/terciária:
   * 2. OpenAI (Chat Completions com suporte a imagem base64)
   * 3. Claude / Anthropic (Messages API com suporte a imagem base64)
   */
  async generateWithSecondaryAndTertiary(
    req: LlmFallbackRequest
  ): Promise<LlmFallbackResponse> {
    const errors: string[] = [];

    if (this.hasOpenAi()) {
      try {
        return await this.callOpenAi(req);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`OpenAI (${env.OPENAI_MODEL}): ${msg}`);
        logger.warn(
          { provider: 'openai', model: env.OPENAI_MODEL, err: msg },
          '[LlmFallback] Falha na OpenAI; tentando Claude (terciário)'
        );
      }
    } else {
      errors.push('OpenAI: OPENAI_API_KEY não configurada');
    }

    if (this.hasClaude()) {
      try {
        return await this.callClaude(req);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`Claude (${env.ANTHROPIC_MODEL}): ${msg}`);
        logger.warn(
          { provider: 'claude', model: env.ANTHROPIC_MODEL, err: msg },
          '[LlmFallback] Falha no Claude (terciário)'
        );
      }
    } else {
      errors.push('Claude: ANTHROPIC_API_KEY não configurada');
    }

    throw new Error(`Todos os provedores de IA falharam — ${errors.join(' | ')}`);
  }

  async callOpenAi(req: LlmFallbackRequest): Promise<LlmFallbackResponse> {
    const timeoutMs = req.timeoutMs ?? 22000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const content: Array<Record<string, unknown>> = [];
    if (req.imageBase64) {
      const mime = req.imageMimeType || 'image/jpeg';
      content.push({
        type: 'image_url',
        image_url: { url: `data:${mime};base64,${req.imageBase64}`, detail: 'high' }
      });
    }
    content.push({
      type: 'text',
      text: req.expectJson
        ? `${req.prompt}\n\nIMPORTANTE: Retorne APENAS um objeto JSON válido, sem texto fora do JSON.`
        : req.prompt
    });

    try {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${env.OPENAI_API_KEY}`
        },
        body: JSON.stringify({
          model: env.OPENAI_MODEL,
          messages: [{ role: 'user', content }],
          ...(req.expectJson ? { response_format: { type: 'json_object' } } : {}),
          temperature: 0.1
        }),
        signal: controller.signal
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status}: ${errText.slice(0, 240)}`);
      }

      const json = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const rawText = json.choices?.[0]?.message?.content || '';
      if (!rawText.trim()) {
        throw new Error('Resposta vazia da OpenAI.');
      }
      const text = req.expectJson ? stripJsonCodeFences(rawText) : rawText.trim();
      logger.info(
        { provider: 'openai', model: env.OPENAI_MODEL, chars: text.length },
        '[LlmFallback] Resposta obtida com sucesso via OpenAI (secundário)'
      );
      return { provider: 'openai', model: env.OPENAI_MODEL, text };
    } finally {
      clearTimeout(timer);
    }
  }

  async callClaude(req: LlmFallbackRequest): Promise<LlmFallbackResponse> {
    const timeoutMs = req.timeoutMs ?? 22000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const content: Array<Record<string, unknown>> = [];
    if (req.imageBase64) {
      const rawMime = req.imageMimeType || 'image/jpeg';
      const supportedMime =
        rawMime === 'image/png' ||
        rawMime === 'image/webp' ||
        rawMime === 'image/gif'
          ? rawMime
          : 'image/jpeg';
      content.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: supportedMime,
          data: req.imageBase64
        }
      });
    }
    content.push({
      type: 'text',
      text: req.expectJson
        ? `${req.prompt}\n\nIMPORTANTE: Responda SOMENTE com o objeto JSON válido, sem markdown e sem explicações.`
        : req.prompt
    });

    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: env.ANTHROPIC_MODEL,
          max_tokens: 4096,
          temperature: 0.1,
          messages: [{ role: 'user', content }]
        }),
        signal: controller.signal
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status}: ${errText.slice(0, 240)}`);
      }

      const json = (await res.json()) as {
        content?: Array<{ type?: string; text?: string }>;
      };
      const rawText = (json.content || [])
        .filter((c) => c.type === 'text' && c.text)
        .map((c) => c.text)
        .join('\n');
      if (!rawText.trim()) {
        throw new Error('Resposta vazia da Anthropic Claude.');
      }
      const text = req.expectJson ? stripJsonCodeFences(rawText) : rawText.trim();
      logger.info(
        { provider: 'claude', model: env.ANTHROPIC_MODEL, chars: text.length },
        '[LlmFallback] Resposta obtida com sucesso via Claude (terciário)'
      );
      return { provider: 'claude', model: env.ANTHROPIC_MODEL, text };
    } finally {
      clearTimeout(timer);
    }
  }
}

export const llmFallbackProvider = new LlmFallbackProvider();
