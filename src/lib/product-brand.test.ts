import { describe, it, expect } from 'vitest';
import { extractBrandFromDescription, matchesProductSearch } from './product-brand';
import type { ScannedProductEntry } from '../types/argus';

describe('product-brand — Extração de Marca & Filtro de Produtos Escaneados', () => {
  it('identifica marcas conhecidas no varejo brasileiro ignorando acentos e caixa', () => {
    expect(
      extractBrandFromDescription('ARROZ AGULHINHA TIO JOAO TP1 5KG', 'Arroz Agulhinha Tipo 1 (5kg)')
    ).toBe('Tio João');

    expect(
      extractBrandFromDescription('CAFE PILAO TRADICIONAL ALMOFADA 500G', 'Café Torrado e Moído (500g)')
    ).toBe('Pilão');

    expect(
      extractBrandFromDescription('LEITE INTEGRAL ITALAC TP 1L', 'Leite Integral (1L)')
    ).toBe('Italac');
  });

  it('filtra itens escaneados combinando nome, marca, local e descrição original', () => {
    const entry: ScannedProductEntry = {
      id: 'item-1',
      observedAt: '2026-11-10T14:30:00.000Z',
      sourceKind: 'RECEIPT_ITEM',
      storeId: 'st-souza',
      storeName: 'Mercado Souza',
      storeLocation: 'Av. Siqueira Campos, 120 - Jacareí/SP',
      rawDescription: 'FEIJAO CARIOCA CAMIL 1KG',
      brandName: 'Camil',
      canonicalProductId: 'cp-1',
      canonicalProductName: 'Feijão Carioca Tipo 1 (1kg)',
      category: 'Mercearia',
      baseUnit: 'g',
      standardPackageSize: 1000,
      isEssential: true,
      quantity: 1,
      unitType: 'PCT',
      unitPrice: 8.49,
      totalPrice: 8.49,
      promoPrice: null,
      normalizedPricePerBaseUnit: 0.00849,
      normalizedPackagePrice: 8.49,
      confidenceScorePct: 100,
      paymentMethod: 'PIX',
      missingInfoFlags: []
    };

    expect(matchesProductSearch(entry, '')).toBe(true);
    expect(matchesProductSearch(entry, 'camil souza')).toBe(true);
    expect(matchesProductSearch(entry, 'feijao jacarei')).toBe(true);
    expect(matchesProductSearch(entry, 'sadia')).toBe(false);
  });
});
