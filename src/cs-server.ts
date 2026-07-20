/**
 * CS Widget Server — HTTP + WebSocket server for the embeddable web chat widget.
 *
 * Endpoints:
 *   GET  /cs-widget.js         → serves the embeddable widget script
 *   GET  /cs/meta/webhook      → Meta webhook verification
 *   POST /cs/meta/webhook      → Meta webhook processing
 *   GET  /cs/chat              → WebSocket upgrade for chat
 *   GET  /cs/health            → liveness probe
 *   OPTIONS *                  → CORS preflight
 *
 * Hard wall: MUST NOT import from relay.ts, orchestrator.ts, or memory.ts.
 */

import { join, dirname } from 'path';
import { readFileSync } from 'fs';
import type { ServerWebSocket } from 'bun';
import { handleCsMessage, sendGreeting } from './cs-orchestrator';
import { verifyMetaWebhook, processMetaWebhook } from './channels/meta';
import { logError } from './error-handler';

const PROJECT_ROOT = dirname(dirname(import.meta.path));
const WIDGET_JS_PATH = join(PROJECT_ROOT, 'public', 'cs-widget.js');

interface WsData {
  sessionId: string;
  notifyOwner: (text: string) => Promise<void>;
}

/**
 * Start the CS HTTP + WebSocket server.
 */
export function startCsWebSocketServer(
  notifyOwner: (text: string) => Promise<void>
): void {
  const port = Number(process.env.CS_WIDGET_PORT ?? 3001);

  Bun.serve<WsData>({
    port,

    async fetch(req, server) {
      const url = new URL(req.url);
      const path = url.pathname;

      // CORS preflight
      if (req.method === 'OPTIONS') {
        return new Response(null, {
          headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
          },
        });
      }

      // Widget script
      if (req.method === 'GET' && path === '/cs-widget.js') {
        try {
          const js = readFileSync(WIDGET_JS_PATH, 'utf8');
          return new Response(js, {
            headers: {
              'Content-Type': 'application/javascript',
              'Cache-Control': 'public, max-age=60',
              'Access-Control-Allow-Origin': '*',
            },
          });
        } catch {
          return new Response('// widget not found', { status: 404 });
        }
      }

      // Meta webhook verification
      if (req.method === 'GET' && path === '/cs/meta/webhook') {
        return verifyMetaWebhook(url);
      }

      // Meta webhook processing
      if (req.method === 'POST' && path === '/cs/meta/webhook') {
        try {
          const body = await req.json();
          processMetaWebhook(body, notifyOwner).catch(err =>
            logError(err, 'cs-server.meta-webhook')
          );
          return new Response('EVENT_RECEIVED', { status: 200 });
        } catch {
          return new Response('Bad Request', { status: 400 });
        }
      }

      // WebSocket upgrade for chat widget
      if (req.method === 'GET' && path === '/cs/chat') {
        const sessionId =
          url.searchParams.get('sessionId') ||
          `ws-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const upgraded = server.upgrade(req, { data: { sessionId, notifyOwner } });
        if (upgraded) return undefined as unknown as Response;
        return new Response('WebSocket required', { status: 426 });
      }

      // Health check
      if (req.method === 'GET' && path === '/cs/health') {
        return new Response(JSON.stringify({ ok: true, service: 'cs-server' }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      return new Response('Not Found', { status: 404 });
    },

    websocket: {
      async open(ws: ServerWebSocket<WsData>) {
        const { sessionId, notifyOwner: wsNotify } = ws.data;
        console.log(`[cs-server] WS connected: ${sessionId}`);
        await sendGreeting('web', sessionId, async (text) => {
          ws.send(JSON.stringify({ type: 'message', role: 'agent', text }));
        }).catch(err => logError(err, 'cs-server.ws.open', sessionId));
      },

      async message(ws: ServerWebSocket<WsData>, rawMsg: string | Buffer) {
        try {
          const text = typeof rawMsg === 'string' ? rawMsg : rawMsg.toString('utf8');
          const { sessionId, notifyOwner: wsNotify } = ws.data;

          // Accept either plain text or JSON { text: string }
          let msgText = text;
          try {
            const parsed = JSON.parse(text) as { text?: string };
            if (parsed.text) msgText = parsed.text;
          } catch {
            // plain text — use as-is
          }

          if (!msgText.trim()) return;

          const sendToCustomer = async (reply: string) => {
            ws.send(JSON.stringify({ type: 'message', role: 'agent', text: reply }));
          };

          await handleCsMessage(
            'web',
            sessionId,
            msgText,
            undefined,
            sendToCustomer,
            wsNotify
          );
        } catch (err) {
          logError(err, 'cs-server.ws.message');
          ws.send(JSON.stringify({ type: 'error', text: 'Something went wrong. Please try again.' }));
        }
      },

      close(ws: ServerWebSocket<WsData>) {
        console.log(`[cs-server] WS disconnected: ${ws.data.sessionId}`);
      },
    },
  });

  console.log(`[cs-server] CS widget server listening on port ${port}`);
}
