/**
 * CS Router — entry point that starts all CS channel adapters.
 *
 * Wires the notifyOwner callback to every public-facing CS channel:
 *   - Public Telegram CS bot (CS_TELEGRAM_BOT_TOKEN, optional)
 *   - Web widget + Meta webhook server (always started)
 *
 * Hard wall: MUST NOT import from relay.ts, orchestrator.ts, or memory.ts.
 */

import { startCsTelegramBot } from './channels/cs-telegram';
import { startCsWebSocketServer } from './cs-server';
import { logError } from './error-handler';

export function startCsRouter(notifyOwner: (text: string) => Promise<void>): void {
  // Start public Telegram CS bot (only if token configured)
  if (process.env.CS_TELEGRAM_BOT_TOKEN) {
    try {
      startCsTelegramBot(notifyOwner);
      console.log('[cs-router] Public Telegram CS bot started');
    } catch (err) {
      logError(err, 'cs-router-telegram');
    }
  }

  // Start web widget server + Meta webhook handler
  try {
    startCsWebSocketServer(notifyOwner);
    console.log('[cs-router] Web widget + Meta webhook server started');
  } catch (err) {
    logError(err, 'cs-router-web');
  }

  console.log('[cs-router] CS/SDR mode active');
}
