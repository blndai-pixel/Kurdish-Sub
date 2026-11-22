// Vercel Function - ژێرنووس دەهێنێت و وەری دەگێڕێت
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
  if (!tracks || !tracks.length) {
    const why = data?.playabilityStatus?.reason;
    throw new Error(why ? 'یوتووب ڕێگری کرد: ' + why : 'ئەم ڤیدیۆیە ژێرنووسی نییە');
  }
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
