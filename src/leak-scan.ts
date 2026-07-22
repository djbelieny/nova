/**
 * Egress leak detector. Finds secrets (API keys, private keys, Nova ciphertext) and PII
 * (SSN, Luhn-valid cards, email) in outbound text. Severity-scoped so wiring can redact/block
 * secrets aggressively while treating PII gently. Pure + total (never throws); on any internal
 * error a detector yields no finding rather than crashing a reply.
 */
export type LeakSeverity = "secret" | "pii";
export interface LeakFinding { type: string; severity: LeakSeverity; redacted: string; index: number; }

interface Detector { type: string; severity: LeakSeverity; re: RegExp; validate?: (m: string) => boolean; }

// Luhn check to kill the false positives the bare 13-16 digit card regex causes.
function luhnValid(s: string): boolean {
  const d = s.replace(/[^\d]/g, "");
  if (d.length < 13 || d.length > 19) return false;
  let sum = 0, alt = false;
  for (let i = d.length - 1; i >= 0; i--) {
    let n = d.charCodeAt(i) - 48;
    if (alt) { n *= 2; if (n > 9) n -= 9; }
    sum += n; alt = !alt;
  }
  return sum % 10 === 0;
}

const DETECTORS: Detector[] = [
  { type: "anthropic-key", severity: "secret", re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { type: "openai-key", severity: "secret", re: /\bsk-(?:proj-)?[A-Za-z0-9]{20,}\b/g },
  { type: "aws-access-key", severity: "secret", re: /\bAKIA[0-9A-Z]{16}\b/g },
  { type: "github-token", severity: "secret", re: /\bgh[pousr]_[A-Za-z0-9]{16,}\b/g },
  { type: "slack-token", severity: "secret", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { type: "google-api-key", severity: "secret", re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { type: "gitlab-token", severity: "secret", re: /\bglpat-[A-Za-z0-9_-]{20,}\b/g },
  { type: "sendgrid-key", severity: "secret", re: /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/g },
  { type: "stripe-key", severity: "secret", re: /\b[rs]k_live_[A-Za-z0-9]{16,}\b/g },
  { type: "twilio-key", severity: "secret", re: /\bSK[0-9a-fA-F]{32}\b/g },
  { type: "private-key", severity: "secret", re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/g },
  { type: "nova-ciphertext", severity: "secret", re: /\benc:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+/g },
  { type: "jwt", severity: "secret", re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  {
    type: "env-assignment", severity: "secret",
    re: /\b[A-Z][A-Z0-9_]{2,}=(?=[A-Za-z0-9+/_-]{20,})[A-Za-z0-9+/_-]{20,}\b/g,
    validate: (m) => { const val = m.slice(m.indexOf("=") + 1); return !/^[A-Z0-9_]+$/.test(val); },
  },
  { type: "url-credentials", severity: "secret", re: /\b[a-z][a-z0-9+.\-]*:\/\/[^/\s:@]+:[^/\s@]{4,}@/gi },
  { type: "keyworded-secret", severity: "secret", re: /\b(?:password|passwd|pwd|secret|token|api[-_]?key|apikey|access[-_]?key|auth[-_]?token|client[-_]?secret)["']?\s*[:=]\s*["']?[A-Za-z0-9._/+=-]{8,}/gi },
  { type: "google-oauth", severity: "secret", re: /\bya29\.[A-Za-z0-9._-]{20,}\b/g },
  { type: "bearer-token", severity: "secret", re: /\bBearer\s+[A-Za-z0-9._-]{20,}\b/g },
  { type: "ssn", severity: "pii", re: /\b\d{3}-\d{2}-\d{4}\b/g },
  { type: "credit-card", severity: "pii", re: /\b(?:\d[ -]?){13,19}\b/g, validate: luhnValid },
  { type: "email", severity: "pii", re: /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g },
];

function allowSet(): Set<string> {
  return new Set((process.env.NOVA_LEAK_ALLOW || "").split(",").map((s) => s.trim()).filter(Boolean));
}

function mask(type: string): string { return `‹redacted:${type}›`; }

export function scanForLeaks(text: string): LeakFinding[] {
  if (!text) return [];
  const allow = allowSet();
  const findings: LeakFinding[] = [];
  for (const d of DETECTORS) {
    try {
      for (const m of text.matchAll(d.re)) {
        const val = m[0];
        if (allow.has(val)) continue;
        if (d.validate && !d.validate(val)) continue;
        findings.push({ type: d.type, severity: d.severity, redacted: mask(d.type), index: m.index ?? 0 });
      }
    } catch { /* a detector never breaks the scan */ }
  }
  return findings;
}

export function redactLeaks(text: string, opts: { severities?: LeakSeverity[] } = {}): { text: string; findings: LeakFinding[] } {
  if (!text) return { text, findings: [] };
  const sev = new Set(opts.severities ?? ["secret", "pii"]);
  const findings = scanForLeaks(text).filter((f) => sev.has(f.severity));
  if (!findings.length) return { text, findings: [] };
  let out = text;
  for (const d of DETECTORS) {
    if (!sev.has(d.severity)) continue;
    try {
      out = out.replace(d.re, (m) => {
        if (allowSet().has(m)) return m;
        if (d.validate && !d.validate(m)) return m;
        return mask(d.type);
      });
    } catch { /* skip */ }
  }
  return { text: out, findings };
}
