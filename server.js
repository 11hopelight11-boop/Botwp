import 'dotenv/config';
import express from 'express';
import fs from 'fs';
import QRCode from 'qrcode';
import P from 'pino';
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason
} from '@whiskeysockets/baileys';

const app = express();

const PORT = Number(process.env.PORT || 10000);
const PREFIX = process.env.BOT_PREFIX || '!rana';
const SESSION_DIR = process.env.SESSION_DIR || '/tmp/rana-session';

fs.mkdirSync(SESSION_DIR, { recursive: true });
fs.mkdirSync('./logs', { recursive: true });

app.use(express.json());
app.use(express.static('public'));

const state = {
  status: 'STARTING',
  qr: null,
  pairingCode: null,
  attempts: 0,
  maxAttempts: 20,
  connectedAt: null,
  commands: 0,
  songs: 0,
  aiReplies: 0,
  messages: 0,
  lastActivity: null,
  logs: [],
  members: {},
  error: null
};

function log(type, msg, meta = {}) {
  const item = {
    time: new Date().toISOString(),
    type,
    msg,
    ...meta
  };

  state.logs.unshift(item);
  state.logs = state.logs.slice(0, 80);
  state.lastActivity = item.time;

  try {
    fs.appendFileSync(
      './logs/activity.log',
      JSON.stringify(item) + '\n'
    );
  } catch {}

  console.log(`[${type}] ${msg}`, meta);
}

function resetLink() {
  state.qr = null;
  state.pairingCode = null;
  state.attempts = 0;
}

function cleanName(name) {
  return String(name || 'friend')
    .replace(/[\r\n]/g, ' ')
    .trim() || 'friend';
}

function addMember(jid, name) {
  if (!jid) return;

  if (!state.members[jid]) {
    state.members[jid] = {
      name: name || jid.split('@')[0],
      messages: 0,
      commands: 0,
      lastSeen: null
    };
  }

  if (name) {
    state.members[jid].name = name;
  }

  state.members[jid].messages++;
  state.members[jid].lastSeen = new Date().toISOString();
}

/* =========================
   LOCAL FREE REPLIES
========================= */

function localReply(query, user) {
  const q = query.trim();
  const l = q.toLowerCase();
  const name = cleanName(user);

  const jokes = [
    `😂 ${name} bhai, ye sawal group mein daal ke tumne Rana ko judge bana diya.`,
    `🤣 ${name}, iska jawab dene se pehle chai zaroori hai ☕`,
    `😎 ${name} bhai, Rana investigation mode ON 🔎`,
    `😂 Oho ${name}! Ye kya pooch liya?`,
    `🤖 Rana ne sawal receive kar liya... ab group ki izzat tumhare haath mein hai 😂`,
    `😅 ${name}, iska jawab thora Bamb style mein aayega 😎`
  ];

  if (/\b(hello|hi|salam|assalam|aoa)\b/i.test(l)) {
    return `👋 Wa Alaikum Assalam ${name} bhai ❤️
Rana online hai 😎 Batao kya scene hai?`;
  }

  if (/\b(kesa|kaisa|ks|how)\b.*\b(ho|hai|hain)\b/i.test(l)) {
    return `😎 ${name} bhai, Rana bilkul fit!
Tum sunao, group ka kya haal hai? 😂`;
  }

  if (/\b(kahan|kidr|kidhar)\b/i.test(l)) {
    return `📍 ${name} bhai, location department se confirmation mangwa raha hoon 😂
Jis bande ka naam liya hai usko tag karke pooch lo 😎`;
  }

  if (/\b(kya kha|khhya|khaya|khana)\b/i.test(l)) {
    return `🍽️ ${name} bhai, khane ka sawal hai to Rana ka jawab hamesha: biryani 😂🔥`;
  }

  if (/\b(acha|theek|ok|okay)\b/i.test(l)) {
    return `👍 Theek hai ${name} bhai 😎 Rana standby par hai.`;
  }

  if (/\b(pyar|love|mohabbat)\b/i.test(l)) {
    return `❤️ ${name} bhai, mohabbat ka case hai...
Rana lawyer nahi, witness hai 😂`;
  }

  const index =
    Math.abs(
      [...q].reduce(
        (a, c) => a + c.charCodeAt(0),
        0
      )
    ) % jokes.length;

  return `${jokes[index]}

💬 Tumhara sawal: "${q}"`;
}

/* =========================
   WHATSAPP
========================= */

let sock;
let starting = false;

