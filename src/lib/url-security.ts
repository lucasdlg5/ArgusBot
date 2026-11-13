import dns from 'node:dns/promises';
import net from 'node:net';

export class UnsafeUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeUrlError';
  }
}

export class RecipeFetchError extends Error {
  readonly statusCode: number;
  constructor(message: string, statusCode = 422) {
    super(message);
    this.name = 'RecipeFetchError';
    this.statusCode = statusCode;
  }
}

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'ip6-localhost',
  'ip6-loopback',
  'metadata.google.internal',
  'metadata.goog',
  'metadata',
  '169.254.169.254',
  '0.0.0.0'
]);

function ipv4ToInt(ip: string): number {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) {
    return -1;
  }
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function inIpv4Cidr(ipInt: number, base: string, prefixLen: number): boolean {
  const baseInt = ipv4ToInt(base);
  if (ipInt < 0 || baseInt < 0) return false;
  const mask = prefixLen === 0 ? 0 : (0xffffffff << (32 - prefixLen)) >>> 0;
  return (ipInt & mask) === (baseInt & mask);
}

/**
 * Verifica se um endereço IPv4 ou IPv6 pertence a faixas privadas, loopback,
 * link-local (AWS/GCP metadata 169.254.169.254), CGNAT ou reservadas.
 */
export function isPrivateOrReservedIp(rawIp: string): boolean {
  const ip = rawIp.trim().replace(/^\[|\]$/g, '').split('%')[0].toLowerCase();
  const family = net.isIP(ip);
  if (family === 0) return true;

  if (family === 4) {
    const ipInt = ipv4ToInt(ip);
    if (ipInt < 0) return true;
    return (
      inIpv4Cidr(ipInt, '0.0.0.0', 8) || // "This" network
      inIpv4Cidr(ipInt, '10.0.0.0', 8) || // RFC 1918
      inIpv4Cidr(ipInt, '100.64.0.0', 10) || // CGNAT (RFC 6598)
      inIpv4Cidr(ipInt, '127.0.0.0', 8) || // Loopback
      inIpv4Cidr(ipInt, '169.254.0.0', 16) || // Link-local / Cloud Metadata
      inIpv4Cidr(ipInt, '172.16.0.0', 12) || // RFC 1918
      inIpv4Cidr(ipInt, '192.0.0.0', 24) || // IETF Protocol Assignments
      inIpv4Cidr(ipInt, '192.0.2.0', 24) || // TEST-NET-1
      inIpv4Cidr(ipInt, '192.168.0.0', 16) || // RFC 1918
      inIpv4Cidr(ipInt, '198.18.0.0', 15) || // Benchmarking
      inIpv4Cidr(ipInt, '198.51.100.0', 24) || // TEST-NET-2
      inIpv4Cidr(ipInt, '203.0.113.0', 24) || // TEST-NET-3
      inIpv4Cidr(ipInt, '224.0.0.0', 4) || // Multicast
      inIpv4Cidr(ipInt, '240.0.0.0', 4) // Reserved / Broadcast
    );
  }

  // IPv6 checks
  if (ip === '::' || ip === '::1') return true;
  if (ip.startsWith('::ffff:')) {
    const mappedV4 = ip.slice('::ffff:'.length);
    if (net.isIP(mappedV4) === 4) {
      return isPrivateOrReservedIp(mappedV4);
    }
  }
  // fc00::/7 (Unique Local Address: fc.. or fd..)
  if (/^f[cd][0-9a-f]{2}:/i.test(ip)) return true;
  // fe80::/10 (Link-local: fe80..febf)
  if (/^fe[89ab][0-9a-f]:/i.test(ip)) return true;
  // ff00::/8 (Multicast)
  if (ip.startsWith('ff')) return true;

  return false;
}

export function looksLikeSefazUrl(rawUrl: string): boolean {
  const lower = rawUrl.toLowerCase();
  return (
    (lower.includes('fazenda') || lower.includes('sefaz') || lower.includes('nfce')) &&
    (lower.includes('chavenfe') || lower.includes('p=') || lower.includes('qrcode'))
  );
}

/**
 * Valida formato, protocolo, porta e hostname de uma URL pública de receita (anti-SSRF).
 */
export function validatePublicRecipeUrl(rawUrl: string): URL {
  const trimmed = (rawUrl || '').trim();
  if (!trimmed || trimmed.length > 2048) {
    throw new UnsafeUrlError('Link inválido ou longo demais.');
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new UnsafeUrlError('URL inválida. Informe um link completo começando com https:// ou http://.');
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new UnsafeUrlError(
      'Por segurança, apenas links públicos http:// ou https:// são permitidos.'
    );
  }

  if (parsed.username || parsed.password) {
    throw new UnsafeUrlError('Links com usuário ou senha embutidos não são permitidos.');
  }

  if (parsed.port && parsed.port !== '80' && parsed.port !== '443') {
    throw new UnsafeUrlError('Por segurança, apenas portas web padrão (80/443) são permitidas.');
  }

  const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (
    !host ||
    BLOCKED_HOSTNAMES.has(host) ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host.endsWith('.localhost') ||
    host.endsWith('.lan') ||
    host.endsWith('.home')
  ) {
    throw new UnsafeUrlError(
      'Endereços locais, internos ou de rede privada não são permitidos por segurança.'
    );
  }

  if (net.isIP(host) !== 0 && isPrivateOrReservedIp(host)) {
    throw new UnsafeUrlError(
      'IPs privados, de loopback ou reservados não são permitidos por segurança.'
    );
  }

  if (looksLikeSefazUrl(trimmed)) {
    throw new RecipeFetchError(
      'Este link parece ser uma Nota Fiscal (NFC-e / SEFAZ), e não uma receita. Envie a foto do QR Code no chat ou use /api/receipts.',
      422
    );
  }

  return parsed;
}

