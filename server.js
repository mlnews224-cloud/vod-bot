require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const axios = require('axios');
const fs = require('fs');

const TOKEN      = process.env.BOT_TOKEN;
const SERVER_URL = process.env.SERVER_URL;
const PORT       = process.env.PORT || 3000;
const ADMIN_IDS  = (process.env.ADMIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean);

if (!TOKEN || !SERVER_URL) {
  console.error('BOT_TOKEN dan SERVER_URL wajib diisi dalam .env');
  process.exit(1);
}

const bot = new TelegramBot(TOKEN, { polling: true });
const app = express();

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

async function handleMedia(msg, fileInfo, mimeType) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  if (!isAdmin(userId)) {
    return bot.sendMessage(chatId, 'Anda tiada kebenaran untuk menggunakan bot ini.');
  }

  const processing = await bot.sendMessage(chatId, 'Sedang memproses...');

  const rawTitle = fileInfo.file_name || `File_${Date.now()}`;
  const title = rawTitle.replace(/\.[^/.]+$/, '');
  const id = generateId();

  db[id] = {
    id,
    title: rawTitle,
    titleClean: title,
    fileId: fileInfo.file_id,
    fileSize: fileInfo.file_size,
    mimeType: mimeType || 'video/mp4',
    addedAt: new Date().toISOString(),
    addedBy: userId,
  };

  saveDB(db);

  const streamUrl   = `${SERVER_URL}/stream/${id}`;
  const downloadUrl = `${SERVER_URL}/download/${id}`;
  const fileType    = getFileType(mimeType);
  const size        = formatBytes(fileInfo.file_size);

  const text =
    `*${rawTitle}*\n\n` +
    `Size: \`${size}\`\n` +
    `Type: \`${fileType}\`\n\n` +
    `Download\n\`${downloadUrl}\`\n\n` +
    `Stream\n\`${streamUrl}\``;

  const keyboard = {
    inline_keyboard: [
      [
        { text: 'Stream', url: streamUrl },
        { text: 'Download', url: downloadUrl },
      ],
      [
        { text: 'Get File', url: downloadUrl },
        { text: 'Share', url: `https://t.me/share/url?url=${encodeURIComponent(streamUrl)}&text=${encodeURIComponent(rawTitle)}` },
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

bot.on('video', (msg) => handleMedia(msg, msg.video, 'video/mp4'));

bot.on('document', (msg) => {
  const doc = msg.document;
  const mime = doc.mime_type || '';
  if (!mime.startsWith('video/') && !mime.startsWith('audio/')) return;
  handleMedia(msg, doc, mime);
});

bot.on('audio', (msg) => handleMedia(msg, msg.audio, 'audio/mpeg'));

bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id,
    `*File Stream Bot*\n\n` +
    `Forward atau hantar fail video/audio ke sini.\n` +
    `Bot akan generate link Stream dan Download.\n\n` +
    `Commands:\n` +
    `/list - Senarai semua fail\n` +
    `/m3u - Link M3U untuk OTT Navigator\n` +
    `/search nama - Cari fail\n` +
    `/delete ID - Padam fail\n\n` +
    `Tip: Hantar sebagai File untuk elak compression!`,
    { parse_mode: 'Markdown' }
  );
});

bot.onText(/\/m3u/, (msg) => {
  bot.sendMessage(msg.chat.id,
    `*M3U Playlist:*\n\`${SERVER_URL}/playlist.m3u\`\n\n` +
    `Salin URL ke OTT Navigator atau TiviMate.`,
    { parse_mode: 'Markdown' }
  );
});

bot.onText(/\/list/, (msg) => {
  const entries = Object.values(db);
  if (!entries.length) return bot.sendMessage(msg.chat.id, 'Tiada fail disimpan.');
  const text = entries.slice(0, 20).map((v, i) =>
    `${i + 1}. *${v.title}*\n${SERVER_URL}/stream/${v.id}\nID: \`${v.id}\``
  ).join('\n\n');
  bot.sendMessage(msg.chat.id, text, { parse_mode: 'Markdown' });
});

bot.onText(/\/delete (.+)/, (msg, match) => {
  if (!isAdmin(msg.from.id)) return bot.sendMessage(msg.chat.id, 'Tiada kebenaran.');
  const id = match[1].trim();
  if (!db[id]) return bot.sendMessage(msg.chat.id, `ID ${id} tidak dijumpai.`);
  const name = db[id].title;
  delete db[id]; saveDB(db);
  bot.sendMessage(msg.chat.id, `${name} telah dipadam.`);
});

bot.onText(/\/search (.+)/, (msg, match) => {
  const q = match[1].toLowerCase();
  const results = Object.values(db).filter(v => v.title.toLowerCase().includes(q));
  if (!results.length) return bot.sendMessage(msg.chat.id, `Tiada hasil untuk "${match[1]}".`);
  const text = results.slice(0, 10).map(v =>
    `*${v.title}*\n${SERVER_URL}/stream/${v.id}`
  ).join('\n\n');
  bot.sendMessage(msg.chat.id, text, { parse_mode: 'Markdown' });
});

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
    if (tgRes.headers['content-range']) { res.setHeader('Content-Range', tgRes.headers['content-range']); res.status(206); }
    tgRes.data.pipe(res);
    req.on('close', () => tgRes.data.destroy());
  } catch (err) {
    console.error('Stream error:', err.message);
    res.status(500).send('Gagal stream dari Telegram.');
  }
});

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

app.get('/', (req, res) => {
  res.json({ status: 'online', files: Object.keys(db).length, playlist: `${SERVER_URL}/playlist.m3u` });
});

app.listen(PORT, () => {
  console.log(`Bot running | Port: ${PORT}`);
});