async function startBot() {
  if (starting) return;

  starting = true;
  state.error = null;
  state.status = 'STARTING';

  log(
    'SYSTEM',
    `Starting WhatsApp socket; session=${SESSION_DIR}`
  );

  try {
    const {
      state: authState,
      saveCreds
    } = await useMultiFileAuthState(SESSION_DIR);

    sock = makeWASocket({
      auth: authState,
      logger: P({ level: 'silent' }),
      printQRInTerminal: false,
      browser: [
        'Rana WhatsApp Bot',
        'Chrome',
        '1.0'
      ],
      markOnlineOnConnect: false,
      connectTimeoutMs: 60000
    });

    sock.ev.on(
      'creds.update',
      saveCreds
    );

    sock.ev.on(
      'connection.update',
      async ({
        connection,
        lastDisconnect,
        qr
      }) => {

        console.log(
          '[CONNECTION]',
          connection,
          qr ? 'QR received' : ''
        );

        if (qr) {
          try {
            state.qr =
              await QRCode.toDataURL(
                qr,
                {
                  width: 360,
                  margin: 2
                }
              );

            state.pairingCode = null;
            state.status = 'SCAN_QR';
            state.error = null;

            log(
              'QR',
              'New QR generated'
            );

          } catch (e) {
            state.error = e.message;

            log(
              'ERROR',
              `QR render failed: ${e.message}`
            );
          }
        }

        if (connection === 'open') {
          state.status = 'CONNECTED';
          state.connectedAt =
            new Date().toISOString();

          state.error = null;

          resetLink();

          log(
            'SYSTEM',
            'WhatsApp connected'
          );

          starting = false;
        }

        if (connection === 'close') {

          state.status = 'DISCONNECTED';

          const code =
            lastDisconnect?.error
              ?.output?.statusCode;

          log(
            'SYSTEM',
            'WhatsApp disconnected',
            { code }
          );

          starting = false;

          if (
            code !==
            DisconnectReason.loggedOut
          ) {

            setTimeout(
              () =>
                startBot().catch(
                  e =>
                    log(
                      'ERROR',
                      e.message
                    )
                ),
              3000
            );

          } else {

            state.error =
              'WhatsApp logged out. Reset session and link again.';

            log(
              'SYSTEM',
              'Logged out; session must be reset before relinking'
            );
          }
        }
      }
    );

    /* =========================
       MESSAGE HANDLER
    ========================= */

    sock.ev.on(
      'messages.upsert',
      async ({ messages }) => {

        for (const m of messages) {

          try {

            if (
              !m.message ||
              m.key.fromMe
            ) continue;

            const jid =
              m.key.remoteJid || '';

            /* GROUP ONLY */

            if (
              !jid.endsWith('@g.us')
            ) continue;

            const sender =
              m.key.participant ||
              jid;

            const senderName =
              cleanName(
                m.pushName ||
                sender.split('@')[0]
              );

            const text = (
              m.message.conversation ||
              m.message.extendedTextMessage?.text ||
              ''
            ).trim();

            if (!text) continue;

            state.messages++;

            addMember(
              sender,
              senderName
            );

            /* NORMAL MESSAGE IGNORE */

            if (
              !text
                .toLowerCase()
                .startsWith(
                  PREFIX.toLowerCase()
                )
            ) continue;

            const query =
              text
                .slice(PREFIX.length)
                .trim();

            state.commands++;

            state.members[
              sender
            ].commands++;

            log(
              'COMMAND',
              query || 'help',
              {
                sender: senderName,
                group: jid
              }
            );

            const lower =
              query.toLowerCase();

            /* HELP */

            if (
              lower === 'help' ||
              !query
            ) {

              await sock.sendMessage(
                jid,
                {
                  text:
`⚡ RANA BOT

${PREFIX} <sawal>
➡️ Funny/smart reply

${PREFIX} song <name>
➡️ Free music preview

${PREFIX} help
➡️ Commands

Example:

${PREFIX} Ali kaha hai?

${PREFIX} song Tum Hi Ho`
                },
                { quoted: m }
              );

              continue;
            }

            /* =========================
               SONG
            ========================= */

            if (
              lower === 'song' ||
              lower.startsWith('song ')
            ) {

              const name =
                query
                  .slice(4)
                  .trim();

              if (!name) {

                await sock.sendMessage(
                  jid,
                  {
                    text:
`🎵 Song ka naam bhejo.

Example:
${PREFIX} song Tum Hi Ho`
                  },
                  { quoted: m }
                );

                continue;
              }

              state.songs++;

              const q =
                encodeURIComponent(name);

              /* SEARCHING MESSAGE */

              await sock.sendMessage(
                jid,
                {
                  text:
`🔎 🎵 ${name}

Rana song dhoond raha hai...`
                },
                { quoted: m }
              );

              try {

                /*
                  FREE PUBLIC APPLE
                  iTunes Search API

                  No API key.
                */

                const searchUrl =
                  `https://itunes.apple.com/search?term=${q}&media=music&entity=song&limit=10`;

                const response =
                  await fetch(
                    searchUrl,
                    {
                      headers: {
                        'User-Agent':
                          'Rana-WhatsApp-Bot/1.0'
                      }
                    }
                  );

                if (!response.ok) {
                  throw new Error(
                    `Music search HTTP ${response.status}`
                  );
                }

                const data =
                  await response.json();

                const track =
                  (data.results || [])
                    .find(
                      x => x.previewUrl
                    );

                /* NO PREVIEW */

                if (!track) {

                  await sock.sendMessage(
                    jid,
                    {
                      text:
`😕 ${name} ka playable preview nahi mila.

▶️ YouTube:
https://www.youtube.com/results?search_query=${q}

🎧 Spotify:
https://open.spotify.com/search/${q}`
                    },
                    { quoted: m }
                  );

                  log(
                    'SONG',
                    `No preview found: ${name}`,
                    {
                      sender: senderName,
                      group: jid
                    }
                  );

                  continue;
                }

                /* DOWNLOAD PREVIEW */

                const audioResponse =
                  await fetch(
                    track.previewUrl,
                    {
                      headers: {
                        'User-Agent':
                          'Rana-WhatsApp-Bot/1.0'
                      }
                    }
                  );

                if (!audioResponse.ok) {
                  throw new Error(
                    `Audio HTTP ${audioResponse.status}`
                  );
                }

                const audioBuffer =
                  Buffer.from(
                    await audioResponse.arrayBuffer()
                  );

                if (
                  !audioBuffer.length
                ) {
                  throw new Error(
                    'Audio file empty hai'
                  );
                }

                if (
                  audioBuffer.length >
                  20 * 1024 * 1024
                ) {
                  throw new Error(
                    'Audio 20MB se bari hai'
                  );
                }

                const title =
                  track.trackName ||
                  name;

                const artist =
                  track.artistName ||
                  'Unknown artist';

                /*
                  SEND AUDIO TO WHATSAPP
                */

                await sock.sendMessage(
                  jid,
                  {
                    audio: audioBuffer,
                    mimetype:
                      'audio/mp4',
                    ptt: false,
                    fileName:
                      `${title}.m4a`,
                    caption:
`🎵 ${title}
👤 ${artist}

⚠️ Official music preview`
                  },
                  { quoted: m }
                );

                log(
                  'AUDIO',
                  `Song preview sent: ${title}`,
                  {
                    sender: senderName,
                    group: jid,
                    artist
                  }
                );

              } catch (e) {

                await sock.sendMessage(
                  jid,
                  {
                    text:
`❌ Audio send nahi ho saki.

Error:
${e.message}

▶️ YouTube search:
https://www.youtube.com/results?search_query=${q}`
                  },
                  { quoted: m }
                );

                log(
                  'ERROR',
                  `Song preview failed: ${e.message}`,
                  {
                    sender: senderName,
                    group: jid
                  }
                );
              }

              continue;
            }

            /* =========================
               NORMAL RANA REPLY
            ========================= */

            const reply =
              await aiReply(
                query,
                senderName
              );

            if (reply.usedAI) {
              state.aiReplies++;
            }

            await sock.sendMessage(
              jid,
              {
                text: reply.text
              },
              { quoted: m }
            );

            log(
              'REPLY',
              'Reply sent',
              {
                sender: senderName,
                group: jid
              }
            );

          } catch (e) {

            log(
              'ERROR',
              `Message handler failed: ${e.message}`
            );
          }
        }
      }
    );

  } catch (e) {

    starting = false;

    state.status = 'ERROR';

    state.error =
      e?.stack ||
      e?.message ||
      String(e);

    log(
      'ERROR',
      state.error
    );

    setTimeout(
      () =>
        startBot().catch(
          err =>
            log(
              'ERROR',
              err.message
            )
        ),
      5000
    );
  }
}

