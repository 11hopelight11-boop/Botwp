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
const SESSION_DIR =
  process.env.SESSION_DIR || '/tmp/rana-session';

/*
  Jamendo client ID

  Render Environment mein:
  JAMENDO_CLIENT_ID=your_client_id

  Testing ke liye Jamendo ka public test
  client ID use kiya ja sakta hai.
*/
const JAMENDO_CLIENT_ID =
  process.env.JAMENDO_CLIENT_ID || '709fa152';

fs.mkdirSync(SESSION_DIR, { recursive: true });
fs.mkdirSync('./logs', { recursive: true });

app.use(express.json());
app.use(express.static('public'));

/* =========================
   STATE
========================= */

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

/* =========================
   LOG
========================= */

function log(type, msg, meta = {}) {

  const item = {
    time: new Date().toISOString(),
    type,
    msg,
    ...meta
  };

  state.logs.unshift(item);

  state.logs =
    state.logs.slice(0, 80);

  state.lastActivity =
    item.time;

  try {

    fs.appendFileSync(
      './logs/activity.log',
      JSON.stringify(item) + '\n'
    );

  } catch {}

  console.log(
    `[${type}] ${msg}`,
    meta
  );
}

/* =========================
   RESET LINK
========================= */

function resetLink() {

  state.qr = null;
  state.pairingCode = null;
  state.attempts = 0;
}

/* =========================
   CLEAN NAME
========================= */

function cleanName(name) {

  return String(
    name || 'friend'
  )
    .replace(
      /[\r\n]/g,
      ' '
    )
    .trim() || 'friend';
}

/* =========================
   MEMBERS
========================= */

function addMember(jid, name) {

  if (!jid) return;

  if (!state.members[jid]) {

    state.members[jid] = {

      name:
        name ||
        jid.split('@')[0],

      messages: 0,
      commands: 0,
      lastSeen: null
    };
  }

  if (name) {

    state.members[jid].name =
      name;
  }

  state.members[jid].messages++;

  state.members[jid].lastSeen =
    new Date().toISOString();
}

/* =========================
   LOCAL FREE REPLIES
========================= */

function localReply(query, user) {

  const q =
    query.trim();

  const l =
    q.toLowerCase();

  const name =
    cleanName(user);

  const jokes = [

    `😂 ${name} bhai, ye sawal group mein daal ke tumne Rana ko judge bana diya.`,

    `🤣 ${name}, iska jawab dene se pehle chai zaroori hai ☕`,

    `😎 ${name} bhai, Rana investigation mode ON 🔎`,

    `😂 Oho ${name}! Ye kya pooch liya?`,

    `🤖 Rana ne sawal receive kar liya... ab group ki izzat tumhare haath mein hai 😂`,

    `😅 ${name}, iska jawab thora Bamb style mein aayega 😎`
  ];

  if (
    /\b(hello|hi|salam|assalam|aoa)\b/i
      .test(l)
  ) {

    return `👋 Wa Alaikum Assalam ${name} bhai ❤️
Rana online hai 😎 Batao kya scene hai?`;
  }

  if (
    /\b(kesa|kaisa|ks|how)\b.*\b(ho|hai|hain)\b/i
      .test(l)
  ) {

    return `😎 ${name} bhai, Rana bilkul fit!
Tum sunao, group ka kya haal hai? 😂`;
  }

  if (
    /\b(kahan|kidr|kidhar)\b/i
      .test(l)
  ) {

    return `📍 ${name} bhai, location department se confirmation mangwa raha hoon 😂
Jis bande ka naam liya hai usko tag karke pooch lo 😎`;
  }

  if (
    /\b(kya kha|khhya|khaya|khana)\b/i
      .test(l)
  ) {

    return `🍽️ ${name} bhai, khane ka sawal hai to Rana ka jawab hamesha: biryani 😂🔥`;
  }

  if (
    /\b(acha|theek|ok|okay)\b/i
      .test(l)
  ) {

    return `👍 Theek hai ${name} bhai 😎 Rana standby par hai.`;
  }

  if (
    /\b(pyar|love|mohabbat)\b/i
      .test(l)
  ) {

    return `❤️ ${name} bhai, mohabbat ka case hai...
Rana lawyer nahi, witness hai 😂`;
  }

  const index =
    Math.abs(
      [...q].reduce(
        (a, c) =>
          a + c.charCodeAt(0),
        0
      )
    ) % jokes.length;

  return `${jokes[index]}

💬 Tumhara sawal: "${q}"`;
}

