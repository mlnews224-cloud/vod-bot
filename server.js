require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const axios = require('axios');
const fs = require('fs');

// ─── CONFIG ────────────────────────────────────────────────
const TOKEN      = process.env.BOT_TOKEN;
const SERVER_URL = process.env.SERVER_URL;   // https://yourdomain.com
const PORT       = process.env.PORT || 3000;
const ADMIN_IDS  = (process.env.ADMIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
// ───────────────────────────────────────────────────────────

if (!TOKEN || !SERVER_URL) {
  console.error('❌ BOT_TOKEN dan SERVER_URL wajib diisi dalam .env');
  process.exit(1);
}

const bot = new TelegramBot(TOKEN, { polling: true });
const app = express();

// ─── DATABASE ──────────────────────────────────────────────
const DB_FILE = 'videos.json';

function loadDB() {
  try {
    if (fs.existsSync(DB_FILE)) return JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));
  } catch (_) {}
  return {};
}

function saveDB(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

let db = loadDB();
// ───────────────────────────────────────────────────────────

// ─── HELPERS ───────────────────────────────────────────────
function isAdmin(userId) {
  if (ADMIN_IDS.length === 0) return true;
  return ADMIN_IDS.includes(String(userId));
}

function formatBytes(bytes) {
  if (!bytes) return 'N/A';
  const mb = bytes / (1024 * 1024);
  return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GiB` : `${mb.toFixed(2)} MiB`;
}

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).substr(2, 6);
}

function getFileType(mimeType) {
  if (!mimeType) return 'Unknown';
  if (mimeType.startsWith('video/')) return 'Video';
  if (mimeType.startsWith('audio/')) return 'Audio';
  return mimeType.split('/')[1]?.toUpperCase() || 'File';
}
// ───────────────────────────────────────────────────────────

// ─── BOT: PROSES MEDIA ─────────────────────────────────────
async function handleMedia(msg, fileInfo, mimeType) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  if (!isAdmin(userId)) {
    return bot.sendMessage(chatId, '⛔ Anda tiada kebenaran untuk menggunakan bot ini.');
  }

  const processing = await bot.sendMessage(chatId, '⏳ Sedang memproses...');

  const rawTitle = fileInfo.file_name || `File_${Date.now()}`;
  const title = rawTitle.replace(/\.[^/.]+$/, '');
  const ext = rawTitle.includes('.') ? rawTitle.split('.').pop() : 'mp4';
  const id = generateId();

  db[id] = {
    id,
    title: rawTitle,
    titleClean: title,
    fileId: fileInfo.file_id,
    fileSize: fileInfo.file_size,
    mimeType: mimeType || 'video/mp4',
    ext,
    addedAt: new Date().toISOString(),
    addedBy: userId,
  };

  saveDB(db);

  const streamUrl   = `${SERVER_URL}/stream/${id}`;
  const downloadUrl = `${SERVER_URL}/download/${id}`;
  const host        = SERVER_URL.replace('https://', '').replace('http://', '');
  const fileType    = getFileType(mimeType);
  const size        = formatBytes(fileInfo.file_size);

  // ── Format sama macam File Stream Bot ──────────────────
  const text =
    `📄 *${rawTitle}*\n\n` +
    `┌ Size: \`${size}\`\n` +
    `└ Type: \`${fileType}\`\n\n` +
    `📥 Download\n\`${downloadUrl}\`\n\n` +
    `▶️ Stream\n\`${streamUrl}\``;

  const keyboard = {
    inline_keyboard: [
      [
        { text: '▶️ Stream ↗',    url: streamUrl },
        { text: '📥 Download ↗',  url: downloadUrl },
      ],
      [
        { text: '📱 VLC Mobile ↗', url: `https://${host}/stream/${id}` },
        { text: '💻 VLC PC ↗', url: `https://${host}/stream/${id}` },
      ],
      [
        { text: '📁 Get File ↗',  url: downloadUrl },
        { text: '🔗 Share ↗',     url: `https://t.me/share/url?url=${encodeURIComponent(streamUrl)}&text=${encodeURIComponent(rawTitle)}` },
      ],
    ],
  };

  await bot.deleteMessage(chatId, processing.message_id).catch(() => {});

  await bot.sendMessage(chatId, text, {
    parse_mode: 'Markdown',
    reply_markup: keyboard,
    reply_to_message_id: msg.message_id,
  });
}

// Terima video (Telegram compress — kurang kualiti)
bot.on('video', (msg) => handleMedia(msg, msg.video, 'video/mp4'));

// Terima dokumen — video/audio (tiada compression = KUALITI ASAL)
bot.on('document', (msg) => {
  const doc = msg.document;
  const mime = doc.mime_type || '';
  if (!mime.startsWith('video/') && !mime.startsWith('audio/')) return;
  handleMedia(msg, doc, mime);
});

// Terima audio
bot.on('audio', (msg) => handleMedia(msg, msg.audio, 'audio/mpeg'));
// ───────────────────────────────────────────────────────────

// ─── BOT: COMMANDS ─────────────────────────────────────────
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id,
    `🎬 *File Stream Bot*\n\n` +
    `Forward atau hantar fail video/audio ke sini.\n` +
    `Bot akan generate link Stream & Download.\n\n` +
    `📋 *Commands:*\n` +
    `/list — Senarai semua fail\n` +
    `/m3u — Link M3U untuk OTT Navigator\n` +
    `/search [nama] — Cari fail\n` +
    `/delete [ID] — Padam fail\n\n` +
    `⚠️ *Tip:* Hantar sebagai *File* untuk elak compression!`,
    { parse_mode: 'Markdown' }
  );
});