/* =========================
   AI / FREE REPLY
========================= */

async function aiReply(
  query,
  user
) {

  if (
    !process.env.OPENAI_API_KEY
  ) {

    return {
      usedAI: false,
      text: localReply(
        query,
        user
      )
    };
  }

  try {

    const r =
      await fetch(
        'https://api.openai.com/v1/responses',
        {
          method: 'POST',

          headers: {
            'Content-Type':
              'application/json',

            Authorization:
              `Bearer ${process.env.OPENAI_API_KEY}`
          },

          body: JSON.stringify({
            model:
              process.env.OPENAI_MODEL ||
              'gpt-5.6-luna',

            input:
`You are Rana, a funny friendly WhatsApp group bot.

Reply naturally in Roman Urdu/Hinglish.

User name: ${user}

Question:
${query}

Keep it short, friendly and contextual.`
          })
        }
      );

    const data =
      await r.json();

    if (!r.ok) {
      throw new Error(
        data?.error?.message ||
        `OpenAI HTTP ${r.status}`
      );
    }

    return {
      usedAI: true,
      text:
        data.output_text ||
        localReply(
          query,
          user
        )
    };

  } catch {

    return {
      usedAI: false,
      text:
        localReply(
          query,
          user
        )
    };
  }
}

/* =========================
   DASHBOARD
========================= */

