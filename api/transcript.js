// Vercel Function - ژێرنووس دەهێنێت و وەری دەگێڕێت
// چەند ڕێگایەک تاقی دەکاتەوە (ANDROID / IOS / TV / WEB / پەڕەی ڤیدیۆ)
const cache = new Map();

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const CLIENTS = [
  { name: 'ANDROID', ua: 'com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip',
    ctx: { client: { clientName: 'ANDROID', clientVersion: '20.10.38', androidSdkVersion: 30, hl: 'en' } } },
  { name: 'IOS', ua: 'com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)',
    ctx: { client: { clientName: 'IOS', clientVersion: '20.10.4', deviceMake: 'Apple', deviceModel: 'iPhone16,2', osName: 'iPhone', osVersion: '18.3.2.22D82', hl: 'en' } } },
  { name: 'TV_EMBED', ua: BROWSER_UA,
    ctx: { client: { clientName: 'TVHTML5_SIMPLY_EMBEDDED_PLAYER', clientVersion: '2.0', hl: 'en' }, thirdParty: { embedUrl: 'https://www.google.com' } } },
  { name: 'WEB', ua: BROWSER_UA,
    ctx: { client: { clientName: 'WEB', clientVersion: '2.20250312.04.00', hl: 'en' } } },
];

function pickTrack(tracks) {
  return tracks.find(t => t.kind !== 'asr') || tracks[0];
}

async function fetchTrackLines(track, ua) {
  const res = await fetch(track.baseUrl + '&fmt=json3', { headers: { 'User-Agent': ua } });
  const text = await res.text();
  if (!text || !text.trim()) throw new Error('empty-timedtext');
  const json = JSON.parse(text);
  const lines = [];
  for (const ev of json.events || []) {
    if (!ev.segs) continue;
    const t = ev.segs.map(s => s.utf8).join('').replace(/\s*\n\s*/g, ' ').trim();
    if (!t) continue;
    const start = ev.tStartMs / 1000;
    lines.push({ start, end: start + (ev.dDurationMs || 2000) / 1000, text: t });
  }
  if (!lines.length) throw new Error('no-lines');
  return lines;
}

async function viaClient(c, videoId) {
  const r = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': c.ua },
    body: JSON.stringify({ context: c.ctx, videoId, contentCheckOk: true, racyCheckOk: true }),
  });
  const data = await r.json();
  const st = data?.playabilityStatus?.status || '?';
  const tracks = data?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  if (!tracks || !tracks.length) return { diag: `${c.name}:${st}:no-tracks` };
  const track = pickTrack(tracks);
  try {
    const lines = await fetchTrackLines(track, c.ua);
    return { title: data.videoDetails?.title || '', lang: track.languageCode, lines };
  } catch (e) {
    return { diag: `${c.name}:${st}:${e.message}` };
  }
}

async function viaWatchPage(videoId) {
  const r = await fetch(`https://www.youtube.com/watch?v=${videoId}&hl=en&bpctr=9999999999&has_verified=1`, {
    headers: { 'User-Agent': BROWSER_UA, 'Accept-Language': 'en-US,en;q=0.9', Cookie: 'SOCS=CAI; CONSENT=YES+1' },
  });
  const html = await r.text();
  const m = html.match(/ytInitialPlayerResponse\s*=\s*(\{.+?\})\s*;\s*(?:var\s|<\/script>)/s);
  if (!m) return { diag: 'PAGE:no-player-response' };
  const data = JSON.parse(m[1]);
  const st = data?.playabilityStatus?.status || '?';
  const tracks = data?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  if (!tracks || !tracks.length) return { diag: `PAGE:${st}:no-tracks` };
  const track = pickTrack(tracks);
  try {
    const lines = await fetchTrackLines(track, BROWSER_UA);
    return { title: data.videoDetails?.title || '', lang: track.languageCode, lines };
  } catch (e) {
    return { diag: `PAGE:${st}:${e.message}` };
  }
}

async function getCaptions(videoId) {
  const diags = [];
  for (const c of CLIENTS) {
    try {
      const r = await viaClient(c, videoId);
      if (r.lines) return r;
      diags.push(r.diag);
    } catch (e) { diags.push(`${c.name}:err:${e.message}`); }
  }
  try {
    const r = await viaWatchPage(videoId);
    if (r.lines) return r;
    diags.push(r.diag);
  } catch (e) { diags.push(`PAGE:err:${e.message}`); }
  throw new Error('ژێرنووس نەدۆزرایەوە (یان یوتووب ڕێگری کرد) — ' + diags.join(' | '));
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
    : await mapLimit(cap.lines, 12, l => translate(l.text, target));
  const result = {
    title: cap.title,
    sourceLang: cap.lang,
    lines: cap.lines.map((l, i) => ({ start: l.start, end: l.end, text: l.text, tr: tr[i] })),
  };
  cache.set(key, result);
  return result;
}

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  try {
    const v = req.query.v;
    if (!/^[\w-]{11}$/.test(v || '')) throw new Error('لینکی ڤیدیۆ هەڵەیە');
    const data = await buildTranscript(v, req.query.lang || 'ckb');
    res.status(200).send(JSON.stringify(data));
  } catch (e) {
    res.status(400).send(JSON.stringify({ error: e.message }));
  }
};
