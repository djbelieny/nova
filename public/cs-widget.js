/**
 * Nova CS Chat Widget — embeddable floating chat bubble.
 *
 * Usage:
 *   <script src="https://your-nova-host/cs-widget.js"
 *           data-color="#0066FF"
 *           data-position="bottom-right"
 *           data-name="Support"
 *           data-ws="wss://your-nova-host/cs/chat">
 *   </script>
 *
 * Attributes (all optional):
 *   data-color      — primary color (default: #0066FF)
 *   data-position   — "bottom-right" | "bottom-left" (default: bottom-right)
 *   data-name       — agent display name (default: "Support")
 *   data-ws         — WebSocket URL override (default: auto-detected from script src)
 *
 * Session ID is persisted in localStorage so conversations survive page refresh.
 */

(function () {
  'use strict';

  // ── Config ───────────────────────────────────────────────────────────────────

  var script = document.currentScript || document.querySelector('script[src*="cs-widget"]');
  var COLOR = (script && script.getAttribute('data-color')) || '#0066FF';
  var POSITION = (script && script.getAttribute('data-position')) || 'bottom-right';
  var AGENT_NAME = (script && script.getAttribute('data-name')) || 'Support';

  // Derive WS URL from script src if not provided
  var WS_URL;
  if (script && script.getAttribute('data-ws')) {
    WS_URL = script.getAttribute('data-ws');
  } else {
    try {
      var srcUrl = new URL((script && script.src) || location.href);
      var proto = srcUrl.protocol === 'https:' ? 'wss:' : 'ws:';
      WS_URL = proto + '//' + srcUrl.host + '/cs/chat';
    } catch (e) {
      WS_URL = 'wss://' + location.host + '/cs/chat';
    }
  }

  var SESSION_KEY = 'nova_cs_session_id';

  function getOrCreateSessionId() {
    var id = null;
    try { id = localStorage.getItem(SESSION_KEY); } catch (e) {}
    if (!id) {
      id = 'ws-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
      try { localStorage.setItem(SESSION_KEY, id); } catch (e) {}
    }
    return id;
  }

  // ── Styles ───────────────────────────────────────────────────────────────────

  var posRight = POSITION.indexOf('right') !== -1;
  var posBottom = POSITION.indexOf('bottom') !== -1;

  var css = [
    '#nova-cs-widget * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, sans-serif; }',
    '#nova-cs-widget {',
    '  position: fixed;',
    '  ' + (posRight ? 'right: 24px;' : 'left: 24px;'),
    '  ' + (posBottom ? 'bottom: 24px;' : 'top: 24px;'),
    '  z-index: 2147483647;',
    '  display: flex;',
    '  flex-direction: column;',
    '  align-items: ' + (posRight ? 'flex-end;' : 'flex-start;'),
    '}',

    // Bubble button
    '#nova-cs-btn {',
    '  width: 56px; height: 56px;',
    '  border-radius: 50%;',
    '  background: ' + COLOR + ';',
    '  border: none;',
    '  cursor: pointer;',
    '  display: flex; align-items: center; justify-content: center;',
    '  box-shadow: 0 4px 20px rgba(0,0,0,0.25);',
    '  transition: transform 0.18s ease, box-shadow 0.18s ease;',
    '  flex-shrink: 0;',
    '}',
    '#nova-cs-btn:hover { transform: scale(1.08); box-shadow: 0 6px 24px rgba(0,0,0,0.32); }',
    '#nova-cs-btn svg { fill: #fff; width: 26px; height: 26px; }',

    // Panel
    '#nova-cs-panel {',
    '  display: none;',
    '  flex-direction: column;',
    '  width: 340px; height: 480px;',
    '  border-radius: 16px;',
    '  background: #fff;',
    '  box-shadow: 0 8px 40px rgba(0,0,0,0.2);',
    '  overflow: hidden;',
    '  margin-' + (posBottom ? 'bottom' : 'top') + ': 12px;',
    '  animation: novaSlideIn 0.22s ease;',
    '}',
    '#nova-cs-panel.open { display: flex; }',
    '@keyframes novaSlideIn {',
    '  from { opacity: 0; transform: translateY(' + (posBottom ? '12px' : '-12px') + '); }',
    '  to   { opacity: 1; transform: translateY(0); }',
    '}',

    // Header
    '#nova-cs-header {',
    '  background: ' + COLOR + ';',
    '  color: #fff;',
    '  padding: 14px 16px;',
    '  display: flex; align-items: center; justify-content: space-between;',
    '  gap: 8px;',
    '  flex-shrink: 0;',
    '}',
    '#nova-cs-header-info { display: flex; align-items: center; gap: 10px; }',
    '#nova-cs-avatar {',
    '  width: 32px; height: 32px;',
    '  border-radius: 50%;',
    '  background: rgba(255,255,255,0.25);',
    '  display: flex; align-items: center; justify-content: center;',
    '  font-size: 14px; font-weight: 700; color: #fff;',
    '  flex-shrink: 0;',
    '}',
    '#nova-cs-header-text {}',
    '#nova-cs-header-name { font-weight: 600; font-size: 15px; }',
    '#nova-cs-header-status { font-size: 11px; opacity: 0.82; }',
    '#nova-cs-close {',
    '  background: none; border: none; color: #fff;',
    '  font-size: 22px; cursor: pointer; line-height: 1; padding: 0 2px;',
    '  opacity: 0.8; transition: opacity 0.15s;',
    '}',
    '#nova-cs-close:hover { opacity: 1; }',

    // Messages
    '#nova-cs-messages {',
    '  flex: 1; overflow-y: auto;',
    '  padding: 14px 12px;',
    '  display: flex; flex-direction: column; gap: 8px;',
    '  scroll-behavior: smooth;',
    '}',
    '#nova-cs-messages::-webkit-scrollbar { width: 4px; }',
    '#nova-cs-messages::-webkit-scrollbar-thumb { background: #ddd; border-radius: 2px; }',
    '.nova-cs-msg {',
    '  max-width: 82%;',
    '  padding: 9px 13px;',
    '  border-radius: 16px;',
    '  font-size: 14px; line-height: 1.45;',
    '  word-break: break-word;',
    '  white-space: pre-wrap;',
    '}',
    '.nova-cs-msg.agent { background: #f1f3f4; color: #111; align-self: flex-start; border-bottom-left-radius: 4px; }',
    '.nova-cs-msg.customer { background: ' + COLOR + '; color: #fff; align-self: flex-end; border-bottom-right-radius: 4px; }',

    // Typing indicator
    '.nova-cs-typing {',
    '  align-self: flex-start;',
    '  padding: 8px 14px;',
    '  background: #f1f3f4;',
    '  border-radius: 16px;',
    '  border-bottom-left-radius: 4px;',
    '  display: flex; gap: 4px; align-items: center;',
    '}',
    '.nova-cs-typing span {',
    '  width: 7px; height: 7px;',
    '  border-radius: 50%;',
    '  background: #999;',
    '  display: inline-block;',
    '  animation: novaDot 1.2s infinite;',
    '}',
    '.nova-cs-typing span:nth-child(2) { animation-delay: 0.2s; }',
    '.nova-cs-typing span:nth-child(3) { animation-delay: 0.4s; }',
    '@keyframes novaDot { 0%,80%,100% { transform: scale(0.7); opacity: 0.5; } 40% { transform: scale(1); opacity: 1; } }',

    // Input row
    '#nova-cs-input-row {',
    '  display: flex; align-items: flex-end;',
    '  padding: 10px 12px;',
    '  border-top: 1px solid #eee;',
    '  gap: 8px;',
    '  flex-shrink: 0;',
    '}',
    '#nova-cs-input {',
    '  flex: 1;',
    '  border: 1.5px solid #ddd;',
    '  border-radius: 20px;',
    '  padding: 8px 14px;',
    '  font-size: 14px;',
    '  line-height: 1.4;',
    '  outline: none;',
    '  resize: none;',
    '  max-height: 80px;',
    '  overflow-y: auto;',
    '  transition: border-color 0.15s;',
    '  font-family: inherit;',
    '}',
    '#nova-cs-input:focus { border-color: ' + COLOR + '; }',
    '#nova-cs-send {',
    '  background: ' + COLOR + ';',
    '  border: none; color: #fff;',
    '  border-radius: 50%;',
    '  width: 36px; height: 36px;',
    '  cursor: pointer;',
    '  display: flex; align-items: center; justify-content: center;',
    '  flex-shrink: 0;',
    '  transition: opacity 0.15s, transform 0.15s;',
    '}',
    '#nova-cs-send:hover { opacity: 0.88; transform: scale(1.06); }',
    '#nova-cs-send:disabled { opacity: 0.45; cursor: default; transform: none; }',
    '#nova-cs-send svg { fill: #fff; width: 16px; height: 16px; }',

    // Unread badge
    '#nova-cs-badge {',
    '  position: absolute;',
    '  top: -4px; right: -4px;',
    '  background: #e53935;',
    '  color: #fff;',
    '  border-radius: 50%;',
    '  width: 18px; height: 18px;',
    '  font-size: 11px; font-weight: 700;',
    '  display: flex; align-items: center; justify-content: center;',
    '  display: none;',
    '}',
    '#nova-cs-btn-wrap { position: relative; }',
  ].join('\n');

  var styleEl = document.createElement('style');
  styleEl.textContent = css;
  document.head.appendChild(styleEl);

  // ── DOM ──────────────────────────────────────────────────────────────────────

  var avatarInitial = AGENT_NAME.charAt(0).toUpperCase();

  var wrapper = document.createElement('div');
  wrapper.id = 'nova-cs-widget';
  wrapper.innerHTML = [
    '<div id="nova-cs-panel">',
    '  <div id="nova-cs-header">',
    '    <div id="nova-cs-header-info">',
    '      <div id="nova-cs-avatar">' + avatarInitial + '</div>',
    '      <div id="nova-cs-header-text">',
    '        <div id="nova-cs-header-name">' + escapeHtml(AGENT_NAME) + '</div>',
    '        <div id="nova-cs-header-status">Online · Typically replies instantly</div>',
    '      </div>',
    '    </div>',
    '    <button id="nova-cs-close" aria-label="Close chat">&times;</button>',
    '  </div>',
    '  <div id="nova-cs-messages" role="log" aria-live="polite" aria-label="Chat messages"></div>',
    '  <div id="nova-cs-input-row">',
    '    <textarea id="nova-cs-input" rows="1" placeholder="Type a message…" aria-label="Chat message"></textarea>',
    '    <button id="nova-cs-send" aria-label="Send message">',
    '      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 21l21-9L2 3v7l15 2-15 2v7z"/></svg>',
    '    </button>',
    '  </div>',
    '</div>',
    '<div id="nova-cs-btn-wrap">',
    '  <button id="nova-cs-btn" aria-label="Open chat">',
    '    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z"/></svg>',
    '  </button>',
    '  <div id="nova-cs-badge" aria-hidden="true"></div>',
    '</div>',
  ].join('\n');

  document.body.appendChild(wrapper);

  var panel = document.getElementById('nova-cs-panel');
  var btn = document.getElementById('nova-cs-btn');
  var btnWrap = document.getElementById('nova-cs-btn-wrap');
  var closeBtn = document.getElementById('nova-cs-close');
  var messagesEl = document.getElementById('nova-cs-messages');
  var inputEl = document.getElementById('nova-cs-input');
  var sendBtn = document.getElementById('nova-cs-send');
  var badgeEl = document.getElementById('nova-cs-badge');

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ── State ────────────────────────────────────────────────────────────────────

  var ws = null;
  var typingEl = null;
  var isOpen = false;
  var unreadCount = 0;
  var reconnectTimer = null;
  var reconnectDelay = 1000;
  var maxReconnectDelay = 30000;
  var sessionId = getOrCreateSessionId();
  var pendingMessages = [];

  // ── WebSocket ────────────────────────────────────────────────────────────────

  function buildWsUrl() {
    return WS_URL + (WS_URL.indexOf('?') === -1 ? '?' : '&') + 'sessionId=' + encodeURIComponent(sessionId);
  }

  function connect() {
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    if (ws && ws.readyState !== WebSocket.CLOSED) return;

    ws = new WebSocket(buildWsUrl());

    ws.onopen = function () {
      reconnectDelay = 1000; // reset backoff
      // Flush pending messages
      var pending = pendingMessages.slice();
      pendingMessages = [];
      for (var i = 0; i < pending.length; i++) {
        ws.send(pending[i]);
      }
    };

    ws.onmessage = function (e) {
      removeTyping();
      try {
        var data = JSON.parse(e.data);
        if (data.type === 'message' && data.role === 'agent') {
          onAgentMessage(data.text);
        } else if (data.type === 'error') {
          onAgentMessage(data.text);
        }
      } catch (_) {
        onAgentMessage(String(e.data));
      }
    };

    ws.onerror = function () {
      removeTyping();
    };

    ws.onclose = function () {
      ws = null;
      scheduleReconnect();
    };
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(function () {
      reconnectTimer = null;
      connect();
    }, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, maxReconnectDelay);
  }

  function ensureConnected() {
    if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
      connect();
    }
  }

  // ── UI helpers ───────────────────────────────────────────────────────────────

  function scrollToBottom() {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function appendMessage(role, text) {
    removeTyping();
    var el = document.createElement('div');
    el.className = 'nova-cs-msg ' + role;
    el.textContent = text;
    messagesEl.appendChild(el);
    scrollToBottom();
  }

  function showTyping() {
    if (typingEl) return;
    typingEl = document.createElement('div');
    typingEl.className = 'nova-cs-typing';
    typingEl.setAttribute('aria-hidden', 'true');
    typingEl.innerHTML = '<span></span><span></span><span></span>';
    messagesEl.appendChild(typingEl);
    scrollToBottom();
  }

  function removeTyping() {
    if (typingEl) { typingEl.remove(); typingEl = null; }
  }

  function onAgentMessage(text) {
    appendMessage('agent', text);
    if (!isOpen) {
      unreadCount++;
      badgeEl.textContent = String(unreadCount > 9 ? '9+' : unreadCount);
      badgeEl.style.display = 'flex';
    }
  }

  function clearUnread() {
    unreadCount = 0;
    badgeEl.style.display = 'none';
  }

  // ── Send ─────────────────────────────────────────────────────────────────────

  function sendMessage() {
    var text = inputEl.value.trim();
    if (!text) return;

    appendMessage('customer', text);
    showTyping();
    inputEl.value = '';
    inputEl.style.height = 'auto';

    var payload = text; // send plain text; server accepts both plain and JSON

    ensureConnected();
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(payload);
    } else {
      pendingMessages.push(payload);
    }
  }

  // ── Panel open/close ─────────────────────────────────────────────────────────

  function openPanel() {
    if (isOpen) return;
    isOpen = true;
    panel.classList.add('open');
    btnWrap.style.display = 'none';
    clearUnread();
    inputEl.focus();
    ensureConnected();
  }

  function closePanel() {
    if (!isOpen) return;
    isOpen = false;
    panel.classList.remove('open');
    btnWrap.style.display = '';
  }

  // ── Event listeners ──────────────────────────────────────────────────────────

  btn.addEventListener('click', openPanel);
  closeBtn.addEventListener('click', closePanel);
  sendBtn.addEventListener('click', sendMessage);

  inputEl.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  inputEl.addEventListener('input', function () {
    this.style.height = 'auto';
    this.style.height = Math.min(this.scrollHeight, 80) + 'px';
  });

  // Keyboard: Escape closes panel
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && isOpen) closePanel();
  });

  // ── Init ─────────────────────────────────────────────────────────────────────

  // Eagerly connect so greeting arrives before user opens the widget
  connect();
})();
