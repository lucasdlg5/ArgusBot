import { NextResponse } from 'next/server';
import { env } from '@/config/env';

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      chatId?: string;
      messageText: string;
    };

    const token = env.TELEGRAM_BOT_TOKEN;
    const chatId = body.chatId || env.TELEGRAM_DEFAULT_CHAT_ID;

    if (!token || !chatId) {
      return NextResponse.json({
        status: 'simulated',
        deliveredOnline: false,
        botHandle: '@MonetaArgusBot',
        previewMessage: body.messageText,
        note: 'Lista formatada pelo Argus pronta! Configure TELEGRAM_BOT_TOKEN e TELEGRAM_DEFAULT_CHAT_ID no .env para disparo direto no celular.'
      });
    }

    const tgRes = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: body.messageText,
        parse_mode: 'Markdown'
      })
    });

    const tgJson = (await tgRes.json()) as { ok?: boolean; description?: string };
    return NextResponse.json({
      status: tgJson.ok ? 'ok' : 'simulated',
      deliveredOnline: Boolean(tgJson.ok),
      botHandle: '@MonetaArgusBot',
      previewMessage: body.messageText,
      note: tgJson.ok
        ? 'Lista enviada diretamente para o seu Telegram via @MonetaArgusBot!'
        : `Simulado localmente (${tgJson.description || 'chat_id pendente'})`
    });
  } catch (err) {
    return NextResponse.json(
      { status: 'error', message: (err as Error).message },
      { status: 500 }
    );
  }
}
