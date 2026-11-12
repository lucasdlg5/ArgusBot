import { Api } from 'grammy';
import { logger } from '../config/logger';

export type ArgusEmotionTone =
  | 'CELEBRATION' // Economia real, mínima histórica, cupom salvo com sucesso sem reduflação
  | 'SHOCK_ALERT' // Reduflação detectada, ataque bloqueado de alta severidade, erro grave
  | 'SKEPTICAL' // Veredito cético (gasolina/Uber comeu a economia), cupom descartado
  | 'FOOD_CHEF' // Receitas (/receita), leitura de itens de supermercado
  | 'DETECTIVE'; // Boas-vindas (/start), vigilância fiscal e auditoria limpa

interface StickerEntry {
  pack: 'Asm923' | 'lockestickers';
  emoji: string;
  fileId: string;
}

const STICKER_PACK_NAMES: Array<'Asm923' | 'lockestickers'> = ['Asm923', 'lockestickers'];

/**
 * Mapa de emojis associados a cada tom emocional do Argus nos pacotes `Asm923` e `lockestickers`
 */
const EMOTION_EMOJI_MAP: Record<ArgusEmotionTone, string[]> = {
  CELEBRATION: ['🔥', '👍', '😎', '🙌', '💪', '🌟', '⭐', '😍', '🤗', '❤️'],
  SHOCK_ALERT: ['😱', '😨', '😰', '😡', '🤬', '💢', '❗️', '‼', '💥'],
  SKEPTICAL: ['🤨', '🤔', '😒', '😐', '🤷‍♂', '😥', '😩', '😫', '😅'],
  FOOD_CHEF: ['😋', '🍗', '🥩', '🧀', '🥪', '🤤'],
  DETECTIVE: ['👀', '👋', '😎', '😏', '🤫']
};

/**
 * Catálogo inicial pré-indexado dos pacotes oficiais:
 * - https://t.me/addstickers/Asm923
 * - https://t.me/addstickers/lockestickers
 * Complementado em tempo de execução via `api.getStickerSet` para cobrir todas as 173 figurinhas.
 */