app.get(
  '/api/state',
  (req, res) =>
    res.json({
      ...state,

      qr: !!state.qr,

      members:
        Object.values(
          state.members
        )
          .sort(
            (a, b) =>
              b.commands -
              a.commands
          )
          .slice(0, 10)
    })
);

app.get(
  '/api/qr',
  (req, res) =>
    res.json({
      qr: state.qr,
      pairingCode:
        state.pairingCode,
      status: state.status,
      attempts:
        state.attempts,
      maxAttempts:
        state.maxAttempts,
      error: state.error
    })
);

/* =========================
   PAIRING
========================= */

app.post(
  '/api/pair',
  async (req, res) => {

    try {

      if (!sock) {
        return res
          .status(503)
          .json({
            error:
              'Bot is still starting'
          });
      }

      if (
        state.status ===
        'CONNECTED'
      ) {
        return res.json({
          status:
            'CONNECTED'
        });
      }

      const phone =
        String(
          req.body.phone || ''
        ).replace(
          /\D/g,
          ''
        );

      if (!phone) {
        return res
          .status(400)
          .json({
            error:
              'Phone required'
          });
      }

      if (
        state.attempts >=
        state.maxAttempts
      ) {
        resetLink();
      }

      state.attempts++;

      const code =
        await sock.requestPairingCode(
          phone
        );

      state.pairingCode = code;
      state.qr = null;
      state.status =
        'PAIRING_CODE';

      log(
        'PAIRING',
        'Pairing code generated',
        {
          attempt:
            state.attempts
        }
      );

      res.json({
        pairingCode:
          code,
        attempts:
          state.attempts
      });

    } catch (e) {

      log(
        'ERROR',
        `Pairing failed: ${e.message}`
      );

      res
        .status(500)
        .json({
          error:
            e.message
        });
    }
  }
);

/* =========================
   RESET
========================= */

app.post(
  '/api/reset',
  async (req, res) => {

    try {

      if (sock) {
        try {
          sock.end(undefined);
        } catch {}
      }

      if (
        fs.existsSync(
          SESSION_DIR
        )
      ) {
        fs.rmSync(
          SESSION_DIR,
          {
            recursive: true,
            force: true
          }
        );
      }

      resetLink();

      state.status =
        'STARTING';

      state.error = null;

      log(
        'SYSTEM',
        'Session reset; restarting WhatsApp connection'
      );

      setTimeout(
        () =>
          startBot().catch(
            e =>
              log(
                'ERROR',
                e.message
              )
          ),
        500
      );

      res.json({
        ok: true
      });

    } catch (e) {

      res
        .status(500)
        .json({
          error:
            e.message
        });
    }
  }
);

/* =========================
   HEALTH
========================= */

app.get(
  '/health',
  (req, res) =>
    res.json({
      ok: true,
      status:
        state.status,
      error:
        state.error
    })
);

/* =========================
   START
========================= */

app.listen(
  PORT,
  '0.0.0.0',
  () => {

    console.log(
      `Rana dashboard listening on ${PORT}`
    );

    log(
      'SYSTEM',
      `Dashboard listening on ${PORT}`
    );

    startBot().catch(
      e =>
        log(
          'ERROR',
          e.message
        )
    );
  }
);
