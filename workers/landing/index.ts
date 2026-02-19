export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    let html: string;
    if (path === "/google447810c2e4246e67.html") {
      return new Response("google-site-verification: google447810c2e4246e67.html", {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    } else if (path === "/privacy" || path === "/privacy/") {
      html = privacyPage();
    } else if (path === "/terms" || path === "/terms/") {
      html = termsPage();
    } else {
      html = landingPage();
    }

    return new Response(html, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  },
};

function shell(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title} — Nova Agent IA</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  :root{--bg:#0a0a0f;--surface:#12121a;--border:#1e1e2e;--text:#e4e4ed;--muted:#8888a0;--accent:#6c5ce7;--accent2:#a855f7;--glow:rgba(108,92,231,0.15)}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:var(--bg);color:var(--text);line-height:1.7;min-height:100vh}
  a{color:var(--accent2);text-decoration:none}a:hover{text-decoration:underline}
  .container{max-width:800px;margin:0 auto;padding:2rem 1.5rem}

  /* Landing */
  .hero{text-align:center;padding:6rem 1rem 3rem}
  .logo{font-size:3.5rem;font-weight:800;background:linear-gradient(135deg,var(--accent),var(--accent2));-webkit-background-clip:text;-webkit-text-fill-color:transparent;letter-spacing:-1px}
  .tagline{font-size:1.25rem;color:var(--muted);margin-top:0.75rem;max-width:500px;margin-left:auto;margin-right:auto}
  .features{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:1.5rem;margin:3rem 0}
  .card{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:1.5rem;transition:border-color 0.2s}
  .card:hover{border-color:var(--accent)}
  .card h3{font-size:1rem;margin-bottom:0.5rem;display:flex;align-items:center;gap:0.5rem}
  .card p{font-size:0.875rem;color:var(--muted)}
  .section{margin:3rem 0}
  .section h2{font-size:1.5rem;margin-bottom:1rem;font-weight:700}
  .section p{color:var(--muted);margin-bottom:1rem}
  footer{text-align:center;padding:3rem 1rem;color:var(--muted);font-size:0.8rem;border-top:1px solid var(--border);margin-top:4rem}
  footer a{color:var(--muted)}footer a:hover{color:var(--text)}
  .footer-links{display:flex;justify-content:center;gap:2rem;margin-bottom:0.75rem}

  /* Legal pages */
  .legal{padding:3rem 0}
  .legal h1{font-size:2rem;margin-bottom:0.5rem;font-weight:800}
  .legal .updated{color:var(--muted);font-size:0.85rem;margin-bottom:2rem}
  .legal h2{font-size:1.2rem;margin:2rem 0 0.75rem;font-weight:700;color:var(--text)}
  .legal p,.legal li{color:var(--muted);margin-bottom:0.75rem;font-size:0.95rem}
  .legal ul{padding-left:1.5rem}
  .legal li{margin-bottom:0.5rem}
  .back{display:inline-block;margin-bottom:2rem;color:var(--muted);font-size:0.9rem}
  .back:hover{color:var(--text)}
</style>
</head>
<body>
${body}
</body>
</html>`;
}

function landingPage(): string {
  return shell("Your Personal AI Assistant", `
<div class="hero">
  <div class="logo">Nova Agent IA</div>
  <p class="tagline">Your personal AI assistant on Telegram — powered by Claude, connected to your world.</p>
</div>

<div class="container">
  <div class="features">
    <div class="card">
      <h3>💬 Telegram Native</h3>
      <p>Chat naturally on Telegram. Voice messages, files, and instant responses wherever you are.</p>
    </div>
    <div class="card">
      <h3>🧠 Persistent Memory</h3>
      <p>Remembers your preferences, goals, and past conversations. Gets smarter over time.</p>
    </div>
    <div class="card">
      <h3>📅 Google Workspace</h3>
      <p>Connects to Gmail, Calendar, Drive, Docs, and Sheets. Manages your schedule and email.</p>
    </div>
    <div class="card">
      <h3>📝 Notion</h3>
      <p>Reads and updates your Notion workspace. Manages tasks, notes, and databases.</p>
    </div>
    <div class="card">
      <h3>📹 Zoom</h3>
      <p>Schedules and manages Zoom meetings. Sends invites and reminders automatically.</p>
    </div>
    <div class="card">
      <h3>🤖 Specialist Agents</h3>
      <p>Routes complex tasks to specialized agents — research, content, finance, strategy, and more.</p>
    </div>
  </div>

  <div class="section">
    <h2>How It Works</h2>
    <p>Nova is a self-hosted AI assistant that lives in your Telegram. It connects to your services through secure OAuth integrations, giving you a single conversational interface for your digital life.</p>
    <p>Your data stays yours. Nova runs on your infrastructure, stores memory in your own Supabase database, and connects to services using your own OAuth credentials. No third-party data sharing.</p>
  </div>

  <div class="section">
    <h2>Integrations</h2>
    <p>Nova uses OAuth 2.0 to securely connect to your accounts. You authorize each service individually through the Mini App, and can disconnect at any time. Nova only requests the minimum permissions needed to assist you.</p>
  </div>

  <footer>
    <div class="footer-links">
      <a href="/privacy">Privacy Policy</a>
      <a href="/terms">Terms of Service</a>
    </div>
    <p>&copy; ${new Date().getFullYear()} Nova Agent IA. All rights reserved.</p>
  </footer>
</div>`);
}

function privacyPage(): string {
  return shell("Privacy Policy", `
<div class="container legal">
  <a href="/" class="back">&larr; Back to home</a>
  <h1>Privacy Policy</h1>
  <p class="updated">Last updated: February 18, 2026</p>

  <h2>1. Introduction</h2>
  <p>Nova Agent IA ("Nova", "we", "us", or "our") is a personal AI assistant application. This Privacy Policy explains how we collect, use, and protect your information when you use our service.</p>

  <h2>2. Information We Collect</h2>
  <p>When you use Nova, we may collect:</p>
  <ul>
    <li><strong>Account information:</strong> Your Telegram user ID, display name, and timezone preference.</li>
    <li><strong>Conversation data:</strong> Messages you send to Nova through Telegram, including text, voice messages, and file attachments.</li>
    <li><strong>Integration tokens:</strong> OAuth access tokens and refresh tokens for services you connect (Google Workspace, Notion, Zoom). These are stored encrypted in your personal database.</li>
    <li><strong>Usage data:</strong> Message timestamps, feature usage patterns, and error logs for service improvement.</li>
  </ul>

  <h2>3. How We Use Your Information</h2>
  <p>Your information is used to:</p>
  <ul>
    <li>Process your messages and provide AI-powered responses.</li>
    <li>Maintain conversation memory and personalization across sessions.</li>
    <li>Connect to third-party services on your behalf (only those you explicitly authorize).</li>
    <li>Improve service reliability and fix technical issues.</li>
  </ul>

  <h2>4. Third-Party Services</h2>
  <p>Nova integrates with the following services through OAuth 2.0:</p>
  <ul>
    <li><strong>Google Workspace:</strong> Gmail, Google Calendar, Google Drive, Google Docs, Google Sheets, Google Slides, Google Chat, and Google Contacts. Nova requests only the permissions necessary to read and manage your data as instructed by you.</li>
    <li><strong>Notion:</strong> Read and update your Notion pages, databases, and blocks.</li>
    <li><strong>Zoom:</strong> Create, update, and manage your Zoom meetings.</li>
  </ul>
  <p>Each integration requires your explicit consent. You can disconnect any service at any time through the Nova Mini App, which immediately revokes our access.</p>

  <h2>5. Data Storage and Security</h2>
  <ul>
    <li>All data is stored in your personal Supabase database instance.</li>
    <li>OAuth tokens are stored with encryption at rest.</li>
    <li>We do not share your data with third parties beyond the services you explicitly connect.</li>
    <li>Conversation data and memory are accessible only to you and your Nova instance.</li>
  </ul>

  <h2>6. Data Retention</h2>
  <p>Your data is retained for as long as you use the service. You can:</p>
  <ul>
    <li>Delete individual conversation history through the Mini App.</li>
    <li>Disconnect integrations to revoke access tokens.</li>
    <li>Request complete data deletion by contacting us.</li>
  </ul>

  <h2>7. Your Rights</h2>
  <p>You have the right to:</p>
  <ul>
    <li>Access the personal data we hold about you.</li>
    <li>Request correction of inaccurate data.</li>
    <li>Request deletion of your data.</li>
    <li>Withdraw consent for any integration at any time.</li>
    <li>Export your data in a portable format.</li>
  </ul>

  <h2>8. Google API Services User Data Policy</h2>
  <p>Nova's use and transfer of information received from Google APIs adheres to the <a href="https://developers.google.com/terms/api-services-user-data-policy" target="_blank">Google API Services User Data Policy</a>, including the Limited Use requirements. We only use Google user data to provide and improve the features you explicitly request. We do not use Google user data for advertising purposes.</p>

  <h2>9. Children's Privacy</h2>
  <p>Nova is not intended for use by individuals under the age of 13. We do not knowingly collect personal information from children.</p>

  <h2>10. Changes to This Policy</h2>
  <p>We may update this Privacy Policy from time to time. We will notify you of any material changes through the Nova Telegram bot.</p>

  <h2>11. Contact Us</h2>
  <p>If you have questions about this Privacy Policy or your data, contact us at:</p>
  <p>Email: <a href="mailto:privacy@1osm.com">privacy@1osm.com</a></p>

  <footer>
    <div class="footer-links">
      <a href="/">Home</a>
      <a href="/terms">Terms of Service</a>
    </div>
    <p>&copy; ${new Date().getFullYear()} Nova Agent IA. All rights reserved.</p>
  </footer>
</div>`);
}

function termsPage(): string {
  return shell("Terms of Service", `
<div class="container legal">
  <a href="/" class="back">&larr; Back to home</a>
  <h1>Terms of Service</h1>
  <p class="updated">Last updated: February 18, 2026</p>

  <h2>1. Acceptance of Terms</h2>
  <p>By using Nova Agent IA ("Nova", "the Service"), you agree to these Terms of Service. If you do not agree, do not use the Service.</p>

  <h2>2. Description of Service</h2>
  <p>Nova is a personal AI assistant accessible through Telegram. It provides conversational AI capabilities, task management, and integrations with third-party services including Google Workspace, Notion, and Zoom.</p>

  <h2>3. User Accounts</h2>
  <ul>
    <li>You must have a valid Telegram account to use Nova.</li>
    <li>You are responsible for maintaining the security of your account and connected integrations.</li>
    <li>You must not share your Nova access with unauthorized individuals.</li>
    <li>You must be at least 13 years old to use the Service.</li>
  </ul>

  <h2>4. Acceptable Use</h2>
  <p>You agree not to use Nova to:</p>
  <ul>
    <li>Violate any applicable laws or regulations.</li>
    <li>Send spam, harassment, or abusive content.</li>
    <li>Attempt to gain unauthorized access to systems or data.</li>
    <li>Use the Service for any illegal or harmful purpose.</li>
    <li>Reverse engineer, decompile, or disassemble the Service.</li>
  </ul>

  <h2>5. Third-Party Integrations</h2>
  <p>Nova connects to third-party services on your behalf. By authorizing an integration:</p>
  <ul>
    <li>You grant Nova permission to access and manage data in that service as instructed by you.</li>
    <li>You acknowledge that third-party services have their own terms and privacy policies.</li>
    <li>You can revoke access to any integration at any time through the Mini App.</li>
    <li>Nova is not responsible for the availability or functionality of third-party services.</li>
  </ul>

  <h2>6. AI-Generated Content</h2>
  <p>Nova uses AI models to generate responses and perform tasks. You acknowledge that:</p>
  <ul>
    <li>AI-generated content may not always be accurate, complete, or appropriate.</li>
    <li>You are responsible for reviewing and verifying AI-generated content before acting on it.</li>
    <li>Nova may decline requests that violate safety guidelines.</li>
  </ul>

  <h2>7. Data and Privacy</h2>
  <p>Your use of Nova is also governed by our <a href="/privacy">Privacy Policy</a>. By using the Service, you consent to the collection and use of data as described in the Privacy Policy.</p>

  <h2>8. Intellectual Property</h2>
  <p>The Service, including its design, code, and branding, is the property of Nova Agent IA. You retain ownership of all content you create or provide through the Service.</p>

  <h2>9. Limitation of Liability</h2>
  <p>To the maximum extent permitted by law:</p>
  <ul>
    <li>The Service is provided "as is" without warranties of any kind.</li>
    <li>We are not liable for any indirect, incidental, or consequential damages.</li>
    <li>We are not responsible for actions taken by the AI assistant on your behalf.</li>
    <li>Our total liability shall not exceed the amount you paid for the Service in the past 12 months.</li>
  </ul>

  <h2>10. Termination</h2>
  <p>We may suspend or terminate your access to Nova at any time for violation of these Terms. You may stop using the Service at any time. Upon termination, your data will be handled in accordance with our Privacy Policy.</p>

  <h2>11. Changes to Terms</h2>
  <p>We may update these Terms from time to time. Continued use of the Service after changes constitutes acceptance of the new Terms.</p>

  <h2>12. Governing Law</h2>
  <p>These Terms are governed by the laws of the United States. Any disputes shall be resolved in the courts of the State of Florida.</p>

  <h2>13. Contact Us</h2>
  <p>If you have questions about these Terms, contact us at:</p>
  <p>Email: <a href="mailto:legal@1osm.com">legal@1osm.com</a></p>

  <footer>
    <div class="footer-links">
      <a href="/">Home</a>
      <a href="/privacy">Privacy Policy</a>
    </div>
    <p>&copy; ${new Date().getFullYear()} Nova Agent IA. All rights reserved.</p>
  </footer>
</div>`);
}
