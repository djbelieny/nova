/**
 * Event-Driven Webhook Ingestion Server
 *
 * Exposes POST /webhook/:userId/:webhookId for external event sources:
 * GHL contact updates, Stripe payments, form submissions, custom triggers.
 *
 * Security: HMAC-SHA256 signature verification via X-Nova-Signature header.
 * Template: Handlebars-style {{field}} substitution from request body.
 *
 * Usage:
 *   1. User creates a trigger: /webhook create ghl-contact ghl helios "Follow up with {{contact.name}} who just opted in via {{form_name}}"
 *   2. Webhook URL: https://nova.07labs.com/webhook/:userId/:webhookId
 *   3. GHL sends POST with JSON body + X-Nova-Signature: sha256=<hmac>
 *   4. Nova verifies signature, renders template, dispatches agent pipeline
 */

import { createHmac } from "crypto";
import type { Database } from "./db.ts";
import { emit } from "./events.ts";

export type WebhookDispatchFn = (
  userId: string,
  agentSlug: string,
  taskDescription: string,
  metadata?: Record<string, any>
) => Promise<string | null>;

/**
 * Render a Handlebars-style template string with values from a nested object.
 * Supports dot notation: {{contact.name}}, {{event.type}}, etc.
 */
function renderTemplate(template: string, data: Record<string, any>): string {
  return template.replace(/\{\{([\w.]+)\}\}/g, (match, path) => {
    const parts = path.split(".");
    let value: any = data;
    for (const part of parts) {
      if (value === null || value === undefined) return match;
      value = value[part];
    }
    if (value === null || value === undefined) return match;
    return String(value);
  });
}

/**
 * Verify HMAC-SHA256 signature from X-Nova-Signature header.
 */
function verifySignature(body: string, secret: string, signatureHeader: string | null): boolean {
  if (!signatureHeader) return false;
  const expected = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  // Constant-time comparison
  if (expected.length !== signatureHeader.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ signatureHeader.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Generate a random webhook secret.
 */
export function generateWebhookSecret(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Start the webhook ingestion server on the given port.
 */
export function startWebhookServer(
  port: number,
  db: Database,
  dispatch: WebhookDispatchFn
): void {
  Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url);
      const pathParts = url.pathname.split("/").filter(Boolean);

      // POST /webhook/:userId/:webhookId
      if (req.method === "POST" && pathParts[0] === "webhook" && pathParts.length >= 3) {
        const userId = pathParts[1];
        const webhookId = pathParts[2];

        // Load trigger
        const trigger = db.getWebhookTrigger(userId, webhookId);
        if (!trigger) {
          return new Response(JSON.stringify({ error: "webhook not found" }), {
            status: 404,
            headers: { "Content-Type": "application/json" },
          });
        }

        // Read body as text for signature verification
        const bodyText = await req.text();
        const signatureHeader = req.headers.get("X-Nova-Signature") || req.headers.get("x-nova-signature");

        // Verify signature (skip if secret is empty — insecure but allowed for testing)
        if (trigger.secret && !verifySignature(bodyText, trigger.secret, signatureHeader)) {
          emit({ type: "webhook.triggered", level: "warn", userId, data: { message: `Webhook signature verification failed for ${trigger.name}`, webhookId, module: "webhook" } });
          return new Response(JSON.stringify({ error: "invalid signature" }), {
            status: 401,
            headers: { "Content-Type": "application/json" },
          });
        }

        // Parse body
        let body: Record<string, any> = {};
        try {
          body = JSON.parse(bodyText);
        } catch {
          // Non-JSON body — treat as empty context
        }

        // Parse pipeline config
        let pipeline: { agentSlug: string; taskTemplate: string } = { agentSlug: "general", taskTemplate: "" };
        try {
          pipeline = JSON.parse(trigger.pipeline);
        } catch {
          pipeline.taskTemplate = trigger.pipeline; // treat raw string as template
        }

        // Render task template
        const taskDescription = renderTemplate(pipeline.taskTemplate || trigger.pipeline, body);

        // Dispatch pipeline (fire and forget — return 200 immediately)
        const taskId = await dispatch(userId, pipeline.agentSlug || "general", taskDescription, { webhook_id: webhookId, source: trigger.source }).catch(() => null);

        // Log the trigger
        try {
          db.recordWebhookFire(webhookId);
          db.insertWebhookLog({
            webhook_id: webhookId,
            user_id: userId,
            source: trigger.source,
            payload: bodyText.slice(0, 1000),
            pipeline_triggered: taskDescription.slice(0, 500),
            task_id: taskId || null,
            status: "ok",
          });
        } catch {}

        emit({ type: "webhook.triggered", level: "info", userId, data: { message: `Webhook fired: ${trigger.name} → ${pipeline.agentSlug}`, webhookId, source: trigger.source, taskId, module: "webhook" } });

        return new Response(JSON.stringify({ status: "ok", task_id: taskId }), {
          headers: { "Content-Type": "application/json" },
        });
      }

      // GET /webhook/:userId/:webhookId/test — last 5 trigger logs
      if (req.method === "GET" && pathParts[0] === "webhook" && pathParts.length >= 4 && pathParts[3] === "test") {
        const userId = pathParts[1];
        const webhookId = pathParts[2];
        const trigger = db.getWebhookTrigger(userId, webhookId);
        if (!trigger) return new Response("Not found", { status: 404 });
        return new Response(JSON.stringify({
          trigger: { id: trigger.id, name: trigger.name, source: trigger.source, trigger_count: trigger.trigger_count, last_triggered_at: trigger.last_triggered_at },
        }), { headers: { "Content-Type": "application/json" } });
      }

      // Health check
      if (req.method === "GET" && url.pathname === "/health") {
        return new Response(JSON.stringify({ status: "ok", service: "nova-webhooks" }), {
          headers: { "Content-Type": "application/json" },
        });
      }

      return new Response("Not found", { status: 404 });
    },
  });

  emit({ type: "system.health", level: "info", data: { message: `Webhook server started on port ${port}`, module: "webhook" } });
  console.log(`[webhook] Server started on port ${port}`);
}
