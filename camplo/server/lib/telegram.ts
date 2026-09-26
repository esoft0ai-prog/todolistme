/** Telegram Bot API over fetch. Delivery failures are reported to the caller (email fallback). */
export async function telegramCall(token: string, method: string, body: Record<string, unknown>): Promise<{ ok: boolean; result?: any; description?: string }> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    });
    return (await res.json()) as { ok: boolean; result?: any; description?: string };
  } catch (e) {
    return { ok: false, description: (e as Error).message };
  }
}

export async function verifyBot(token: string): Promise<{ ok: boolean; username?: string }> {
  const r = await telegramCall(token, 'getMe', {});
  return r.ok ? { ok: true, username: r.result?.username } : { ok: false };
}

/** SLA alert with an inline "Acknowledge" button. callback_data is HMAC-signed by the caller. */
export async function sendAckMessage(token: string, chatId: string, text: string, callbackData: string) {
  return telegramCall(token, 'sendMessage', {
    chat_id: chatId, text,
    reply_markup: { inline_keyboard: [[{ text: 'Acknowledge', callback_data: callbackData }]] },
  });
}
