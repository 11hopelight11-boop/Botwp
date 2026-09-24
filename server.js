import 'dotenv/config';
import express from 'express';
import fs from 'fs';
import QRCode from 'qrcode';
import P from 'pino';
import makeWASocket, { useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys';

const app = express();
const PORT = Number(process.env.PORT || 10000);
const PREFIX = process.env.BOT_PREFIX || '!rana';
const SESSION_DIR = process.env.SESSION_DIR || '/tmp/rana-session';

fs.mkdirSync(SESSION_DIR, { recursive: true });
fs.mkdirSync('./logs', { recursive: true });
app.use(express.json());
app.use(express.static('public'));

const state = {
  status: 'STARTING', qr: null, pairingCode: null, attempts: 0, maxAttempts: 20,
  connectedAt: null, commands: 0, songs: 0, aiReplies: 0, messages: 0,
  lastActivity: null, logs: [], members: {}, error: null
};

function log(type, msg, meta = {}) {
  const item = { time: new Date().toISOString(), type, msg, ...meta };
  state.logs.unshift(item);
  state.logs = state.logs.slice(0, 80);
  state.lastActivity = item.time;
  try { fs.appendFileSync('./logs/activity.log', JSON.stringify(item) + '\n'); } catch {}
  console.log(`[${type}] ${msg}`, meta);
}

function resetLink() {
  state.qr = null;
  state.pairingCode = null;
  state.attempts = 0;
}

function addMember(jid, name) {
  if (!jid) return;
  if (!state.members[jid]) state.members[jid] = { name: name || jid.split('@')[0], messages: 0, commands: 0, lastSeen: null };
  state.members[jid].name = name || state.members[jid].name;
  state.members[jid].messages++;
  state.members[jid].lastSeen = new Date().toISOString();
}

let sock;
let starting = false;

async function startBot() {
  if (starting) return;
  starting = true;
  state.error = null;
  state.status = 'STARTING';
  log('SYSTEM', `Starting WhatsApp socket; session=${SESSION_DIR}`);

  try {
    const { state: authState, saveCreds } = await useMultiFileAuthState(SESSION_DIR);

    // Do not call fetchLatestBaileysVersion here. The current Baileys docs create
    // the socket directly; a remote version lookup can prevent a Render service
    // from ever reaching the QR event when that request fails/hangs.
    sock = makeWASocket({
      auth: authState,
      logger: P({ level: 'silent' }),
      printQRInTerminal: false,
      browser: ['Rana WhatsApp Bot', 'Chrome', '1.0'],
      markOnlineOnConnect: false,
      connectTimeoutMs: 60000
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
      console.log('[CONNECTION]', connection, qr ? 'QR received' : '');

      if (qr) {
        try {
          state.qr = await QRCode.toDataURL(qr, { width: 360, margin: 2 });
          state.pairingCode = null;
          state.status = 'SCAN_QR';
          state.error = null;
          log('QR', 'New QR generated');
        } catch (e) {
          state.error = e.message;
          log('ERROR', `QR render failed: ${e.message}`);
        }
      }

      if (connection === 'open') {
        state.status = 'CONNECTED';
        state.connectedAt = new Date().toISOString();
        state.error = null;
        resetLink();
        log('SYSTEM', 'WhatsApp connected');
        starting = false;
      }

      if (connection === 'close') {
        state.status = 'DISCONNECTED';
        const code = lastDisconnect?.error?.output?.statusCode;
        log('SYSTEM', 'WhatsApp disconnected', { code });
        starting = false;
        if (code !== DisconnectReason.loggedOut) {
          setTimeout(() => startBot().catch(e => log('ERROR', e.message)), 3000);
        } else {
          state.error = 'WhatsApp logged out. Reset session and link again.';
          log('SYSTEM', 'Logged out; session must be reset before relinking');
        }
      }
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
      for (const m of messages) {
        if (!m.message || m.key.fromMe) continue;
        const jid = m.key.remoteJid || '';
        if (!jid.endsWith('@g.us')) continue;
        const sender = m.key.participant || jid;
        const text = (m.message.conversation || m.message.extendedTextMessage?.text || '').trim();
        if (!text) continue;
        state.messages++;
        addMember(sender, m.pushName || sender.split('@')[0]);
        if (!text.toLowerCase().startsWith(PREFIX.toLowerCase())) continue;

        const query = text.slice(PREFIX.length).trim();
        state.commands++;
        state.members[sender].commands++;
        log('COMMAND', query || 'help', { sender: m.pushName || sender.split('@')[0], group: jid });

        const lower = query.toLowerCase();
        if (lower === 'help' || !query) {
          await sock.sendMessage(jid, { text: `⚡ RANA COMMANDS\n\n${PREFIX} <sawal> — funny reply\n${PREFIX} song <name> — song search\n${PREFIX} help — commands\n\nExample: ${PREFIX} Ali kaha hai?` }, { quoted: m });
          continue;
        }

        if (lower.startsWith('song')) {
          const name = query.slice(4).trim();
          if (!name) {
            await sock.sendMessage(jid, { text: `🎵 Song ka naam bhejo. Example: ${PREFIX} song Tum Hi Ho` }, { quoted: m });
            continue;
          }
          state.songs++;
          const q = encodeURIComponent(name);
          await sock.sendMessage(jid, { text: `🎵 ${name}\n\nYouTube video: https://www.youtube.com/results?search_query=${q}\nAudio search: https://music.youtube.com/search?q=${q}` }, { quoted: m });
          continue;
        }

        const reply = await aiReply(query, m.pushName || 'friend');
        if (reply.usedAI) state.aiReplies++;
        await sock.sendMessage(jid, { text: reply.text }, { quoted: m });
      }
    });
  } catch (e) {
    starting = false;
    state.status = 'ERROR';
    state.error = e?.stack || e?.message || String(e);
    log('ERROR', state.error);
    setTimeout(() => startBot().catch(err => log('ERROR', err.message)), 5000);
  }
}

async function aiReply(query, user) {
  if (!process.env.OPENAI_API_KEY) {
    return { usedAI: false, text: `😂 ${user} bhai, sawal to kamaal ka hai: “${query}”\n\nRana abhi free demo mode mein hai 😎` };
  }
  try {
    const r = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: JSON.stringify({ model: process.env.OPENAI_MODEL || 'gpt-5.6-luna', input: query })
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data?.error?.message || `OpenAI HTTP ${r.status}`);
    return { usedAI: true, text: data.output_text || '😅 Rana ko jawab nahi mila.' };
  } catch (e) {
    return { usedAI: false, text: `😅 AI connection issue aa gaya: ${e.message}` };
  }
}