const FALLBACK_STICKERS: StickerEntry[] = [
  // CELEBRATION (Asm923 + lockestickers)
  { pack: 'Asm923', emoji: '🔥', fileId: 'CAACAgEAAxUAAWr1QRfCc1Ci-Db-ZpfX-wabI2BlAALzBgACP984RofCMcTsUEs2PQQ' },
  { pack: 'Asm923', emoji: '🔥', fileId: 'CAACAgEAAxUAAWr1QRc7oPVI5mwC47rO2g34SHFKAALICAACOwNwRZ_h4cW2DuUcPQQ' },
  { pack: 'Asm923', emoji: '👍', fileId: 'CAACAgEAAxUAAWr1QReLsUqt6O0m4tMDxlAmwT6nAAJjHgACXmchRnfitW6h7sNRPQQ' },
  { pack: 'Asm923', emoji: '😎', fileId: 'CAACAgEAAxUAAWr1QRc6FVYb_mCEuN3ys_rMX6MYAALfBgACxWkBRc3fbA7WWSU5PQQ' },
  { pack: 'Asm923', emoji: '🌟', fileId: 'CAACAgEAAxUAAWr1QRetIPllvxYJt3xvAvcufa8fAALBCQACOAbpRbFDF6dcbPlQPQQ' },
  { pack: 'lockestickers', emoji: '🙌', fileId: 'CAACAgUAAxUAAWr1QRiXiWnSVohNPGmRj6xh1H8wAAKJBwACYuURVH0VU8rB2QWKPQQ' },
  { pack: 'lockestickers', emoji: '💪', fileId: 'CAACAgUAAxUAAWr1QRjpHo3It5TwkQXeUiUaFv_IAAK_CAACuCqYVQa00CL382iQPQQ' },
  { pack: 'lockestickers', emoji: '🤗', fileId: 'CAACAgUAAxUAAWr1QRjcj_cH7XshGb-pkrK0TaApAAIzBwACjDjoV_Z4OY2iZmUIPQQ' },
  { pack: 'lockestickers', emoji: '🙌', fileId: 'CAACAgUAAxUAAWr1QRjZZ0HC24CqeTB5CAy3B4rcAAI6FwACMc6IVH_FfXyIOKhWPQQ' },

  // SHOCK_ALERT (Asm923 + lockestickers)
  { pack: 'Asm923', emoji: '😱', fileId: 'CAACAgEAAxUAAWr1QRfcKXc7lWiJp7LaKo_br0-mAAJeCQACZj1xRX8FBNZRsH5FPQQ' },
  { pack: 'Asm923', emoji: '😨', fileId: 'CAACAgEAAxUAAWr1QRc2LLEQLgzMUe-I-CFwi4gdAAJ6CAAC_i3RRQOp5OGalNxrPQQ' },
  { pack: 'Asm923', emoji: '😡', fileId: 'CAACAgEAAxUAAWr1QReT1P1k_FfNvDSohY4aUBaJAAK7CAACI2pwRYRm_pRPnLQFPQQ' },
  { pack: 'Asm923', emoji: '🤬', fileId: 'CAACAgEAAxUAAWr1QRd_BbSE2WQEtH1mFzYbtu7SAAIlBwACj9NxRXD-eYSL9CuOPQQ' },
  { pack: 'Asm923', emoji: '‼', fileId: 'CAACAgEAAxUAAWr1QRcu56gpTo9To6Ru2u23fNG7AALoBgAC6B34RXrSZFZqzQSwPQQ' },
  { pack: 'lockestickers', emoji: '😰', fileId: 'CAACAgUAAxUAAWr1QRhg7A_84e8BKR3qr-4Kki9SAAJaCQACd52YVWTHmbhr4GB_PQQ' },
  { pack: 'lockestickers', emoji: '💢', fileId: 'CAACAgUAAxUAAWr1QRj6nRyN3WyZ8p0erIW-860lAAIMEAAC7XhJV3516KPvB9YxPQQ' },
  { pack: 'lockestickers', emoji: '❗️', fileId: 'CAACAgUAAxUAAWr1QRgLWXEEmFyghDRGCq-rxjU9AAJMEAACXt-JV3HHpDmfdQABKz0E' },
  { pack: 'lockestickers', emoji: '💥', fileId: 'CAACAgUAAxUAAWr1QRj0Cfh09V4UJsgDO3-EdGZaAAInFwAC-CLBVjU6bEPE_7ImPQQ' },

  // SKEPTICAL (Asm923 + lockestickers)
  { pack: 'Asm923', emoji: '🤨', fileId: 'CAACAgEAAxUAAWr1QRcm5Qw3bdzBqdxHzlNiVbUUAAJHBwACcU7BRQmBcCcfDPFzPQQ' },
  { pack: 'Asm923', emoji: '🤔', fileId: 'CAACAgEAAxUAAWr1QRf_-4eob50De0HYxpDCNB2sAAIqCQACyuRwRQzSnxpBhHiEPQQ' },
  { pack: 'Asm923', emoji: '😒', fileId: 'CAACAgEAAxUAAWr1QRd2ZZF8J5W4B0cWihnydcZaAAKnRwAC7R9oRXVENEdr3lZrPQQ' },
  { pack: 'Asm923', emoji: '🤷‍♂', fileId: 'CAACAgEAAxUAAWr1QRe5m5l_Dtc1Ve4XTBsdPlRVAAIWCAACeJJoRRZhZjCJjVeXPQQ' },
  { pack: 'Asm923', emoji: '😥', fileId: 'CAACAgEAAxUAAWr1QRf681F1juKz3VhOtVcpD7fIAAIGCQAC3zhpRXw1onqxAfP4PQQ' },
  { pack: 'lockestickers', emoji: '🤔', fileId: 'CAACAgUAAxUAAWr1QRgUIIMFnZfaveTdg8YqFsDOAAIXBgACotAoV7NqQJJaK5LSPQQ' },
  { pack: 'lockestickers', emoji: '😩', fileId: 'CAACAgUAAxUAAWr1QRg3ScrlrCAyxOfJQXtGXGnuAAIYEwACBJpxVGSqNheUpE9QPQQ' },

  // FOOD_CHEF (Asm923 + lockestickers)
  { pack: 'Asm923', emoji: '🍗', fileId: 'CAACAgEAAxUAAWr1QRfriWA0_zWPG_d503tUDNKVAAKlBgAC08hBRkYsUCJZ7NdiPQQ' },
  { pack: 'Asm923', emoji: '🧀', fileId: 'CAACAgEAAxUAAWr1QRfDKj5obzTRn5aOrI3hEphCAALjCAACAVFwRVhXMooJWOstPQQ' },
  { pack: 'Asm923', emoji: '🥩', fileId: 'CAACAgEAAxUAAWr1QReczJqJtkK4pR5yofVlfrZ_AALzCQACwrr4Rf9_Fx9QlwkfPQQ' },
  { pack: 'lockestickers', emoji: '🥩', fileId: 'CAACAgUAAxUAAWr1QRhP2PXQhY17rU1Vd4RFI7L6AAIDCQACaufgV5LcKZ90wnmtPQQ' },
  { pack: 'lockestickers', emoji: '😋', fileId: 'CAACAgUAAxUAAWr1QRiHOzFDJZFVWJHHfTkyAl_VAALSBgAC_xbIVLX-09tbgQRaPQQ' },
  { pack: 'lockestickers', emoji: '😋', fileId: 'CAACAgUAAxUAAWr1QRjxzjAesZtyjJ_8HmZtaI2wAAKiBwACd8cgVZ2ZW9OoJ2s6PQQ' },
  { pack: 'lockestickers', emoji: '🥪', fileId: 'CAACAgUAAxUAAWr1QRis9lo_w2Od0L60HC2J1ChJAALzCwACZ1x5V8QyvUZwxFR1PQQ' },

  // DETECTIVE (Asm923 + lockestickers)
  { pack: 'Asm923', emoji: '👀', fileId: 'CAACAgEAAxUAAWr1QRdgTroKuPTKRSzM2RRe4L35AALmCwAC7ztwRZY2r0vNHPp1PQQ' },
  { pack: 'Asm923', emoji: '👀', fileId: 'CAACAgEAAxUAAWr1QReldR4QsmG2lmBL9QFQ4qBYAAJECAACjpf4RfzPU8vc9byrPQQ' },
  { pack: 'Asm923', emoji: '👋', fileId: 'CAACAgEAAxUAAWr1QRdJWm2GtX1842Zj8Vn-eoUYAALXBgAC2eH5RY5HK5S0yUzGPQQ' },
  { pack: 'lockestickers', emoji: '👀', fileId: 'CAACAgUAAxUAAWr1QRixKxOl_NJ3S20d-s-N6vWSAAIFCQACD2PBVA18P1qFWTRePQQ' },
  { pack: 'lockestickers', emoji: '👀', fileId: 'CAACAgUAAxUAAWr1QRg1SlEEYZhuQ7WFnXTR05OqAAJLGwACqgipVm_YVZ6ZdalRPQQ' }
];

