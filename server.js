// سێرڤەری ژێرنووس - Node.js 18+ (هیچ پاکێجێکی زیادە ناوێت)
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const cache = new Map();

async function getCaptions(videoId) {
  const r = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip',
    },
    body: JSON.stringify({
      context: { client: { clientName: 'ANDROID', clientVersion: '20.10.38', androidSdkVersion: 30, hl: 'en' } },
      videoId,
    }),
  });
  const data = await r.json();
  const tracks = data?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  if (!tracks || !tracks.length) throw new Error('ئەم ڤیدیۆیە ژێرنووسی نییە');
  const track = tracks.find(t => t.kind !== 'asr') || tracks[0];
  const res = await fetch(track.baseUrl + '&fmt=json3');
  const json = await res.json();
  const lines = [];
  for (const ev of json.events || []) {
    if (!ev.segs) continue;
    const text = ev.segs.map(s => s.utf8).join('').replace(/\s*\n\s*/g, ' ').trim();
    if (!text) continue;
    const start = ev.tStartMs / 1000;
    lines.push({ start, end: start + (ev.dDurationMs || 2000) / 1000, text });
  }
  return { title: data.videoDetails?.title || '', lang: track.languageCode, lines };
}

async function translate(text, tl) {
  const u = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${tl}&dt=t&q=${encodeURIComponent(text)}`;
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(u);
      const j = await r.json();
      return j[0].map(s => s[0]).join('');
    } catch (e) { await new Promise(r => setTimeout(r, 400)); }
  }
  return text;
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: limit }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

async function buildTranscript(videoId, target) {
  const key = videoId + ':' + target;
  if (cache.has(key)) return cache.get(key);
  const cap = await getCaptions(videoId);
  const base = cap.lang.split('-')[0];
  const tr = base === target ? cap.lines.map(l => l.text)
    : await mapLimit(cap.lines, 8, l => translate(l.text, target));
  const result = {
    title: cap.title,
    sourceLang: cap.lang,
    lines: cap.lines.map((l, i) => ({ start: l.start, end: l.end, text: l.text, tr: tr[i] })),
  };
  cache.set(key, result);
  return result;
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/api/transcript') {
    try {
      const v = url.searchParams.get('v');
      if (!/^[\w-]{11}$/.test(v || '')) throw new Error('لینکی ڤیدیۆ هەڵەیە');
      const data = await buildTranscript(v, url.searchParams.get('lang') || 'ckb');
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(data));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  const file = path.join(__dirname, 'public', url.pathname === '/' ? 'index.html' : url.pathname);
  if (!file.startsWith(path.join(__dirname, 'public')) || !fs.existsSync(file)) {
    res.writeHead(404); return res.end('Not found');
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}).listen(PORT, () => console.log('http://localhost:' + PORT));