/* =========================
   JAMENDO SEARCH
========================= */

async function searchJamendoSong(name) {

  /*
    Punjabi/Hindi terms ke saath
    multiple searches.

    Mainstream Bollywood/Punjabi
    songs guaranteed nahi hain.
  */

  const searches = [

    `${name} punjabi`,

    `${name} hindi`,

    name
  ];

  let allTracks = [];

  for (
    const term of searches
  ) {

    const url =
      `https://api.jamendo.com/v3.0/tracks/` +
      `?client_id=${encodeURIComponent(JAMENDO_CLIENT_ID)}` +
      `&format=json` +
      `&limit=20` +
      `&search=${encodeURIComponent(term)}` +
      `&audioformat=mp32` +
      `&audiodlformat=mp32`;

    const response =
      await fetch(url, {
        headers: {
          'User-Agent':
            'Rana-WhatsApp-Bot/1.0'
        }
      });

    if (!response.ok) {

      throw new Error(
        `Jamendo HTTP ${response.status}`
      );
    }

    const data =
      await response.json();

    if (
      Array.isArray(
        data.results
      )
    ) {

      allTracks.push(
        ...data.results
      );
    }
  }

  /*
    Remove duplicates
  */

  const unique =
    Array.from(
      new Map(
        allTracks.map(
          track => [
            String(track.id),
            track
          ]
        )
      ).values()
    );

  /*
    IMPORTANT:
    Sirf download-allowed tracks.
  */

  const downloadable =
    unique.filter(
      track =>
        (
          track.audiodownload_allowed === true ||
          track.audiodownload_allowed === 'true'
        ) &&
        track.audiodownload
    );

  if (
    !downloadable.length
  ) {

    return null;
  }

  /*
    Exact-ish matching.
  */

  const wanted =
    name
      .toLowerCase()
      .replace(
        /[^\p{L}\p{N}\s]/gu,
        ''
      )
      .trim();

  const exact =
    downloadable.find(
      track => {

        const title =
          String(
            track.name || ''
          )
            .toLowerCase()
            .replace(
              /[^\p{L}\p{N}\s]/gu,
              ''
            );

        return (
          title.includes(wanted) ||
          wanted.includes(title)
        );
      }
    );

  return (
    exact ||
    downloadable[0]
  );
}

/* =========================
   DOWNLOAD JAMENDO MP3
========================= */

