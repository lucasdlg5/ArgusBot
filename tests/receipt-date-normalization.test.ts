import { describe, expect, it } from 'vitest';
import { ArgusReceiptProcessor } from '../src/services/ArgusReceiptProcessor';

describe('ArgusReceiptProcessor.normalizeReceiptDate', () => {
  const processor = new ArgusReceiptProcessor();

  it('parses ISO YYYY-MM-DDTHH:mm:ss without misreading 26-09-12 as DD-MM-YY', () => {
    const iso = processor.normalizeReceiptDate('2026-09-12T17:38:36');
    expect(iso).toBe('2026-09-12T20:38:36.000Z');
  });

  it('parses ISO date-only YYYY-MM-DD correctly (no 2003/2018 corruption)', () => {
    expect(processor.normalizeReceiptDate('2026-07-03')).toBe('2026-07-03T15:00:00.000Z');
    expect(processor.normalizeReceiptDate('2026-11-18')).toBe('2026-11-18T15:00:00.000Z');
  });

  it('parses Brazilian DD/MM/YY HH:mm:ss from printed receipt', () => {
    const iso = processor.normalizeReceiptDate('12/09/26 17:38:36');
    expect(iso).toBe('2026-09-12T20:38:36.000Z');
  });

  it('parses Brazilian DD/MM/YYYY HH:mm:ss from printed receipt', () => {
    const iso = processor.normalizeReceiptDate('12/09/2026 17:38:36');
    expect(iso).toBe('2026-09-12T20:38:36.000Z');
  });

  it('uses SEFAZ 44-digit key AAMM to correct OCR year/month mismatch', () => {
    // Posições 2..5 = "2607" -> Julho/2026
    const sefazKey = '35260717316876000144650010000012341000012345';
    const iso = processor.normalizeReceiptDate('14/08/2024 18:10:00', sefazKey);
    expect(iso.startsWith('2026-07-14T')).toBe(true);
  });
});
