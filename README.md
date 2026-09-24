# RANA WhatsApp Group Bot + Render Dashboard

Features:
- `!rana` single command prefix
- Every group member can use it
- Ignores normal group messages
- `!rana song <name>` returns YouTube + YouTube Music search links
- Optional OpenAI dynamic Roman Urdu replies
- QR dashboard + pairing code
- 20 pairing attempts before reset
- Live dashboard stats/logs
- Persistent session path configurable for Render

## Important
This project uses the WhatsApp Web protocol library Baileys, not the official WhatsApp Cloud API. WhatsApp may restrict or suspend accounts using unofficial automation. Use a dedicated number and follow WhatsApp's terms.

## Local setup
1. Install Node.js 20+.
2. `npm install`
3. Copy `.env.example` to `.env`.
4. Optional: add `OPENAI_API_KEY`.
5. `npm start`
6. Open `http://localhost:10000`.
7. Scan QR, or enter the WhatsApp number in international format and use the pairing code in WhatsApp > Linked devices > Link a device.

## Render
Create a Web Service from this repo.
- Build: `npm install`
- Start: `npm start`
- Add environment variables from `.env.example`.
- For persistent WhatsApp sessions, attach a paid Render persistent disk and set `SESSION_DIR=/var/data/session`.

If using GitHub, push all files to a private repo and connect that repo in Render.
