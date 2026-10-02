/** Доступ к Mailpit через его REST API: сколько писем реально дошло до почтового сервера. */
const mailpitUrl = () => process.env.MAILPIT_API_URL ?? 'http://localhost:8025';

export interface MailpitMessage {
  ID: string;
  MessageID: string;
  Subject: string;
  To: { Address: string }[];
}

export async function mailsTo(address: string): Promise<MailpitMessage[]> {
  const res = await fetch(`${mailpitUrl()}/api/v1/search?query=${encodeURIComponent(`to:${address}`)}&limit=100`);
  if (!res.ok) throw new Error(`mailpit search failed: ${res.status}`);
  return ((await res.json()) as { messages: MailpitMessage[] }).messages;
}

/** Уникальный адрес на тест: тесты не чистят общий Mailpit и не мешают демо-письмам. */
export function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}@example.com`;
}
