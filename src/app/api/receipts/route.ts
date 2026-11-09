import { NextResponse } from 'next/server';
import { ArgusReceiptProcessor, type ExtractedReceiptData } from '@/services/ArgusReceiptProcessor';

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      qrUrl?: string;
      receipt?: ExtractedReceiptData;
    };

    const processor = new ArgusReceiptProcessor();

    if (body.qrUrl) {
      const scraped = await processor.scrapeSefazReceipt(body.qrUrl);
      if (!scraped) {
        return NextResponse.json(
          { status: 'error', message: 'Não foi possível extrair a NFC-e via URL SEFAZ informada.' },
          { status: 422 }
        );
      }
      const ingested = await processor.ingestReceipt(scraped);
      return NextResponse.json({ status: 'ok', extracted: scraped, ingested });
    }

    if (body.receipt) {
      const ingested = await processor.ingestReceipt(body.receipt);
      return NextResponse.json({ status: 'ok', extracted: body.receipt, ingested });
    }

    return NextResponse.json(
      { status: 'error', message: 'Envie `qrUrl` ou `receipt` estruturado.' },
      { status: 400 }
    );
  } catch (err) {
    return NextResponse.json(
      { status: 'error', message: (err as Error).message },
      { status: 500 }
    );
  }
}