app.get('/api/state', (req, res) => res.json({ ...state, qr: !!state.qr, members: Object.values(state.members).sort((a, b) => b.commands - a.commands).slice(0, 10) }));
app.get('/api/qr', (req, res) => res.json({ qr: state.qr, pairingCode: state.pairingCode, status: state.status, attempts: state.attempts, maxAttempts: state.maxAttempts, error: state.error }));
app.post('/api/pair', async (req, res) => {
  try {
    if (!sock) return res.status(503).json({ error: 'Bot is still starting' });
    if (state.status === 'CONNECTED') return res.json({ status: 'CONNECTED' });
    const phone = String(req.body.phone || '').replace(/\D/g, '');
    if (!phone) return res.status(400).json({ error: 'Phone required' });
    if (state.attempts >= state.maxAttempts) resetLink();
    state.attempts++;
    // WhatsApp pairing code expects full international digits, no +, spaces or dashes.
    const code = await sock.requestPairingCode(phone);
    state.pairingCode = code;
    state.qr = null;
    state.status = 'PAIRING_CODE';
    log('PAIRING', 'Pairing code generated', { attempt: state.attempts });
    res.json({ pairingCode: code, attempts: state.attempts });
  } catch (e) {
    log('ERROR', `Pairing failed: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/reset', async (req, res) => {
  try {
    if (sock) { try { sock.end(undefined); } catch {} }
    if (fs.existsSync(SESSION_DIR)) fs.rmSync(SESSION_DIR, { recursive: true, force: true });
    resetLink();
    state.status = 'STARTING';
    state.error = null;
    log('SYSTEM', 'Session reset; restarting WhatsApp connection');
    setTimeout(() => startBot().catch(e => log('ERROR', e.message)), 500);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/health', (req, res) => res.json({ ok: true, status: state.status, error: state.error }));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Rana dashboard listening on ${PORT}`);
  log('SYSTEM', `Dashboard listening on ${PORT}`);
  startBot().catch(e => log('ERROR', e.message));
});
