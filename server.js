import 'dotenv/config';
import express from 'express';
import fs from 'fs';
import path from 'path';
import QRCode from 'qrcode';
import P from 'pino';
import makeWASocket, { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';

const app = express();
const PORT = process.env.PORT || 10000;
const PREFIX = process.env.BOT_PREFIX || '!rana';
const SESSION_DIR = process.env.SESSION_DIR || './sessions';
fs.mkdirSync(SESSION_DIR,{recursive:true});
fs.mkdirSync('./logs',{recursive:true});
app.use(express.json());
app.use(express.static('public'));

const state={status:'OFFLINE',qr:null,pairingCode:null,attempts:0,maxAttempts:20,connectedAt:null,commands:0,songs:0,aiReplies:0,messages:0,lastActivity:null,logs:[],members:{}};
function log(type,msg,meta={}){const item={time:new Date().toISOString(),type,msg,...meta};state.logs.unshift(item);state.logs=state.logs.slice(0,80);state.lastActivity=item.time;fs.appendFileSync('./logs/activity.log',JSON.stringify(item)+'\n');}
function resetLink(){state.qr=null;state.pairingCode=null;state.attempts=0;}
function addMember(jid,name){if(!jid)return; if(!state.members[jid]) state.members[jid]={name:name||jid.split('@')[0],messages:0,commands:0,lastSeen:null}; state.members[jid].name=name||state.members[jid].name; state.members[jid].messages++; state.members[jid].lastSeen=new Date().toISOString();}

let sock;
async function startBot(){
  const {state:authState,saveCreds}=await useMultiFileAuthState(SESSION_DIR);
  const {version}=await fetchLatestBaileysVersion();
  sock=makeWASocket({version,auth:authState,logger:P({level:'silent'}),printQRInTerminal:false,browser:['Rana Bot','Chrome','1.0']});
  sock.ev.on('creds.update',saveCreds);
  sock.ev.on('connection.update',async ({connection,lastDisconnect,qr})=>{
    if(qr){state.qr=await QRCode.toDataURL(qr);state.pairingCode=null;state.status='SCAN_QR';log('QR','New QR generated');}
    if(connection==='open'){state.status='CONNECTED';state.connectedAt=new Date().toISOString();resetLink();log('SYSTEM','WhatsApp connected');}
    if(connection==='close'){
      state.status='DISCONNECTED';
      const code=lastDisconnect?.error?.output?.statusCode;
      log('SYSTEM','WhatsApp disconnected',{code});
      if(code!==DisconnectReason.loggedOut) setTimeout(startBot,3000); else log('SYSTEM','Logged out; delete session to relink');
    }
  });
  sock.ev.on('messages.upsert',async ({messages})=>{
    for(const m of messages){
      if(!m.message || m.key.fromMe) continue;
      const jid=m.key.remoteJid||'';
      if(!jid.endsWith('@g.us')) continue;
      const sender=m.key.participant||jid;
      const text=(m.message.conversation || m.message.extendedTextMessage?.text || '').trim();
      if(!text) continue;
      state.messages++; addMember(sender,m.pushName||sender.split('@')[0]);
      if(!text.toLowerCase().startsWith(PREFIX.toLowerCase())) continue;
      const query=text.slice(PREFIX.length).trim(); state.commands++; state.members[sender].commands++;
      log('COMMAND',query,{sender:m.pushName||sender.split('@')[0],group:jid});
      const lower=query.toLowerCase();
      if(lower==='help'||!query){await sock.sendMessage(jid,{text:`⚡ RANA COMMANDS\n\n${PREFIX} <sawal> — funny AI reply\n${PREFIX} song <name> — song search\n${PREFIX} help — commands\n\nExample: ${PREFIX} Ali kaha hai?`},{quoted:m});continue;}
      if(lower.startsWith('song')){const name=query.slice(4).trim(); if(!name){await sock.sendMessage(jid,{text:'🎵 Song ka naam bhejo. Example: !rana song Tum Hi Ho'},{quoted:m});continue;} state.songs++; const q=encodeURIComponent(name); await sock.sendMessage(jid,{text:`🎵 ${name}\n\nYouTube video: https://www.youtube.com/results?search_query=${q}\nAudio search: https://music.youtube.com/search?q=${q}\n\nOfficial/public result select kar lena.`},{quoted:m});continue;}
      const reply=await aiReply(query,m.pushName||'friend'); state.aiReplies += reply.usedAI?1:0;
      await sock.sendMessage(jid,{text:reply.text},{quoted:m});
    }
  });
}
async function aiReply(query,user){
  if(!process.env.OPENAI_API_KEY) return {usedAI:false,text:`😂 ${user} bhai, sawal to kamaal ka hai: “${query}”\n\nRana abhi AI key ke baghair demo mode mein hai. Dashboard mein OPENAI_API_KEY lagao to har sawal ka dynamic jawab milega 😎`};
  try{
    const r=await fetch('https://api.openai.com/v1/responses',{method:'POST',headers:{'Content-Type':'application/json','Authorization':`Bearer ${process.env.OPENAI_API_KEY}`},body:JSON.stringify({model:process.env.OPENAI_MODEL||'gpt-5.6-luna',input:[{role:'system',content:'You are Rana, a playful WhatsApp group assistant. Reply in natural Roman Urdu/Urdu. Be funny, friendly and concise. Never insult protected classes, threaten anyone, or claim real facts you do not know. If the user asks about a group member, make a light harmless joke based only on the question.'},{role:'user',content:query}]})});
    const data=await r.json(); const text=data.output_text || data.output?.flatMap(x=>x.content||[]).map(x=>x.text||'').join('') || '😅 Rana ko jawab nahi mila.'; return {usedAI:true,text};
  }catch(e){return {usedAI:false,text:`😅 AI connection issue aa gaya. Sawal dobara bhejo: ${PREFIX} ${query}`};}
}
app.get('/api/state',(req,res)=>res.json({...state,qr:state.qr?true:false,members:Object.values(state.members).sort((a,b)=>b.commands-a.commands).slice(0,10)}));
app.get('/api/qr',(req,res)=>res.json({qr:state.qr,pairingCode:state.pairingCode,status:state.status,attempts:state.attempts,maxAttempts:state.maxAttempts}));
app.post('/api/pair',async(req,res)=>{try{if(!sock) return res.status(503).json({error:'Bot starting'}); if(state.status==='CONNECTED') return res.json({status:'CONNECTED'}); const phone=String(req.body.phone||'').replace(/\D/g,''); if(!phone) return res.status(400).json({error:'Phone required'}); if(state.attempts>=state.maxAttempts){resetLink();} state.attempts++; const code=await sock.requestPairingCode(phone); state.pairingCode=code;state.qr=null;state.status='PAIRING_CODE';log('PAIRING','Pairing code generated',{attempt:state.attempts});res.json({pairingCode:code,attempts:state.attempts});}catch(e){res.status(500).json({error:e.message});}});
app.post('/api/reset',async(req,res)=>{try{if(fs.existsSync(SESSION_DIR)) fs.rmSync(SESSION_DIR,{recursive:true,force:true}); resetLink(); state.status='OFFLINE'; log('SYSTEM','Session reset; restart required'); res.json({ok:true});}catch(e){res.status(500).json({error:e.message});}});
app.get('/health',(req,res)=>res.json({ok:true,status:state.status}));
app.listen(PORT,'0.0.0.0',()=>{log('SYSTEM',`Dashboard listening on ${PORT}`);startBot().catch(e=>log('ERROR',e.message));});