bot.onText(/\/m3u/, (msg) => {
  bot.sendMessage(msg.chat.id,
    `📋 *M3U Playlist:*\n\`${SERVER_URL}/playlist.m3u\`\n\n` +
    `Salin URL ke:\n• OTT Navigator → Add Playlist\n• TiviMate → Add Playlist\n• VLC → Open Network`,
    { parse_mode: 'Markdown' }
  );
});

bot.onText(/\/list/, (msg) => {
  const entries = Object.values(db);
  if (!entries.length) return bot.sendMessage(msg.chat.id, '📭 Tiada fail disimpan.');

  const chunks = [];
  let cur = `📚 *${entries.length} fail disimpan:*\n\n`;
  entries.slice(0, 20).forEach((v, i) => {
    const line = `${i + 1}. *${v.title}*\n▶️ \`${SERVER_URL}/stream/${v.id}\`\n\`ID: ${v.id}\`\n\n`;
    if ((cur + line).length > 4000) { chunks.push(cur); cur = line; }
    else cur += line;
  });
  chunks.push(cur);
  chunks.forEach(c => bot.sendMessage(msg.chat.id, c, { parse_mode: 'Markdown' }));
});

bot.onText(/\/delete (.+)/, (msg, match) => {
  if (!isAdmin(msg.from.id)) return bot.sendMessage(msg.chat.id, '⛔ Tiada kebenaran.');
  const id = match[1].trim();
  if (!db[id]) return bot.sendMessage(msg.chat.id, `❌ ID \`${id}\` tidak dijumpai.`, { parse_mode: 'Markdown' });
  const name = db[id].title;
  delete db[id]; saveDB(db);
  bot.sendMessage(msg.chat.id, `🗑️ *${name}* telah dipadam.`, { parse_mode: 'Markdown' });
});

