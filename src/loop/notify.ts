/**
 * Pulling the operator in, only when something new needs them.
 *
 * Two transitions notify: the Needs-you set going from empty to non-empty, and a
 * fault the loop has not reported before. Anything else — an item that was
 * already waiting, one that cleared, a fault seen again — sends nothing, so a
 * message always means "look now".
 */

export interface Transition {
  /** Why this pass notifies, in one line; absent when it does not. */
  reason?: string;
  /** The Needs-you refs to remember for the next pass. */
  remember: string[];
}

export interface NewFault {
  issue: number;
  title: string;
}

/**
 * Decide whether a pass notifies. `previous` is what the last pass remembered.
 * A fault announced in this pass is remembered as already waiting, so its issue
 * appearing in Needs-you on the next pass is not a second transition.
 */
export function transition(previous: string[] | undefined, now: string[], newFaults: NewFault[]): Transition {
  const remember = [...new Set([...now, ...newFaults.map((f) => `#${f.issue}`)])].sort();
  if (newFaults.length > 0) {
    return { reason: `new fault: ${newFaults.map((f) => `#${f.issue} ${f.title}`).join('; ')}`, remember };
  }
  if ((previous ?? []).length === 0 && now.length > 0) {
    return { reason: `${now.length} item(s) now need you: ${now.join(', ')}`, remember };
  }
  return { remember };
}

export interface Messenger {
  send(text: string): Promise<void>;
}

type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

/**
 * Telegram's Bot API `sendMessage`, with the bot token and chat id from the
 * environment. Sending does not compete with a gateway polling the same bot:
 * only a second `getUpdates` consumer would. The token never leaves the request
 * URL — not into an error, not into a log line.
 */
export function telegramFromEnv(env: Record<string, string | undefined>, fetchImpl: Fetch = fetch as unknown as Fetch): Messenger | { skipped: string } {
  const token = env['TELEGRAM_BOT_TOKEN'];
  const chat = env['TELEGRAM_CHAT_ID'];
  if (!token) return { skipped: 'no token' };
  if (!chat) return { skipped: 'no chat id' };
  return {
    async send(text: string): Promise<void> {
      const response = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true }),
      });
      if (!response.ok) {
        const detail = (await response.text().catch(() => '')).replaceAll(token, '<token>').slice(0, 300);
        throw new Error(`Telegram answered ${response.status}${detail ? `: ${detail}` : ''}`);
      }
    },
  };
}

/** The message: what needs the operator and where the loop's status lives. */
export function renderMessage(repo: string, reason: string, tracking: number | undefined): string {
  return [
    `${repo}: ${reason}`,
    tracking !== undefined ? `Status: https://github.com/${repo}/issues/${tracking}` : 'Status: agentsys console',
  ].join('\n');
}