async function assertHostnameResolvesPublic(hostname: string): Promise<void> {
  const cleanHost = hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(cleanHost) !== 0) {
    if (isPrivateOrReservedIp(cleanHost)) {
      throw new UnsafeUrlError('Destino bloqueado por política anti-SSRF (IP privado).');
    }
    return;
  }

  let records: Array<{ address: string; family: number }>;
  try {
    records = await dns.lookup(cleanHost, { all: true, verbatim: true });
  } catch {
    throw new RecipeFetchError(
      `Não foi possível resolver o domínio "${cleanHost}". Verifique se o link está correto.`,
      422
    );
  }

  if (!records || records.length === 0) {
    throw new RecipeFetchError(`Domínio "${cleanHost}" não retornou endereço público.`, 422);
  }

  for (const rec of records) {
    if (isPrivateOrReservedIp(rec.address)) {
      throw new UnsafeUrlError(
        'O domínio informado resolve para um IP interno/privado e foi bloqueado por segurança.'
      );
    }
  }
}

/**
 * Baixa HTML público de uma URL de receita com validação anti-SSRF em cada redirect,
 * timeout estrito, verificação de Content-Type e limite de tamanho em streaming (anti-DoS).
 */
export async function safeFetchPublicHtml(
  rawUrl: string,
  options?: {
    timeoutMs?: number;
    maxBytes?: number;
    maxRedirects?: number;
  }
): Promise<{ finalUrl: string; html: string; contentType: string }> {
  const timeoutMs = options?.timeoutMs ?? 10000;
  const maxBytes = options?.maxBytes ?? 2 * 1024 * 1024; // 2 MB hard cap
  const maxRedirects = options?.maxRedirects ?? 3;

  let currentUrl = validatePublicRecipeUrl(rawUrl).toString();
  const startedAt = Date.now();

  for (let hop = 0; hop <= maxRedirects; hop++) {
    const parsed = validatePublicRecipeUrl(currentUrl);
    await assertHostnameResolvesPublic(parsed.hostname);

    const remainingMs = Math.max(1500, timeoutMs - (Date.now() - startedAt));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), remainingMs);

    let response: Response;
    try {
      response = await fetch(parsed.toString(), {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          'User-Agent':
            'Mozilla/5.0 (compatible; MonetaArgusBot/1.0; +https://github.com/lucasdlg5/ArgusBot)',
          Accept: 'text/html,application/xhtml+xml,application/ld+json,text/plain;q=0.9',
          'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8'
        }
      });
    } catch (err) {
      clearTimeout(timer);
      const isAbort = (err as Error).name === 'AbortError';
      throw new RecipeFetchError(
        isAbort
          ? 'O site demorou demais para responder (timeout de 10s). Tente colar o texto ou enviar um print da receita.'
          : 'Não foi possível acessar o link informado. Verifique a URL ou envie os ingredientes por texto.',
        422
      );
    } finally {
      clearTimeout(timer);
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) {
        throw new RecipeFetchError('O site retornou redirecionamento inválido.', 422);
      }
      if (hop === maxRedirects) {
        throw new RecipeFetchError('Muitos redirecionamentos ao abrir o link da receita.', 422);
      }
      currentUrl = new URL(location, parsed).toString();
      continue;
    }

    if (response.status === 401 || response.status === 403 || response.status === 429) {
      throw new RecipeFetchError(
        'Este site bloqueou a leitura automática (proteção anti-bot/login). Copie e cole os ingredientes por texto ou envie um print da página!',
        422
      );
    }

    if (!response.ok) {
      throw new RecipeFetchError(
        `O site retornou erro HTTP ${response.status}. Verifique se o link da receita está acessível.`,
        422
      );
    }

    const contentType = (response.headers.get('content-type') || 'text/html').toLowerCase();
    const allowedType =
      contentType.includes('text/html') ||
      contentType.includes('application/xhtml+xml') ||
      contentType.includes('text/plain') ||
      contentType.includes('application/ld+json') ||
      contentType.includes('application/json');

    if (!allowedType) {
      throw new RecipeFetchError(
        `Tipo de conteúdo não suportado (${contentType.split(';')[0]}). Envie o link de uma página web ou mande uma imagem/print da receita.`,
        422
      );
    }

    const contentLengthHeader = Number(response.headers.get('content-length') || '0');
    if (contentLengthHeader > maxBytes) {
      throw new RecipeFetchError(
        'A página informada excede o limite máximo permitido (2 MB).',
        422
      );
    }

    const reader = response.body?.getReader();
    if (!reader) {
      const text = await response.text();
      if (Buffer.byteLength(text, 'utf8') > maxBytes) {
        throw new RecipeFetchError('A página informada excede o limite de 2 MB.', 422);
      }
      return { finalUrl: parsed.toString(), html: text, contentType };
    }

    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        totalBytes += value.byteLength;
        if (totalBytes > maxBytes) {
          await reader.cancel().catch(() => {});
          throw new RecipeFetchError(
            'A página excedeu o limite máximo de 2 MB durante o download.',
            422
          );
        }
        chunks.push(value);
      }
    }

    const html = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
    return {
      finalUrl: parsed.toString(),
      html,
      contentType
    };
  }

  throw new RecipeFetchError('Não foi possível concluir o acesso ao link informado.', 422);
}