bot.onText(/\/search (.+)/, (msg, match) => {
  const q = match[1].toLowerCase();
  const results = Object.values(db).filter(v => v.title.toLowerCase().includes(q));
  if (!results.length) return bot.sendMessage(msg.chat.id, `🔍 Tiada hasil untuk "${match[1]}".`);
  const text = results.slice(0, 10).map(v =>
    `📺 *${v.title}*\n▶️ \`${SERVER_URL}/stream/${v.id}\``
  ).join('\n\n');
  bot.sendMessage(msg.chat.id, `🔍 *Hasil (${results.length}):*\n\n${text}`, { parse_mode: 'Markdown' });
});
// ───────────────────────────────────────────────────────────

// ─── HTTP: M3U PLAYLIST ────────────────────────────────────
app.get('/playlist.m3u', (req, res) => {
  db = loadDB();
  const videos = Object.values(db).filter(v => v.mimeType?.startsWith('video/'));
  let m3u = '#EXTM3U\n';
  for (const v of videos) {
    m3u += `#EXTINF:-1 tvg-name="${v.titleClean || v.title}" group-title="VOD",${v.titleClean || v.title}\n`;
    m3u += `${SERVER_URL}/stream/${v.id}\n`;
  }
  res.setHeader('Content-Type', 'application/x-mpegURL; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.send(m3u);
});
// ───────────────────────────────────────────────────────────

// ─── HTTP: STREAM ──────────────────────────────────────────
app.get('/stream/:id', async (req, res) => {
  const v = db[req.params.id];
  if (!v) return res.status(404).send('Fail tidak dijumpai.');

  try {
    const fileRes = await axios.get(`https://api.telegram.org/bot${TOKEN}/getFile?file_id=${v.fileId}`);
    if (!fileRes.data.ok) throw new Error('getFile gagal');
    const tgUrl = `https://api.telegram.org/file/bot${TOKEN}/${fileRes.data.result.file_path}`;

    const headers = {};
    if (req.headers.range) headers['Range'] = req.headers.range;

    const tgRes = await axios.get(tgUrl, { responseType: 'stream', headers });

    res.setHeader('Content-Type', v.mimeType || 'video/mp4');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(v.title)}"`);
    if (tgRes.headers['content-length']) res.setHeader('Content-Length', tgRes.headers['content-length']);
    if (tgRes.headers['content-range'])  { res.setHeader('Content-Range', tgRes.headers['content-range']); res.status(206); }

    tgRes.data.pipe(res);
    req.on('close', () => tgRes.data.destroy());
  } catch (err) {
    console.error('Stream error:', err.message);
    res.status(500).send('Gagal stream dari Telegram.');
  }
});
// ───────────────────────────────────────────────────────────

// ─── HTTP: DOWNLOAD ────────────────────────────────────────
app.get('/download/:id', async (req, res) => {
  const v = db[req.params.id];
  if (!v) return res.status(404).send('Fail tidak dijumpai.');

  try {
    const fileRes = await axios.get(`https://api.telegram.org/bot${TOKEN}/getFile?file_id=${v.fileId}`);
    if (!fileRes.data.ok) throw new Error('getFile gagal');
    const tgUrl = `https://api.telegram.org/file/bot${TOKEN}/${fileRes.data.result.file_path}`;

    const tgRes = await axios.get(tgUrl, { responseType: 'stream' });

    res.setHeader('Content-Type', v.mimeType || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(v.title)}"`);
    if (tgRes.headers['content-length']) res.setHeader('Content-Length', tgRes.headers['content-length']);

    tgRes.data.pipe(res);
    req.on('close', () => tgRes.data.destroy());
  } catch (err) {
    console.error('Download error:', err.message);
    res.status(500).send('Gagal download dari Telegram.');
  }
});
// ───────────────────────────────────────────────────────────

app.get('/', (req, res) => {
  res.json({ status: 'online', files: Object.keys(db).length, playlist: `${SERVER_URL}/playlist.m3u` });
});

app.listen(PORT, () => {
  console.log(`✅ Bot running | Port: ${PORT} | Playlist: ${SERVER_URL}/playlist.m3u`);
});