async function downloadJamendoMP3(track) {

  if (
    !track ||
    !track.audiodownload
  ) {

    throw new Error(
      'Download URL available nahi hai'
    );
  }

  const response =
    await fetch(
      track.audiodownload,
      {
        headers: {
          'User-Agent':
            'Rana-WhatsApp-Bot/1.0'
        }
      }
    );

  if (!response.ok) {

    throw new Error(
      `MP3 download HTTP ${response.status}`
    );
  }

  const buffer =
    Buffer.from(
      await response.arrayBuffer()
    );

  if (!buffer.length) {

    throw new Error(
      'MP3 file empty hai'
    );
  }

  /*
    WhatsApp safety limit.
  */

  if (
    buffer.length >
    20 * 1024 * 1024
  ) {

    throw new Error(
      'MP3 20MB se bari hai'
    );
  }

  return buffer;
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
    } =
      await useMultiFileAuthState(
        SESSION_DIR
      );

    sock =
      makeWASocket({

        auth: authState,

        logger:
          P({
            level: 'silent'
          }),

        printQRInTerminal:
          false,

        browser: [
          'Rana WhatsApp Bot',
          'Chrome',
          '1.0'
        ],

        markOnlineOnConnect:
          false,

        connectTimeoutMs:
          60000
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
          qr
            ? 'QR received'
            : ''
        );

        /* QR */

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

            state.pairingCode =
              null;

            state.status =
              'SCAN_QR';

            state.error =
              null;

            log(
              'QR',
              'New QR generated'
            );

          } catch (e) {

            state.error =
              e.message;

            log(
              'ERROR',
              `QR render failed: ${e.message}`
            );
          }
        }

        /* CONNECTED */

        if (
          connection === 'open'
        ) {

          state.status =
            'CONNECTED';

          state.connectedAt =
            new Date().toISOString();

          state.error =
            null;

          resetLink();

          log(
            'SYSTEM',
            'WhatsApp connected'
          );

          starting = false;
        }

        /* CLOSED */

        if (
          connection === 'close'
        ) {

          state.status =
            'DISCONNECTED';

          const code =
            lastDisconnect
              ?.error
              ?.output
              ?.statusCode;

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
                startBot()
                  .catch(
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
      async ({
        messages
      }) => {

        for (
          const m of messages
        ) {

          try {

            if (
              !m.message ||
              m.key.fromMe
            ) {
              continue;
            }

            const jid =
              m.key.remoteJid ||
              '';

            /*
              GROUP ONLY
            */

            if (
              !jid.endsWith(
                '@g.us'
              )
            ) {
              continue;
            }

            const sender =
              m.key.participant ||
              jid;

            const senderName =
              cleanName(
                m.pushName ||
                sender.split('@')[0]
              );

            const text =
              (
                m.message
                  .conversation ||

                m.message
                  .extendedTextMessage
                  ?.text ||

                ''
              ).trim();

            if (!text) {
              continue;
            }

            state.messages++;

            addMember(
              sender,
              senderName
            );

            /*
              NORMAL MESSAGE IGNORE
            */

            if (
              !text
                .toLowerCase()
                .startsWith(
                  PREFIX.toLowerCase()
                )
            ) {

              continue;
            }

            const query =
              text
                .slice(
                  PREFIX.length
                )
                .trim();

            state.commands++;

            state.members[
              sender
            ].commands++;

            log(
              'COMMAND',
              query || 'help',
              {
                sender:
                  senderName,

                group:
                  jid
              }
            );

            const lower =
              query.toLowerCase();

            /* =========================
               HELP
            ========================= */

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
➡️ Full authorized MP3

${PREFIX} help
➡️ Commands

Example:

${PREFIX} Ali kaha hai?

${PREFIX} song Punjabi`
                },
                {
                  quoted: m
                }
              );

              continue;
            }

            /* =========================
               SONG
            ========================= */

            if (
              lower === 'song' ||
              lower.startsWith(
                'song '
              )
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

${PREFIX} song Punjabi
${PREFIX} song Hindi`
                  },
                  {
                    quoted: m
                  }
                );

                continue;
              }

              state.songs++;

              /*
                SEARCHING
              */

              await sock.sendMessage(
                jid,
                {
                  text:
`🔎 🎵 ${name}

Rana full MP3 dhoond raha hai...`
                },
                {
                  quoted: m
                }
              );

              try {

                /*
                  SEARCH JAMENDO
                */

                const track =
                  await searchJamendoSong(
                    name
                  );

                if (!track) {

                  await sock.sendMessage(
                    jid,
                    {
                      text:
`😕 "${name}" ka full downloadable track nahi mila.

⚠️ Jamendo par sirf woh tracks download kiye ja sakte hain jinke artist ne downloading allow ki ho.`
                    },
                    {
                      quoted: m
                    }
                  );

                  log(
                    'SONG',
                    `No downloadable track: ${name}`,
                    {
                      sender:
                        senderName,

                      group:
                        jid
                    }
                  );

                  continue;
                }

                const title =
                  track.name ||
                  name;

                const artist =
                  track.artist_name ||
                  'Unknown artist';

                /*
                  DOWNLOAD FULL MP3
                */

                const audioBuffer =
                  await downloadJamendoMP3(
                    track
                  );

                /*
                  SEND DIRECTLY
                  TO WHATSAPP
                */

                await sock.sendMessage(
                  jid,
                  {
                    audio:
                      audioBuffer,

                    mimetype:
                      'audio/mpeg',

                    ptt:
                      false,

                    fileName:
                      `${title}.mp3`,

                    caption:
`🎵 ${title}
👤 ${artist}

✅ Full downloadable audio`
                  },
                  {
                    quoted: m
                  }
                );

                log(
                  'AUDIO',
                  `Full MP3 sent: ${title}`,
                  {
                    sender:
                      senderName,

                    group:
                      jid,

                    artist:
                      artist,

                    duration:
                      track.duration
                  }
                );

              } catch (e) {

                await sock.sendMessage(
                  jid,
                  {
                    text:
`❌ Song send nahi ho saka.

Error:
${e.message}`
                  },
                  {
                    quoted: m
                  }
                );

                log(
                  'ERROR',
                  `Song failed: ${e.message}`,
                  {
                    sender:
                      senderName,

                    group:
                      jid
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

            if (
              reply.usedAI
            ) {

              state.aiReplies++;
            }

            await sock.sendMessage(
              jid,
              {
                text:
                  reply.text
              },
              {
                quoted: m
              }
            );

            log(
              'REPLY',
              'Reply sent',
              {
                sender:
                  senderName,

                group:
                  jid
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

    state.status =
      'ERROR';

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
        startBot()
          .catch(
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

  /*
    FREE LOCAL MODE
  */

  if (
    !process.env.OPENAI_API_KEY
  ) {

    return {
      usedAI:
        false,

      text:
        localReply(
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
          method:
            'POST',

          headers: {
            'Content-Type':
              'application/json',

            Authorization:
              `Bearer ${process.env.OPENAI_API_KEY}`
          },

          body:
            JSON.stringify({

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

      usedAI:
        true,

      text:
        data.output_text ||
        localReply(
          query,
          user
        )
    };

  } catch {

    return {

      usedAI:
        false,

      text:
        localReply(
          query,
          user
        )
    };
  }
}

/* =========================
   DASHBOARD STATE
========================= */

app.get(
  '/api/state',
  (req, res) => {

    res.json({

      ...state,

      qr:
        !!state.qr,

      members:
        Object.values(
          state.members
        )
          .sort(
            (a, b) =>
              b.commands -
              a.commands
          )
          .slice(
            0,
            10
          )
    });
  }
);

/* =========================
   QR API
========================= */

app.get(
  '/api/qr',
  (req, res) => {

    res.json({

      qr:
        state.qr,

      pairingCode:
        state.pairingCode,

      status:
        state.status,

      attempts:
        state.attempts,

      maxAttempts:
        state.maxAttempts,

      error:
        state.error
    });
  }
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
          req.body.phone ||
          ''
        )
          .replace(
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

      state.pairingCode =
        code;

      state.qr =
        null;

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

          sock.end(
            undefined
          );

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
            recursive:
              true,

            force:
              true
          }
        );
      }

      resetLink();

      state.status =
        'STARTING';

      state.error =
        null;

      log(
        'SYSTEM',
        'Session reset; restarting WhatsApp connection'
      );

      setTimeout(
        () =>
          startBot()
            .catch(
              e =>
                log(
                  'ERROR',
                  e.message
                )
            ),
        500
      );

      res.json({
        ok:
          true
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
  (req, res) => {

    res.json({

      ok:
        true,

      status:
        state.status,

      error:
        state.error
    });
  }
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

    startBot()
      .catch(
        e =>
          log(
            'ERROR',
            e.message
          )
      );
  }
);