export class ArgusStickerService {
  private stickers: StickerEntry[] = [...FALLBACK_STICKERS];
  private loadedFromApi = false;
  private lastSentFileId: string | null = null;
  private lastPackUsed: 'Asm923' | 'lockestickers' = 'lockestickers';

  /**
   * Carrega todos os 173 stickers dos pacotes `Asm923` e `lockestickers` via API do Telegram
   */
  async ensurePacksLoaded(api: Api): Promise<void> {
    if (this.loadedFromApi) return;
    this.loadedFromApi = true;

    try {
      const loaded: StickerEntry[] = [];
      for (const pack of STICKER_PACK_NAMES) {
        const set = await api.getStickerSet(pack);
        for (const s of set.stickers) {
          if (s.file_id) {
            loaded.push({
              pack,
              emoji: s.emoji || '🙂',
              fileId: s.file_id
            });
          }
        }
      }
      if (loaded.length > 0) {
        this.stickers = loaded;
        logger.info(
          { totalStickers: loaded.length, packs: STICKER_PACK_NAMES },
          '[ArgusStickerService] Pacotes de figurinhas Asm923 e lockestickers carregados'
        );
      }
    } catch (err) {
      logger.warn(
        { err: (err as Error).message },
        '[ArgusStickerService] Usando catálogo embarcado para Asm923 e lockestickers'
      );
    }
  }

  /**
   * Seleciona um sticker alinhado ao tom emocional, alternando entre os pacotes `Asm923` e `lockestickers`
   */
  pickStickerForTone(tone: ArgusEmotionTone): StickerEntry {
    const targetEmojis = EMOTION_EMOJI_MAP[tone];
    const preferredPack = this.lastPackUsed === 'Asm923' ? 'lockestickers' : 'Asm923';

    let candidates = this.stickers.filter(
      (s) => targetEmojis.includes(s.emoji) && s.fileId !== this.lastSentFileId
    );

    if (candidates.length === 0) {
      candidates = this.stickers.filter((s) => s.fileId !== this.lastSentFileId);
    }

    const preferredPackCandidates = candidates.filter((s) => s.pack === preferredPack);
    const pool = preferredPackCandidates.length > 0 ? preferredPackCandidates : candidates;

    const chosen = pool[Math.floor(Math.random() * pool.length)] || FALLBACK_STICKERS[0];
    this.lastSentFileId = chosen.fileId;
    this.lastPackUsed = chosen.pack;
    return chosen;
  }

  /**
   * Envia uma figurinha dos pacotes `Asm923` ou `lockestickers` como última mensagem da interação
   */
  async sendEmotionalSticker(
    ctx: { api: Api; chat?: { id: number }; replyWithSticker?: (sticker: string) => Promise<unknown> },
    tone: ArgusEmotionTone
  ): Promise<void> {
    try {
      await this.ensurePacksLoaded(ctx.api);
      const chosen = this.pickStickerForTone(tone);
      if (ctx.replyWithSticker) {
        await ctx.replyWithSticker(chosen.fileId);
      } else if (ctx.chat?.id) {
        await ctx.api.sendSticker(ctx.chat.id, chosen.fileId);
      }
    } catch (err) {
      logger.warn(
        { err: (err as Error).message, tone },
        '[ArgusStickerService] Falha não-bloqueante ao enviar figurinha emocional'
      );
    }
  }

  /**
   * Envia figurinha emocional diretamente para um chatId específico (ex: alertas de segurança)
   */
  async sendEmotionalStickerToChat(
    api: Api,
    chatId: number | string,
    tone: ArgusEmotionTone
  ): Promise<void> {
    try {
      await this.ensurePacksLoaded(api);
      const chosen = this.pickStickerForTone(tone);
      await api.sendSticker(chatId, chosen.fileId);
    } catch (err) {
      logger.warn(
        { err: (err as Error).message, tone },
        '[ArgusStickerService] Falha ao enviar figurinha para chatId'
      );
    }
  }
}
