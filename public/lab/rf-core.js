// Generated from public/lab/rally-finder.html by scripts/gen-rf-core.mjs. Do not edit: change the page, then run the script.
(() => {

const RF = (() => {
  'use strict';
  const RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
  const fourcc = (u8, o) => String.fromCharCode(u8[o], u8[o + 1], u8[o + 2], u8[o + 3]);
  const dvOf = (u8) => new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const u64 = (dv, o) => dv.getUint32(o) * 4294967296 + dv.getUint32(o + 4);

  async function readRange(file, start, end) {
    return new Uint8Array(await file.slice(start, end).arrayBuffer());
  }

  async function walkTop(file) {
    const out = [];
    const size = file.size;
    let off = 0;
    for (let guard = 0; off + 8 <= size && guard < 100000; guard++) {
      const h = await readRange(file, off, Math.min(size, off + 16));
      const dv = dvOf(h);
      let s = dv.getUint32(0), hdr = 8;
      const type = fourcc(h, 4);
      if (s === 1) {
        if (h.length < 16) throw new Error('The file ends inside a box header.');
        s = u64(dv, 8); hdr = 16;
      } else if (s === 0) {
        s = size - off;
      }
      if (s < hdr) throw new Error(`The box "${type}" at byte ${off} has a bad size (${s}). The file may be damaged.`);
      out.push({ type, start: off, size: s, hdr, truncated: off + s > size });
      off += s;
    }
    return out;
  }

  function children(u8, start, end) {
    const dv = dvOf(u8);
    const out = [];
    let o = start;
    while (o + 8 <= end) {
      let s = dv.getUint32(o), h = 8;
      const t = fourcc(u8, o + 4);
      if (s === 1) { s = u64(dv, o + 8); h = 16; } else if (s === 0) { s = end - o; }
      if (s < h || o + s > end) break;
      out.push({ type: t, start: o, size: s, body: o + h, end: o + s });
      o += s;
    }
    return out;
  }
  const kids = (u8, box) => children(u8, box.body, box.end);
  function find(u8, box, path) {
    let cur = box;
    for (const t of path.split('/')) {
      cur = kids(u8, cur).find((b) => b.type === t);
      if (!cur) return null;
    }
    return cur;
  }
  function deepFind(u8, start, end, type) {
    for (const b of children(u8, start, end)) {
      if (b.type === type) return b;
      if (b.type === 'wave') { const r = deepFind(u8, b.body, b.end, type); if (r) return r; }
    }
    return null;
  }

  function parseEsds(u8, box) {
    let o = box.body + 4;
    const end = box.end;
    const readLen = () => { let len = 0; for (let i = 0; i < 4; i++) { const b = u8[o++]; len = (len << 7) | (b & 0x7f); if (!(b & 0x80)) break; } return len; };
    while (o < end) {
      const tag = u8[o++];
      const len = readLen();
      if (tag === 0x03) { o += 2; const fl = u8[o++]; if (fl & 0x80) o += 2; if (fl & 0x40) o += 1 + u8[o]; if (fl & 0x20) o += 2; continue; }
      if (tag === 0x04) { o += 13; continue; }
      if (tag === 0x05) return u8.slice(o, o + len);
      o += len;
    }
    return null;
  }

  function parseAsc(asc) {
    let bit = 0;
    const rd = (n) => { let v = 0; for (let i = 0; i < n; i++) { v = (v << 1) | ((asc[bit >> 3] >> (7 - (bit & 7))) & 1); bit++; } return v; };
    let ot = rd(5); if (ot === 31) ot = 32 + rd(6);
    const fi = rd(4);
    const rate = fi === 15 ? rd(24) : RATES[fi];
    const ch = rd(4);
    let coreOt = ot, sbr = false;
    if (ot === 5 || ot === 29) { sbr = true; const efi = rd(4); if (efi === 15) rd(24); coreOt = rd(5); if (coreOt === 31) coreOt = 32 + rd(6); }
    return { objectType: ot, coreObjectType: coreOt, freqIndex: fi, rate, channelConfig: ch, sbr };
  }

  function parseAudioEntry(u8, dv, e) {
    const p = e.body + 8;
    const ver = dv.getUint16(p);
    const a = { entryVersion: ver, channels: dv.getUint16(p + 8), bits: dv.getUint16(p + 10), sampleRate: dv.getUint32(p + 16) / 65536 };
    let q = p + 20;
    if (ver === 1) {
      a.samplesPerPacket = dv.getUint32(q); a.bytesPerPacket = dv.getUint32(q + 4); a.bytesPerFrameV1 = dv.getUint32(q + 8); a.bytesPerSample = dv.getUint32(q + 12);
      q += 16;
    } else if (ver === 2) {
      a.sampleRate = dv.getFloat64(q + 4); a.channels = dv.getUint32(q + 12); a.bits = dv.getUint32(q + 20);
      a.lpcmFlags = dv.getUint32(q + 24); a.bytesPerFrameV2 = dv.getUint32(q + 28); a.framesPerPacket = dv.getUint32(q + 32);
      q += 36;
    }
    const esds = deepFind(u8, q, e.end, 'esds');
    if (esds) { a.asc = parseEsds(u8, esds); if (a.asc) a.ascInfo = parseAsc(a.asc); }
    const enda = deepFind(u8, q, e.end, 'enda');
    if (enda) a.endaLittle = dv.getUint16(enda.body) === 1;
    return a;
  }

  function parseTrak(u8, dv, trak) {
    const t = {};
    const tkhd = find(u8, trak, 'tkhd');
    if (tkhd) {
      const v = u8[tkhd.body];
      const base = tkhd.body + (v === 1 ? 52 : 40);
      const a = dv.getInt32(base) / 65536, b = dv.getInt32(base + 4) / 65536;
      t.rotation = (Math.round(Math.atan2(b, a) * 180 / Math.PI) + 360) % 360;
    }
    const mdhd = find(u8, trak, 'mdia/mdhd');
    if (!mdhd) throw new Error('A track has no mdhd box.');
    if (u8[mdhd.body] === 1) { t.timescale = dv.getUint32(mdhd.body + 20); t.durUnits = u64(dv, mdhd.body + 24); }
    else { t.timescale = dv.getUint32(mdhd.body + 12); t.durUnits = dv.getUint32(mdhd.body + 16); }
    t.durationSec = t.timescale ? t.durUnits / t.timescale : 0;
    const hdlr = find(u8, trak, 'mdia/hdlr');
    t.handler = hdlr ? fourcc(u8, hdlr.body + 8) : '????';
    const stbl = find(u8, trak, 'mdia/minf/stbl');
    if (!stbl) return t;
    const sb = {};
    for (const b of kids(u8, stbl)) sb[b.type] = b;
    if (sb.stsd) {
      const entries = children(u8, sb.stsd.body + 8, sb.stsd.end);
      const e = entries[0];
      if (e) {
        t.codec = e.type;
        if (t.handler === 'soun') Object.assign(t, parseAudioEntry(u8, dv, e));
        else if (t.handler === 'vide') { t.width = dv.getUint16(e.body + 24); t.height = dv.getUint16(e.body + 26); }
      }
    }
    if (sb.stts) {
      const n = dv.getUint32(sb.stts.body + 4);
      t.stts = { counts: new Uint32Array(n), deltas: new Uint32Array(n) };
      for (let i = 0; i < n; i++) { t.stts.counts[i] = dv.getUint32(sb.stts.body + 8 + i * 8); t.stts.deltas[i] = dv.getUint32(sb.stts.body + 12 + i * 8); }
    }
    if (sb.stsc) {
      const n = dv.getUint32(sb.stsc.body + 4);
      t.stsc = { first: new Uint32Array(n), spc: new Uint32Array(n) };
      for (let i = 0; i < n; i++) { t.stsc.first[i] = dv.getUint32(sb.stsc.body + 8 + i * 12); t.stsc.spc[i] = dv.getUint32(sb.stsc.body + 12 + i * 12); }
    }
    if (sb.stsz) {
      const size = dv.getUint32(sb.stsz.body + 4), count = dv.getUint32(sb.stsz.body + 8);
      let sizes = null;
      if (size === 0) { sizes = new Uint32Array(count); for (let i = 0; i < count; i++) sizes[i] = dv.getUint32(sb.stsz.body + 12 + i * 4); }
      t.stsz = { size, count, sizes };
    } else if (sb.stz2) {
      const fs = u8[sb.stz2.body + 7], count = dv.getUint32(sb.stz2.body + 8);
      const sizes = new Uint32Array(count);
      const o = sb.stz2.body + 12;
      for (let i = 0; i < count; i++) {
        sizes[i] = fs === 16 ? dv.getUint16(o + i * 2) : fs === 8 ? u8[o + i] : ((u8[o + (i >> 1)] >> ((i & 1) ? 0 : 4)) & 15);
      }
      t.stsz = { size: 0, count, sizes };
    }
    if (sb.stco) {
      const n = dv.getUint32(sb.stco.body + 4);
      t.chunkOffsets = new Float64Array(n);
      for (let i = 0; i < n; i++) t.chunkOffsets[i] = dv.getUint32(sb.stco.body + 8 + i * 4);
    } else if (sb.co64) {
      const n = dv.getUint32(sb.co64.body + 4);
      t.chunkOffsets = new Float64Array(n);
      for (let i = 0; i < n; i++) t.chunkOffsets[i] = u64(dv, sb.co64.body + 8 + i * 8);
      t.co64 = true;
    }
    if (sb.stss) {
      const n = dv.getUint32(sb.stss.body + 4);
      t.stss = new Uint32Array(n);
      for (let i = 0; i < n; i++) t.stss[i] = dv.getUint32(sb.stss.body + 8 + i * 4);
    }
    if (sb.ctts) {
      const n = dv.getUint32(sb.ctts.body + 4);
      t.ctts = { counts: new Uint32Array(n), offs: new Int32Array(n) };
      for (let i = 0; i < n; i++) { t.ctts.counts[i] = dv.getUint32(sb.ctts.body + 8 + i * 8); t.ctts.offs[i] = dv.getInt32(sb.ctts.body + 12 + i * 8); }
    }
    const elst = find(u8, trak, 'edts/elst');
    if (elst && dv.getUint32(elst.body + 4) >= 1) {
      const v = u8[elst.body];
      const n = dv.getUint32(elst.body + 4), w = v === 1 ? 20 : 12;
      for (let i = 0; i < n; i++) {
        const o = elst.body + 8 + i * w;
        const mt = v === 1 ? Number(dv.getBigInt64(o + 8)) : dv.getInt32(o + 4);
        if (mt >= 0) { t.mediaTime = mt; break; }
      }
    }
    const raw = (b) => (b ? u8.slice(b.start, b.end) : null);
    t.raw = { tkhd: raw(tkhd), hdlr: raw(hdlr), stsd: raw(sb.stsd), mhd: raw(find(u8, trak, 'mdia/minf/vmhd') || find(u8, trak, 'mdia/minf/smhd')) };
    t.sampleCount = t.stsz ? t.stsz.count : 0;
    return t;
  }

  function parseMoov(u8) {
    const dv = dvOf(u8);
    const root = children(u8, 0, u8.length)[0];
    if (!root || root.type !== 'moov') throw new Error('The moov box is not readable.');
    const res = { timescale: 0, durationSec: 0, createdSec: 0, tracks: [] };
    for (const b of kids(u8, root)) {
      if (b.type === 'mvhd') {
        const v = u8[b.body];
        const made = v === 1 ? u64(dv, b.body + 4) : dv.getUint32(b.body + 4);
        res.createdSec = made > 2082844800 ? made - 2082844800 : 0;
        if (v === 1) { res.timescale = dv.getUint32(b.body + 20); res.durationSec = u64(dv, b.body + 24) / res.timescale; }
        else { res.timescale = dv.getUint32(b.body + 12); res.durationSec = dv.getUint32(b.body + 16) / res.timescale; }
      } else if (b.type === 'trak') {
        try { res.tracks.push(parseTrak(u8, dv, b)); } catch (e) { res.tracks.push({ error: String(e && e.message || e) }); }
      }
    }
    return res;
  }

  const PCM_CODECS = ['sowt', 'twos', 'lpcm', 'in24', 'in32', 'fl32', 'fl64', 'raw '];
  function pcmFormat(t) {
    const c = t.codec;
    let bits = t.bits || 16, float = false, le = false, unsigned = false;
    if (c === 'sowt') { le = true; bits = t.bits === 8 ? 8 : 16; }
    else if (c === 'twos') { le = false; bits = t.bits === 8 ? 8 : 16; }
    else if (c === 'in24') { bits = 24; le = !!t.endaLittle; }
    else if (c === 'in32') { bits = 32; le = !!t.endaLittle; }
    else if (c === 'fl32') { bits = 32; float = true; le = !!t.endaLittle; }
    else if (c === 'fl64') { bits = 64; float = true; le = !!t.endaLittle; }
    else if (c === 'raw ') { bits = 8; unsigned = true; }
    else if (c === 'lpcm') {
      const f = t.lpcmFlags || 0;
      float = !!(f & 1); le = !(f & 2);
      if (t.bytesPerFrameV2 && t.channels) bits = (t.bytesPerFrameV2 / t.channels) * 8;
    }
    const channels = t.channels || 1;
    return { bits, float, le, unsigned, channels, bytesPerFrame: channels * bits / 8 };
  }
  function trackKind(t) {
    if (t.codec === 'mp4a' && t.asc) return 'aac';
    if (PCM_CODECS.includes(t.codec)) return 'pcm';
    return null;
  }

  function sampleTable(t) {
    const n = t.stsz.count;
    const sizes = t.stsz.sizes || new Uint32Array(n).fill(t.stsz.size);
    const offs = new Float64Array(n);
    const co = t.chunkOffsets, sc = t.stsc;
    let s = 0;
    for (let e = 0; e < sc.first.length; e++) {
      const c0 = sc.first[e] - 1;
      const c1 = e + 1 < sc.first.length ? sc.first[e + 1] - 1 : co.length;
      const spc = sc.spc[e];
      for (let c = c0; c < c1 && s < n; c++) {
        let o = co[c];
        for (let k = 0; k < spc && s < n; k++) { offs[s] = o; o += sizes[s]; s++; }
      }
    }
    return { offs, sizes, n: s };
  }

  function pcmChunks(t, fmt) {
    const co = t.chunkOffsets, sc = t.stsc;
    const unit = t.stsz ? t.stsz.size : 1;
    const per = unit > 1 ? unit : fmt.bytesPerFrame;
    const chunks = [];
    for (let e = 0; e < sc.first.length; e++) {
      const c0 = sc.first[e] - 1;
      const c1 = e + 1 < sc.first.length ? sc.first[e + 1] - 1 : co.length;
      for (let c = c0; c < c1; c++) chunks.push({ start: co[c], end: co[c] + sc.spc[e] * per });
    }
    return chunks;
  }

  function planRanges(offs, sizes, i0, i1, maxGap) {
    const ranges = [];
    const map = new Int32Array(i1 - i0);
    let rs = offs[i0], re = offs[i0] + sizes[i0];
    map[0] = 0;
    for (let i = i0 + 1; i < i1; i++) {
      const o = offs[i], e = o + sizes[i];
      if (o >= re && o - re <= maxGap) { re = e; }
      else if (!(o >= rs && e <= re)) { ranges.push({ start: rs, end: re }); rs = o; re = e; }
      map[i - i0] = ranges.length;
    }
    ranges.push({ start: rs, end: re });
    return { ranges, map };
  }

  function pcmToMono(u8, fmt) {
    const dv = dvOf(u8);
    const bpc = fmt.bits / 8, bpf = fmt.bytesPerFrame, ch = fmt.channels, le = fmt.le;
    const n = Math.floor(u8.length / bpf);
    const out = new Float32Array(n);
    const inv = 1 / ch;
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let c = 0; c < ch; c++) {
        const o = i * bpf + c * bpc;
        let v;
        if (fmt.float) v = bpc === 4 ? dv.getFloat32(o, le) : dv.getFloat64(o, le);
        else if (bpc === 2) v = dv.getInt16(o, le) / 32768;
        else if (bpc === 3) { v = le ? (u8[o] | (u8[o + 1] << 8) | (u8[o + 2] << 16)) : ((u8[o] << 16) | (u8[o + 1] << 8) | u8[o + 2]); if (v & 0x800000) v -= 0x1000000; v /= 8388608; }
        else if (bpc === 4) v = dv.getInt32(o, le) / 2147483648;
        else v = fmt.unsigned ? (u8[o] - 128) / 128 : ((u8[o] << 24) >> 24) / 128;
        s += v;
      }
      out[i] = s * inv;
    }
    return out;
  }

  function adtsFreqIndex(cfg) {
    if (cfg.freqIndex !== 15) return cfg.freqIndex;
    let best = 3, d = 1e9;
    RATES.forEach((r, i) => { if (Math.abs(r - cfg.rate) < d) { d = Math.abs(r - cfg.rate); best = i; } });
    return best;
  }
  function adtsHeader(cfg, payloadLen, channels) {
    const len = payloadLen + 7;
    const prof = ((cfg.coreObjectType || 2) - 1) & 3;
    const fi = adtsFreqIndex(cfg) & 15;
    const ch = (cfg.channelConfig || Math.min(channels || 2, 7)) & 7;
    return [0xFF, 0xF1, (prof << 6) | (fi << 2) | (ch >> 2), ((ch & 3) << 6) | ((len >> 11) & 3), (len >> 3) & 0xFF, ((len & 7) << 5) | 0x1F, 0xFC];
  }
  function buildAdts(frames, cfg, channels) {
    let total = 0;
    for (const f of frames) total += f.length + 7;
    const out = new Uint8Array(total);
    let o = 0;
    for (const f of frames) { out.set(adtsHeader(cfg, f.length, channels), o); out.set(f, o + 7); o += f.length + 7; }
    return out;
  }
  const be32 = (v) => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
  const be16 = (v) => [(v >>> 8) & 255, v & 255];
  const str4 = (s) => [s.charCodeAt(0), s.charCodeAt(1), s.charCodeAt(2), s.charCodeAt(3)];
  const fullHdr = (v, f) => [v, (f >> 16) & 255, (f >> 8) & 255, f & 255];
  function bx(type, ...parts) {
    const flat = parts.map((p) => (p instanceof Uint8Array ? p : Uint8Array.from(p)));
    const len = 8 + flat.reduce((a, p) => a + p.length, 0);
    const out = new Uint8Array(len);
    out.set(be32(len)); out.set(str4(type), 4);
    let o = 8;
    for (const p of flat) { out.set(p, o); o += p.length; }
    return out;
  }
  const MATRIX = [0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000].flatMap(be32);
  function buildM4a(frames, asc, sampleRate, channels) {
    const n = frames.length;
    const sr = Math.round(sampleRate);
    const spf = 1024;
    const dsi = [5, asc.length, ...asc];
    const dcd = [4, 13 + dsi.length, 0x40, 0x15, 0, 0, 0, ...be32(0), ...be32(0), ...dsi];
    const es = [3, 3 + dcd.length + 3, 0, 1, 0, ...dcd, 6, 1, 2];
    const esds = bx('esds', fullHdr(0, 0), es);
    const mp4a = bx('mp4a', [0, 0, 0, 0, 0, 0, 0, 1], [0, 0, 0, 0, 0, 0, 0, 0], be16(channels), be16(16), [0, 0, 0, 0], be32((sr & 0xffff) * 65536), esds);
    const sizes = new Uint8Array(n * 4);
    let dataLen = 0;
    frames.forEach((f, i) => { sizes.set(be32(f.length), i * 4); dataLen += f.length; });
    const durMs = Math.round(n * spf * 1000 / sr);
    const make = (off) => {
      const stbl = bx('stbl', bx('stsd', fullHdr(0, 0), be32(1), mp4a), bx('stts', fullHdr(0, 0), be32(1), be32(n), be32(spf)),
        bx('stsc', fullHdr(0, 0), be32(1), be32(1), be32(n), be32(1)), bx('stsz', fullHdr(0, 0), be32(0), be32(n), sizes), bx('stco', fullHdr(0, 0), be32(1), be32(off)));
      const minf = bx('minf', bx('smhd', fullHdr(0, 0), be16(0), be16(0)), bx('dinf', bx('dref', fullHdr(0, 0), be32(1), bx('url ', fullHdr(0, 1)))), stbl);
      const mdia = bx('mdia', bx('mdhd', fullHdr(0, 0), be32(0), be32(0), be32(sr), be32(n * spf), be16(0x55c4), be16(0)),
        bx('hdlr', fullHdr(0, 0), be32(0), str4('soun'), be32(0), be32(0), be32(0), [0]), minf);
      const tkhd = bx('tkhd', fullHdr(0, 7), be32(0), be32(0), be32(1), be32(0), be32(durMs), be32(0), be32(0), be16(0), be16(0), be16(0x0100), be16(0), MATRIX, be32(0), be32(0));
      const mvhd = bx('mvhd', fullHdr(0, 0), be32(0), be32(0), be32(1000), be32(durMs), be32(0x00010000), be16(0x0100), new Uint8Array(10), MATRIX, new Uint8Array(24), be32(2));
      return bx('moov', mvhd, bx('trak', tkhd, mdia));
    };
    const ftyp = bx('ftyp', str4('M4A '), be32(0), str4('M4A '), str4('mp42'), str4('isom'));
    const moov0 = make(0);
    const moov = make(ftyp.length + moov0.length + 8);
    const out = new Uint8Array(ftyp.length + moov.length + 8 + dataLen);
    out.set(ftyp, 0); out.set(moov, ftyp.length);
    let o = ftyp.length + moov.length;
    out.set(be32(8 + dataLen), o); out.set(str4('mdat'), o + 4); o += 8;
    for (const f of frames) { out.set(f, o); o += f.length; }
    return out;
  }

  function bandpass(f, q, sr) {
    const w = 2 * Math.PI * f / sr, al = Math.sin(w) / (2 * q), a0 = 1 + al;
    return { b0: al / a0, a1: -2 * Math.cos(w) / a0, a2: (1 - al) / a0 };
  }
  function highpass(f, q, sr) {
    const w = 2 * Math.PI * f / sr, al = Math.sin(w) / (2 * q), c = Math.cos(w), a0 = 1 + al;
    return { b0: (1 + c) / 2 / a0, b1: -(1 + c) / a0, b2: (1 + c) / 2 / a0, a1: -2 * c / a0, a2: (1 - al) / a0 };
  }
  class Envelope {
    constructor(sr, seconds) {
      this.sr = sr; this.fps = 100; this.step = sr / 100; this.next = this.step; this.pos = 0;
      this.cap = Math.ceil((seconds || 600) * 100) + 400;
      this.onset = new Float32Array(this.cap); this.level = new Float32Array(this.cap); this.full = new Float32Array(this.cap);
      this.n = 0; this.samples = 0;
      const centres = [1400, 2800, 5600];
      this.bp = centres.map((f) => (f < sr * 0.42 ? bandpass(f, 1.1, sr) : { b0: 0, a1: 0, a2: 0 }));
      this.hp = highpass(300, 0.707, sr);
      this.s = new Float64Array(16); // filter states
      this.acc = new Float64Array(4);
      this.cnt = 0;
      this.hist = new Float64Array(9); // last 3 amplitudes per band
    }
    grow() {
      const cap = Math.ceil(this.cap * 1.5);
      for (const k of ['onset', 'level', 'full']) { const a = new Float32Array(cap); a.set(this[k]); this[k] = a; }
      this.cap = cap;
    }
    push(x) {
      const [p1, p2, p3] = this.bp, hp = this.hp, s = this.s, acc = this.acc, hist = this.hist;
      const b1 = p1.b0, a11 = p1.a1, a12 = p1.a2, b2 = p2.b0, a21 = p2.a1, a22 = p2.a2, b3 = p3.b0, a31 = p3.a1, a32 = p3.a2;
      const h0 = hp.b0, h1 = hp.b1, h2 = hp.b2, ha1 = hp.a1, ha2 = hp.a2;
      let x1 = s[0], x2 = s[1];
      let y11 = s[2], y12 = s[3], y21 = s[4], y22 = s[5], y31 = s[6], y32 = s[7], yh1 = s[8], yh2 = s[9];
      let e1 = acc[0], e2 = acc[1], e3 = acc[2], ef = acc[3], cnt = this.cnt, pos = this.pos, next = this.next;
      for (let i = 0, L = x.length; i < L; i++) {
        const v = x[i] + 1e-12;
        const d = v - x2;
        const y1 = b1 * d - a11 * y11 - a12 * y12; y12 = y11; y11 = y1;
        const y2 = b2 * d - a21 * y21 - a22 * y22; y22 = y21; y21 = y2;
        const y3 = b3 * d - a31 * y31 - a32 * y32; y32 = y31; y31 = y3;
        const yh = h0 * v + h1 * x1 + h2 * x2 - ha1 * yh1 - ha2 * yh2; yh2 = yh1; yh1 = yh;
        x2 = x1; x1 = v;
        e1 += y1 * y1; e2 += y2 * y2; e3 += y3 * y3; ef += yh * yh; cnt++;
        if (++pos >= next) {
          next += this.step;
          if (this.n >= this.cap) this.grow();
          const inv = 1 / cnt;
          const A1 = Math.sqrt(e1 * inv), A2 = Math.sqrt(e2 * inv), A3 = Math.sqrt(e3 * inv);
          const o1 = A1 - (hist[0] + hist[1] + hist[2]) / 3, o2 = A2 - (hist[3] + hist[4] + hist[5]) / 3, o3 = A3 - (hist[6] + hist[7] + hist[8]) / 3;
          hist[2] = hist[1]; hist[1] = hist[0]; hist[0] = A1; hist[5] = hist[4]; hist[4] = hist[3]; hist[3] = A2; hist[8] = hist[7]; hist[7] = hist[6]; hist[6] = A3;
          const n = this.n++;
          this.onset[n] = (o1 > 0 ? o1 : 0) + (o2 > 0 ? o2 : 0) + (o3 > 0 ? o3 : 0);
          this.level[n] = A1 + A2 + A3;
          this.full[n] = Math.sqrt(ef * inv);
          e1 = e2 = e3 = ef = 0; cnt = 0;
        }
      }
      s[0] = x1; s[1] = x2; s[2] = y11; s[3] = y12; s[4] = y21; s[5] = y22; s[6] = y31; s[7] = y32; s[8] = yh1; s[9] = yh2;
      acc[0] = e1; acc[1] = e2; acc[2] = e3; acc[3] = ef; this.cnt = cnt; this.pos = pos; this.next = next;
      this.samples += x.length;
    }
    get seconds() { return this.n / this.fps; }
  }

  function quantile(sorted, q) { if (!sorted.length) return 0; return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(q * (sorted.length - 1))))]; }

  function prepare(env) {
    const n = env.n, O = env.onset;
    const sorted = Float32Array.from(O.subarray(0, n)).sort();
    let p99 = quantile(sorted, 0.99);
    const p50 = quantile(sorted, 0.5), p999 = quantile(sorted, 0.999);
    if (!(p99 > 0)) p99 = p999 > 0 ? p999 : 1e-6;
    const ref = p999 > 0 ? p999 : p99;
    const nb = Math.ceil(n / 100);
    const med = new Float32Array(nb), mad = new Float32Array(nb);
    const buf = new Float32Array(500);
    for (let b = 0; b < nb; b++) {
      const lo = Math.max(0, (b - 4) * 100), hi = Math.min(n, (b + 6) * 100);
      let m = 0;
      for (let i = lo; i < hi && m < 500; i += 2) buf[m++] = O[i];
      const w = buf.subarray(0, m).sort();
      const md = w[m >> 1] || 0;
      for (let i = 0; i < m; i++) w[i] = Math.abs(w[i] - md);
      w.sort();
      med[b] = md; mad[b] = w[m >> 1] || 0;
    }
    const minC = 0.01 * ref;
    const cf = [], cs = [];
    for (let i = 2; i < n - 2; i++) {
      const v = O[i];
      if (v > minC && v >= O[i - 1] && v > O[i + 1] && v >= O[i - 2] && v > O[i + 2]) { cf.push(i); cs.push(v); }
    }
    const lsorted = Float32Array.from(env.full.subarray(0, n)).sort();
    return { n, fps: env.fps, p50, p99, p999, ref, med, mad, candF: Int32Array.from(cf), candS: Float32Array.from(cs), fullMedian: quantile(lsorted, 0.5) };
  }

  const DEFAULTS = { sensitivity: 5, minHits: 4, minGap: 0.5, maxGap: 2.8, endPause: 4.5, refractory: 0.25, minGoodGapShare: 0.6 };
  function thresholds(p) {
    const s = p.sensitivity;
    return { k: 1.5 + (10 - s) * 0.55, floorFrac: 0.42 * Math.pow(0.82, s - 5) };
  }

  function pickHits(prep, params) {
    const { k, floorFrac } = thresholds(params);
    const floor = floorFrac * prep.ref;
    const ref = Math.round(params.refractory * prep.fps);
    const hits = [];
    for (let i = 0; i < prep.candF.length; i++) {
      const f = prep.candF[i], v = prep.candS[i];
      const b = Math.floor(f / 100);
      const thr = Math.max(prep.med[b] + k * 1.4826 * prep.mad[b], floor);
      if (v <= thr) continue;
      const last = hits[hits.length - 1];
      if (last && f - last.f < ref) { if (v > last.s) { last.f = f; last.s = v; } continue; }
      hits.push({ f, s: v });
    }
    for (const h of hits) h.t = h.f / prep.fps;
    return { hits, floor, k, floorFrac };
  }

  function meanRange(a, f0, f1) {
    f0 = Math.max(0, Math.floor(f0)); f1 = Math.min(a.length, Math.floor(f1));
    if (f1 <= f0) return 0;
    let s = 0; for (let i = f0; i < f1; i++) s += a[i];
    return s / (f1 - f0);
  }
  function medianRange(a, f0, f1) {
    f0 = Math.max(0, Math.floor(f0)); f1 = Math.min(a.length, Math.floor(f1));
    if (f1 <= f0) return 0;
    const w = Float32Array.from(a.subarray(f0, f1)).sort();
    return w[w.length >> 1];
  }
  const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
  const db = (x) => 20 * Math.log10(Math.max(x, 1e-9));

  function groupRallies(hits, prep, env, params) {
    const out = [];
    if (!hits.length) return out;
    const hs = hits.map((h) => h.s).sort((a, b) => a - b);
    const hitMedian = hs[hs.length >> 1] || 1e-9;
    const fps = prep.fps, full = env.full.subarray(0, env.n);
    let seq = [hits[0]];
    const flush = () => {
      if (seq.length >= params.minHits) {
        const gaps = [];
        for (let i = 1; i < seq.length; i++) gaps.push(seq[i].t - seq[i - 1].t);
        const good = gaps.filter((g) => g >= params.minGap && g <= params.maxGap);
        if (good.length / gaps.length >= params.minGoodGapShare && good.length >= params.minHits - 1) {
          const start = seq[0].t, end = seq[seq.length - 1].t, dur = end - start;
          const sortedGood = good.slice().sort((a, b) => a - b);
          const medGap = sortedGood[sortedGood.length >> 1];
          let maxS = 0; for (const h of seq) if (h.s > maxS) maxS = h.s;
          const smashDb = db(maxS / hitMedian);
          const after = meanRange(full, (end + 0.4) * fps, (end + 3.0) * fps);
          let base = medianRange(full, (start - 6) * fps, (start - 1) * fps);
          if (!(base > 0)) base = prep.fullMedian;
          const cheerDb = db(after / Math.max(base, 1e-9));
          const parts = {
            hits: clamp01((seq.length - 3) / 15),
            length: clamp01(dur / 30),
            pace: clamp01((2.2 - medGap) / 1.2),
            smash: clamp01(smashDb / 9),
            cheer: clamp01((cheerDb - 3) / 9),
          };
          const score = Math.round(100 * (0.3 * parts.hits + 0.2 * parts.length + 0.15 * parts.pace + 0.2 * parts.smash + 0.15 * parts.cheer));
          out.push({ start, end, dur, hits: seq.length, medGap, smashDb, cheerDb, parts, score });
        }
      }
    };
    for (let i = 1; i < hits.length; i++) {
      if (hits[i].t - hits[i - 1].t > params.endPause) { flush(); seq = []; }
      seq.push(hits[i]);
    }
    flush();
    return out;
  }

  function overlapShare(a, b) {
    const ov = Math.min(a.end, b.end) - Math.max(a.start, b.start);
    const len = Math.max(0.5, Math.min(a.end - a.start, b.end - b.start));
    return ov / len;
  }

  const POINT_BEFORE = 6, POINT_AFTER = 4, LONE_HIT_GAP = 3, END_IGNORE = 10, POINT_MAX = 40;
  function pointBounds(r, hits) {
    const inside = (hits || []).filter((h) => h.t >= r.start - 0.01 && h.t <= r.end + 0.01).map((h) => h.t).sort((x, y) => x - y);
    let i = 0;
    while (i < inside.length - 2 && inside[i + 1] - inside[i] > LONE_HIT_GAP) i++;
    const first = inside.length ? inside[i] : r.start;
    const lastHit = inside.length ? inside[inside.length - 1] : r.end;
    let start = Math.max(0, first - POINT_BEFORE);
    const end = lastHit + POINT_AFTER;
    if (end - start > POINT_MAX) start = end - POINT_MAX;
    return { start, end, firstHit: first, lastHit, skipped: i };
  }

  /**
   * The cut: whole points, best first, until about `target` seconds; at most `most` points; in match
   * order. A point the person marked "Not a rally", or one in the last END_IGNORE seconds, stays out.
   */
  function planCut(rallies, isMarked, target, opts) {
    target = target || 90;
    const o = opts || {};
    const most = o.most || 5;
    const ignoreFrom = o.duration && o.duration > 300 ? o.duration - END_IGNORE : Infinity;
    const pool = rallies.filter((r) => !isMarked(r) && r.end <= ignoreFrom).sort((a, b) => b.score - a.score);
    return pickClips(pool.map((r) => { const b = pointBounds(r, o.hits); return { start: b.start, end: b.end, rally: r }; }), most, target, spreadOf(o.duration, most));
  }
  const spreadOf = (duration, most) => (duration && duration > 600 ? duration / (2 * most) : 0);

  function samplesOf(t) {
    const { offs, sizes, n } = sampleTable(t);
    const dts = new Float64Array(n), dur = new Uint32Array(n);
    let i = 0, d = 0;
    for (let e = 0; e < t.stts.counts.length; e++) for (let k = 0; k < t.stts.counts[e] && i < n; k++) { dts[i] = d; dur[i] = t.stts.deltas[e]; d += dur[i]; i++; }
    for (; i < n; i++) { dts[i] = d; dur[i] = t.stts.deltas[t.stts.deltas.length - 1] || 1; d += dur[i]; }
    let cto = null;
    if (t.ctts) { cto = new Int32Array(n); let j = 0; for (let e = 0; e < t.ctts.counts.length; e++) for (let k = 0; k < t.ctts.counts[e] && j < n; k++) cto[j++] = t.ctts.offs[e]; }
    let sync = null;
    if (t.stss) { sync = new Uint8Array(n); for (const x of t.stss) if (x >= 1 && x <= n) sync[x - 1] = 1; }
    return { offs, sizes, n, dts, dur, cto, sync, ts: t.timescale };
  }
  function firstAt(S, sec) {
    const target = sec * S.ts;
    let lo = 0, hi = S.n;
    while (lo < hi) { const m = (lo + hi) >> 1; if (S.dts[m] < target) lo = m + 1; else hi = m; }
    return lo;
  }
  function runs(values) {
    const out = [];
    for (let i = 0; i < values.length; i++) {
      if (out.length && out[out.length - 1][1] === values[i]) out[out.length - 1][0]++;
      else out.push([1, values[i]]);
    }
    return out;
  }
  async function buildCut(file, movie, segs, ftypRaw) {
    const vt = movie.tracks.find((t) => t.handler === 'vide' && t.stsz && t.stts && t.raw && t.raw.stsd);
    if (!vt) throw new Error('The file has no video track that the page can copy.');
    const at = movie.tracks.find((t) => t.handler === 'soun' && trackKind(t) === 'aac' && t.stsz && t.stts && t.raw && t.raw.stsd) || null;
    const V = samplesOf(vt), A = at ? samplesOf(at) : null;
    const vIdx = [], aIdx = [], vSeg = [], aSeg = [], vDur = [], vCto = [], aDur = [];
    const lastSec = (V.dts[V.n - 1] + V.dur[V.n - 1]) / V.ts;
    let dropped = 0;
    let vTotal = 0, aTotal = 0;
    const plan = [];
    for (const seg of segs) {
      if (seg.start >= lastSec) continue;
      let k = Math.min(firstAt(V, seg.start), V.n - 1);
      if (V.sync) { while (k > 0 && !V.sync[k]) k--; }
      let vEnd = Math.max(k + 1, Math.min(firstAt(V, seg.end), V.n));
      if (V.sync) { while (vEnd < V.n && !V.sync[vEnd]) vEnd++; }
      let lo = Infinity, hi = 0;
      const sIdx = plan.length;
      const keyPts = V.dts[k] + (V.cto ? V.cto[k] : 0);
      const lead = (i) => !!V.cto && i > k && V.dts[i] + V.cto[i] < keyPts;
      let total = 0;
      for (let i = k; i < vEnd; i++) if (lead(i)) total += V.dur[i];
      let before = 0, patchKey = false;
      const first = vIdx.length;
      for (let i = k; i < vEnd; i++) {
        if (lead(i)) { before += V.dur[i]; dropped++; patchKey = true; continue; }
        vIdx.push(i); vSeg.push(sIdx); vDur.push(V.dur[i]); vCto.push(V.cto ? V.cto[i] + before - total : 0);
        lo = Math.min(lo, V.offs[i]); hi = Math.max(hi, V.offs[i] + V.sizes[i]);
      }
      for (let j = first; j < vDur.length; j++) vTotal += vDur[j] / V.ts;
      if (A) {
        let a = firstAt(A, V.dts[k] / V.ts);
        while (a < A.n && aTotal + A.dur[a] / A.ts / 2 <= vTotal) { aIdx.push(a); aSeg.push(sIdx); aDur.push(A.dur[a]); aTotal += A.dur[a] / A.ts; lo = Math.min(lo, A.offs[a]); hi = Math.max(hi, A.offs[a] + A.sizes[a]); a++; }
      }
      plan.push({ key: patchKey ? k : -1, lo, hi, startSec: V.dts[k] / V.ts, endSec: vEnd < V.n ? V.dts[vEnd] / V.ts : lastSec, frames: vIdx.length - first });
    }
    if (!vIdx.length) throw new Error('The cut has no frames.');
    const segBase = [];
    let payload = 0;
    for (const p of plan) { segBase.push(payload); payload += p.hi - p.lo; }
    const ftyp = bx('ftyp', str4('isom'), be32(512), str4('isom'), str4('iso2'), str4('mp41'));
    const durMs = Math.round(vTotal * 1000);
    const big = payload + 64e6 > 0xffffffff;
    const offTable = (S, idx, segOf, base) => {
      const w = big ? 8 : 4, out = new Uint8Array(8 + idx.length * w), dv = new DataView(out.buffer);
      dv.setUint32(4, idx.length);
      idx.forEach((i, j) => {
        const v = base + segBase[segOf[j]] + (S.offs[i] - plan[segOf[j]].lo);
        if (big) { dv.setUint32(8 + j * 8, Math.floor(v / 4294967296)); dv.setUint32(12 + j * 8, v >>> 0); } else dv.setUint32(8 + j * 4, v);
      });
      return bx(big ? 'co64' : 'stco', out);
    };
    const trak = (t, S, idx, segOf, id, base, isVideo, durs, ctos) => {
      const n = idx.length;
      const sz = new Uint8Array(12 + n * 4), sdv = new DataView(sz.buffer);
      sdv.setUint32(8, n); idx.forEach((i, j) => sdv.setUint32(12 + j * 4, S.sizes[i]));
      const sttsRuns = runs(durs);
      const stts = bx('stts', fullHdr(0, 0), be32(sttsRuns.length), sttsRuns.flatMap(([c, d]) => [...be32(c), ...be32(d)]));
      const boxes = [t.raw.stsd, stts];
      let mediaTime = 0;
      if (S.cto && ctos) {
        const cr = runs(ctos);
        const neg = cr.some(([, o]) => o < 0);
        boxes.push(bx('ctts', fullHdr(neg ? 1 : 0, 0), be32(cr.length), cr.flatMap(([c, o]) => [...be32(c), ...be32(o >>> 0)])));
        let m = Infinity, d = 0;
        for (let j = 0; j < durs.length && segOf[j] === 0; j++) { m = Math.min(m, d + ctos[j]); d += durs[j]; }
        mediaTime = Math.max(0, m === Infinity ? 0 : m);
      }
      if (S.sync) {
        const ks = []; idx.forEach((i, j) => { if (S.sync[i]) ks.push(j + 1); });
        boxes.push(bx('stss', fullHdr(0, 0), be32(ks.length), ks.flatMap(be32)));
      }
      boxes.push(bx('stsc', fullHdr(0, 0), be32(1), be32(1), be32(1), be32(1)), bx('stsz', sz), offTable(S, idx, segOf, base));
      const mediaDur = durs.reduce((a, d) => a + d, 0);
      const tkhd = t.raw.tkhd.slice(), tv = tkhd[8], tdv = new DataView(tkhd.buffer);
      tdv.setUint32(tv === 1 ? 28 : 20, id);
      if (tv === 1) { tdv.setUint32(36, 0); tdv.setUint32(40, durMs); } else tdv.setUint32(28, durMs);
      const mhd = t.raw.mhd || (isVideo ? bx('vmhd', fullHdr(0, 1), new Uint8Array(8)) : bx('smhd', fullHdr(0, 0), be16(0), be16(0)));
      const minf = bx('minf', mhd, bx('dinf', bx('dref', fullHdr(0, 0), be32(1), bx('url ', fullHdr(0, 1)))), bx('stbl', ...boxes));
      const mdia = bx('mdia', bx('mdhd', fullHdr(0, 0), be32(0), be32(0), be32(S.ts), be32(mediaDur), be16(0x55c4), be16(0)), t.raw.hdlr, minf);
      const edts = isVideo && mediaTime ? [bx('edts', bx('elst', fullHdr(0, 0), be32(1), be32(durMs), be32(mediaTime), be16(1), be16(0)))] : [];
      return bx('trak', tkhd, ...edts, mdia);
    };
    const make = (base) => {
      const mvhd = bx('mvhd', fullHdr(0, 0), be32(0), be32(0), be32(1000), be32(durMs), be32(0x00010000), be16(0x0100), new Uint8Array(10), MATRIX, new Uint8Array(24), be32(A ? 3 : 2));
      const traks = [trak(vt, V, vIdx, vSeg, 1, base, true, vDur, V.cto ? vCto : null)];
      if (A) traks.push(trak(at, A, aIdx, aSeg, 2, base, false, aDur, null));
      return bx('moov', mvhd, ...traks);
    };
    const hdr = big ? 16 : 8;
    const moov0 = make(0);
    const moov = make(ftyp.length + moov0.length + hdr);
    const mdatHdr = new Uint8Array(hdr), mdv = new DataView(mdatHdr.buffer);
    if (big) { mdv.setUint32(0, 1); mdatHdr.set(str4('mdat'), 4); mdv.setUint32(8, Math.floor((payload + 16) / 4294967296)); mdv.setUint32(12, (payload + 16) >>> 0); }
    else { mdv.setUint32(0, payload + 8); mdatHdr.set(str4('mdat'), 4); }
    const lenSize = (() => {
      const r = vt.raw.stsd;
      for (let i = 0; i + 30 < r.length; i++) if (r[i] === 0x68 && r[i + 1] === 0x76 && r[i + 2] === 0x63 && r[i + 3] === 0x43) return (r[i + 25] & 3) + 1;
      return 0;
    })();
    let patched = 0;
    const blobParts = [ftyp, moov, mdatHdr];
    for (const p of plan) {
      if (p.key < 0 || !lenSize) { blobParts.push(file.slice(p.lo, p.hi)); continue; }
      const off = V.offs[p.key], size = V.sizes[p.key];
      const u8 = await readRange(file, off, off + size);
      let o = 0;
      while (o + lenSize < u8.length) {
        let n = 0;
        for (let b = 0; b < lenSize; b++) n = n * 256 + u8[o + b];
        const h = o + lenSize;
        if (((u8[h] >> 1) & 63) === 21) { u8[h] = (u8[h] & 0x81) | (16 << 1); patched++; }
        o = h + n;
      }
      blobParts.push(file.slice(p.lo, off), u8, file.slice(off + size, p.hi));
    }
    const blob = new Blob(blobParts, { type: 'video/mp4' });
    return {
      blob, ext: '.mp4', bytes: blob.size, moovBytes: moov.length, payloadBytes: payload,
      videoSec: Math.round(vTotal * 100) / 100, audioSec: Math.round(aTotal * 100) / 100, audio: A ? at.codec : 'none',
      codec: vt.codec, width: vt.width, height: vt.height, frames: vIdx.length, droppedLeadingFrames: dropped, keyframesMadeBla: patched,
      segments: plan.map((p) => ({ startSec: Math.round(p.startSec * 100) / 100, endSec: Math.round(p.endSec * 100) / 100, frames: p.frames, bytes: p.hi - p.lo })),
    };
  }

  const LAUGH_MIN = 0.22, NET_GAP = 0.8, SMASH_MIN = 2;
  function reactionOf(env, prep, lastHit) {
    const fps = prep.fps, full = env.full;
    const a = Math.round((lastHit + 0.3) * fps), b = Math.min(env.n, Math.round((lastHit + 5) * fps));
    if (b - a < 60) return { db: 0, laugh: 0 };
    const x = new Float32Array(b - a);
    let mu = 0;
    for (let i = 0; i < x.length; i++) { x[i] = full[a + i]; mu += x[i]; }
    mu /= x.length;
    const dbv = db(mu / Math.max(prep.fullMedian, 1e-9));
    const w = 25, y = new Float32Array(x.length);
    let run = 0;
    for (let i = 0; i < x.length; i++) {
      run += x[i];
      if (i >= 2 * w + 1) run -= x[i - 2 * w - 1];
      const lo = Math.max(0, i - 2 * w), cnt = i - lo + 1;
      y[Math.max(0, i - w)] = x[Math.max(0, i - w)] - run / cnt;
    }
    for (let i = Math.max(0, x.length - w); i < x.length; i++) y[i] = 0;
    for (let i = 0; i < x.length; i++) x[i] = y[i];
    let v0 = 0;
    for (let i = 0; i < x.length; i++) v0 += x[i] * x[i];
    let best = 0;
    if (v0 > 0) for (let lag = 14; lag <= 33; lag++) {
      let c = 0;
      for (let i = lag; i < x.length; i++) c += x[i] * x[i - lag];
      c /= v0;
      if (c > best) best = c;
    }
    return { db: Math.round(dbv * 10) / 10, laugh: Math.round(best * 100) / 100 };
  }
  function netBurst(times) {
    let best = { n: 0, start: 0, end: 0 }, i = 0;
    for (let j = 1; j <= times.length; j++) {
      if (j === times.length || times[j] - times[j - 1] > NET_GAP) {
        if (j - i > best.n) best = { n: j - i, start: times[i], end: times[j - 1] };
        i = j;
      }
    }
    return best;
  }
  const REELS = {
    best: { label: 'Best points', picture: false },
    funny: { label: 'Funny moments', picture: false },
    reactions: { label: 'Big reactions', picture: false },
    longest: { label: 'Longest rallies', picture: false },
    net: { label: 'Net battles', picture: false },
    smashes: { label: 'Smashes', picture: true },
    saves: { label: 'Impossible saves', picture: true },
    celebrations: { label: 'Celebrations and chest bumps', picture: true },
    mistakes: { label: 'Mistakes of one player', picture: true, player: true },
    player: { label: "One player's match", picture: true, player: true },
  };
  function pointFacts(rallies, hits, env, prep) {
    return rallies.map((r) => {
      const times = hits.filter((h) => h.t >= r.start - 0.01 && h.t <= r.end + 0.01).map((h) => h.t);
      const strong = hits.filter((h) => h.t >= r.start - 0.01 && h.t <= r.end + 0.01).reduce((m, h) => (h.s > m.s ? h : m), { s: 0, t: r.start });
      const pb = pointBounds(r, hits);
      return { r, pb, reaction: reactionOf(env, prep, pb.lastHit), burst: netBurst(times), strongest: { t: strong.t, s: strong.s / prep.ref } };
    });
  }
  function pickClips(cands, most, target, spread) {
    const segs = [];
    let total = 0;
    for (const gap of spread ? [spread, 0] : [0]) {
      for (const c of cands) {
        if (segs.length >= most) break;
        if (segs.includes(c) || segs.some((s) => s.start - gap < c.end && c.start < s.end + gap)) continue;
        if (segs.length && total + (c.end - c.start) > target + 10) continue;
        segs.push(c); total += c.end - c.start;
      }
    }
    return segs.sort((a, b) => a.start - b.start);
  }
  /**
   * The clips of a reel, from the sound alone. A reel that needs the players (REELS[kind].picture)
   * gets its candidates here; `pictureReel` keeps the ones the picture confirms.
   */
  function planReel(kind, o) {
    if (kind === 'best' || !REELS[kind]) return planCut(o.rallies, o.isMarked, 120, { hits: o.hits, duration: o.duration });
    const ignoreFrom = o.duration && o.duration > 300 ? o.duration - END_IGNORE : Infinity;
    const facts = pointFacts(o.rallies.filter((r) => !o.isMarked(r) && r.end <= ignoreFrom), o.hits, o.env, o.prep);
    const after = (f, before, tail) => ({ start: Math.max(0, f.pb.lastHit - before), end: f.pb.lastHit + tail, rally: f.r });
    const tag = (c, why) => Object.assign(c, { why });
    if (kind === 'funny') return pickClips(facts.filter((f) => f.reaction.laugh >= LAUGH_MIN && f.reaction.db >= 2).sort((a, b) => b.reaction.laugh - a.reaction.laugh).map((f) => tag(after(f, 4, 6), 'laughter ' + f.reaction.laugh)), 6, 60, spreadOf(o.duration, 6));
    if (kind === 'reactions') return pickClips(facts.filter((f) => f.reaction.db >= 4).sort((a, b) => b.reaction.db - a.reaction.db).map((f) => tag(after(f, 4, 6), 'reaction +' + f.reaction.db + ' dB')), 6, 60, spreadOf(o.duration, 6));
    if (kind === 'longest') return pickClips(facts.slice().sort((a, b) => b.r.hits - a.r.hits).map((f) => tag({ start: Math.max(0, f.pb.firstHit - POINT_BEFORE), end: f.pb.lastHit + POINT_AFTER, rally: f.r }, f.r.hits + ' shots')), 3, 150, spreadOf(o.duration, 3));
    if (kind === 'net') return pickClips(facts.filter((f) => f.burst.n >= 4).sort((a, b) => b.burst.n - a.burst.n || b.r.score - a.r.score).map((f) => tag({ start: Math.max(0, f.burst.start - 3), end: Math.max(f.burst.end + 4, Math.min(f.pb.end, f.burst.end + 8)), rally: f.r }, f.burst.n + ' fast shots')), 5, 60, spreadOf(o.duration, 5));
    if (kind === 'smashes') {
      const loud = o.hits.filter((h) => h.s / o.prep.ref >= SMASH_MIN && h.t <= ignoreFrom).sort((a, b) => b.s - a.s).slice(0, 12);
      return pickClips(loud.map((h) => ({ start: Math.max(0, h.t - 3), end: h.t + 4, rally: null, hitT: h.t, why: 'loud hit ' + Math.round((h.s / o.prep.ref) * 10) / 10 })), 12, 100);
    }
    if (kind === 'saves') return pickClips(facts.filter((f) => f.r.hits >= 10).sort((a, b) => b.r.hits - a.r.hits).map((f) => tag({ start: f.pb.start, end: f.pb.end, rally: f.r }, f.r.hits + ' shots')), 8, 200, spreadOf(o.duration, 8));
    if (kind === 'celebrations') return pickClips(facts.slice().sort((a, b) => b.reaction.db - a.reaction.db).map((f) => tag(after(f, 3, 7), 'reaction +' + f.reaction.db + ' dB')), 10, 100, spreadOf(o.duration, 10));
    if (kind === 'mistakes') return pickClips(facts.slice().sort((a, b) => b.reaction.laugh + b.reaction.db / 20 - (a.reaction.laugh + a.reaction.db / 20)).map((f) => tag(after(f, 5, 5), 'laughter ' + f.reaction.laugh)), 12, 120);
    if (kind === 'player') return pickClips(facts.slice().sort((a, b) => b.r.score - a.r.score).map((f) => tag({ start: f.pb.start, end: f.pb.end, rally: f.r }, 'score ' + f.r.score)), 8, 200);
    return [];
  }

  const nearest = (tr, t) => tr.pts.reduce((m, q) => (Math.abs(q.t - t) < Math.abs(m.t - t) ? q : m), tr.pts[0]);
  function armUp(tr, t) {
    const q = nearest(tr, t);
    if (!q || Math.abs(q.t - t) > 0.3) return false;
    const b = q.b;
    if (!b.sh || !b.wrists) return false;
    const top = Math.min(b.sh[0].y, b.sh[1].y);
    return Math.min(b.wrists[0].y, b.wrists[1].y) < top - 0.2 * b.h;
  }
  function topSpeed(tr) {
    let v = 0;
    for (let i = 1; i < tr.pts.length; i++) {
      const a = tr.pts[i - 1], b = tr.pts[i], dt = b.t - a.t;
      if (dt > 0) v = Math.max(v, Math.hypot(b.b.hip.x - a.b.hip.x, b.b.hip.y - a.b.hip.y) / Math.max(a.b.h, b.b.h) / dt);
    }
    return v;
  }
  function celebrated(tracks, from) {
    let close = 0;
    const times = [...new Set(tracks.flatMap((tr) => tr.pts.filter((q) => q.t >= from).map((q) => q.t)))];
    for (const t of times) {
      const at = tracks.map((tr) => tr.pts.find((q) => Math.abs(q.t - t) < 0.06)).filter(Boolean);
      let near = false;
      for (let i = 0; i < at.length && !near; i++) for (let j = i + 1; j < at.length && !near; j++) {
        const h = (at[i].b.h + at[j].b.h) / 2;
        near = Math.abs(at[i].b.h - at[j].b.h) < 0.35 * h && Math.hypot(at[i].b.hip.x - at[j].b.hip.x, at[i].b.hip.y - at[j].b.hip.y) < 0.5 * h;
      }
      if (near) close++;
    }
    return close >= 3;
  }
  /**
   * The clips the picture confirms. `seen` holds, for each candidate clip in order, the tracks the
   * finder followed and the name of each, and the shots it named ({ t, name, last, score }).
   */
  function pictureReel(kind, cands, seen, player) {
    const keep = [];
    cands.forEach((c, i) => {
      const s = seen[i];
      if (!s || !s.tracks.length) return;
      const named = (ti) => s.names[ti] || '?';
      if (kind === 'smashes') {
        const shot = s.shots.filter((x) => x.name && Math.abs(x.t - c.hitT) < 0.4).sort((a, b) => b.score - a.score)[0];
        const ti = shot ? s.names.indexOf(shot.name) : -1;
        if (shot && ti >= 0 && armUp(s.tracks[ti], c.hitT)) keep.push(Object.assign({}, c, { why: 'Smash by ' + shot.name, rank: 1 }));
      } else if (kind === 'saves') {
        let bestV = 0, bestT = -1;
        s.tracks.forEach((tr, ti) => { const v = topSpeed(tr); if (v > bestV) { bestV = v; bestT = ti; } });
        if (bestV >= 1.5) keep.push(Object.assign({}, c, { why: 'Save by ' + named(bestT) + ' (' + Math.round(bestV * 10) / 10 + ' body heights a second)', rank: bestV }));
      } else if (kind === 'celebrations') {
        if (celebrated(s.tracks, (c.rally ? pointBounds(c.rally, s.hits || []).lastHit : c.start) + 0.5)) keep.push(Object.assign({}, c, { why: 'Celebration', rank: 1 }));
      } else if (kind === 'mistakes') {
        const last = s.shots.filter((x) => x.last && x.name).pop();
        if (last && last.name === player) keep.push(Object.assign({}, c, { why: player + "'s last shot, then laughter", rank: 1 }));
      } else if (kind === 'player') {
        const mine = s.shots.filter((x) => x.name === player);
        if (mine.length) keep.push(Object.assign({}, c, { why: mine.length + ' shots by ' + player, rank: mine.length }));
      }
    });
    keep.sort((a, b) => b.rank - a.rank);
    return pickClips(keep, kind === 'saves' || kind === 'player' ? 4 : 6, kind === 'saves' || kind === 'player' ? 120 : 60);
  }

  function evaluate(rallies, truth) {
    const used = new Set();
    let tp = 0;
    for (const d of rallies) {
      const m = truth.findIndex((g, i) => !used.has(i) && overlapShare(d, g) >= 0.5);
      if (m >= 0) { used.add(m); tp++; }
    }
    return { detected: rallies.length, truth: truth.length, matched: tp, precision: rallies.length ? tp / rallies.length : 0, recall: truth.length ? tp / truth.length : 0 };
  }

  function mulberry32(a) { return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
  function synthMatch(seconds, sr, seed) {
    const rnd = mulberry32(seed || 1);
    const N = Math.floor(seconds * sr);
    const out = new Float32Array(N);
    const truth = { rallies: [], short: [], neighbour: [], cheers: [], applause: [] };
    let brown = 0;
    for (let i = 0; i < N; i++) { const w = rnd() * 2 - 1; brown = 0.997 * brown + 0.03 * w; out[i] = 0.003 * w + 0.03 * brown; }
    const add = (i0, len, fn) => { for (let k = 0; k < len; k++) { const i = i0 + k; if (i >= 0 && i < N) out[i] += fn(k / sr); } };
    function click(t, amp, f, decay) {
      const ph = rnd() * 6.28;
      add(Math.round(t * sr), Math.round(0.06 * sr), (u) => amp * (0.55 * (rnd() * 2 - 1) * Math.exp(-u / 0.0007) + 0.7 * Math.sin(2 * Math.PI * f * u + ph) * Math.exp(-u / decay) + 0.35 * Math.sin(2 * Math.PI * 750 * u) * Math.exp(-u / 0.01)));
    }
    function noiseBurst(t, dur, amp, lowpass, mod) {
      let lp = 0;
      add(Math.round(t * sr), Math.round(dur * sr), (u) => { const w = rnd() * 2 - 1; lp += lowpass * (w - lp); const env = Math.min(1, u / 0.15, (dur - u) / 0.3); const m = mod ? 0.5 + 0.5 * Math.sin(2 * Math.PI * mod * u) : 1; return amp * lp * Math.max(0, env) * m; });
    }
    function court(amp, list, extras, offset) {
      let t = offset + 3 + rnd() * 5;
      while (t < seconds - 30) {
        if (extras) { const nb = 2 + Math.floor(rnd() * 2); for (let b = 0; b < nb; b++) click(t + b * 0.55, amp * 0.3, 1500, 0.006); t += nb * 0.55 + 1.2; }
        const nHits = rnd() < 0.15 ? 2 + Math.floor(rnd() * 2) : 4 + Math.floor(rnd() * rnd() * 18);
        const hits = [];
        let h = t;
        for (let k = 0; k < nHits; k++) {
          const smash = k === nHits - 1 && rnd() < 0.35;
          const a = amp * (0.7 + 0.4 * rnd()) * (smash ? 1.7 : 1);
          click(h, a, 2000 + 2000 * rnd(), 0.008);
          hits.push(h);
          if (extras && k < nHits - 1 && rnd() < 0.4) click(h + 0.32 + 0.2 * rnd(), a * 0.45, 1200 + 800 * rnd(), 0.012);
          const r = rnd();
          h += r < 0.12 ? 2.3 + rnd() * 0.4 : r < 0.3 ? 0.7 + 0.2 * rnd() : 0.95 + 0.9 * rnd();
        }
        const last = hits[hits.length - 1];
        (nHits >= 4 ? list : truth.short).push({ start: +hits[0].toFixed(3), end: +last.toFixed(3), hits: nHits, court: extras ? 'main' : 'neighbour' });
        if (extras && rnd() < 0.4) { const d = 1.5 + rnd(); noiseBurst(last + 0.5, d, amp * 0.5, 0.5, 0); truth.cheers.push(+(last + 0.5).toFixed(2)); }
        if (extras && rnd() < 0.15) { const a0 = last + 3.5; for (let c = 0; c < 50; c++) click(a0 + rnd() * 2.5, amp * 0.18, 2500, 0.004); truth.applause.push(+a0.toFixed(2)); }
        if (extras && rnd() < 0.6) noiseBurst(last + 4, 2 + rnd() * 3, 0.06, 0.15, 4);
        t = last + 8 + rnd() * 14;
      }
    }
    court(0.5, truth.rallies, true, 0);
    court(0.5 * 0.22, truth.neighbour, false, 6);
    let peak = 0;
    for (let i = 0; i < N; i++) { const a = Math.abs(out[i]); if (a > peak) peak = a; }
    if (peak > 0.95) { const g = 0.95 / peak; for (let i = 0; i < N; i++) out[i] *= g; }
    return { mono: out, sr, truth };
  }

  function wavBlobBytes(mono, sr) {
    const n = mono.length;
    const buf = new ArrayBuffer(44 + n * 2);
    const dv = new DataView(buf);
    const w = (o, s) => { for (let i = 0; i < 4; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
    w(0, 'RIFF'); dv.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
    dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true); dv.setUint32(24, sr, true);
    dv.setUint32(28, sr * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true); w(36, 'data'); dv.setUint32(40, n * 2, true);
    for (let i = 0; i < n; i++) { const v = Math.max(-1, Math.min(1, mono[i])); dv.setInt16(44 + i * 2, v < 0 ? v * 32768 : v * 32767, true); }
    return new Uint8Array(buf);
  }

  async function pool(items, k, fn) {
    const out = new Array(items.length);
    let i = 0;
    const worker = async () => { while (i < items.length) { const j = i++; out[j] = await fn(items[j]); } };
    await Promise.all(Array.from({ length: Math.min(k, items.length) }, worker));
    return out;
  }

  async function readAac(file, t, sr, progress, c) {
    const tab = sampleTable(t);
    const cfg = t.ascInfo;
    const spf = 1024 * (cfg.sbr ? 2 : 1);
    const perBatch = Math.max(64, Math.round((30 * sr) / spf));
    const batches = [];
    for (let i = 0; i < tab.n; i += perBatch) batches.push([i, Math.min(tab.n, i + perBatch)]);
    const channels = t.channels || cfg.channelConfig || 2;
    const env = c.env;

    const readBatch = async (b) => {
      const PRE = 3;
      const i0 = Math.max(0, b[0] - PRE), i1 = b[1];
      const { ranges, map } = planRanges(tab.offs, tab.sizes, i0, i1, 131072);
      const bufs = await pool(ranges, 6, (r) => readRange(file, r.start, r.end));
      c.read.reads += ranges.length;
      for (const r of ranges) c.read.bytesRead += r.end - r.start;
      const frames = [];
      for (let i = i0; i < i1; i++) {
        const ri = map[i - i0], rr = ranges[ri], o = tab.offs[i] - rr.start;
        frames.push(bufs[ri].subarray(o, o + tab.sizes[i]));
      }
      return { frames, pre: b[0] - i0, first: b[0], count: b[1] - b[0] };
    };

    let wc = null;
    const force = c.force || ''; // test hook: 'adts' or 'm4a' skips the decoders before it
    if (force) c.read.forcedDecoder = force;
    if (force === 'm4a') c.path = 'M4A';
    if (!force && typeof AudioDecoder !== 'undefined' && typeof EncodedAudioChunk !== 'undefined') {
      const conf = { codec: 'mp4a.40.' + cfg.objectType, sampleRate: sr, numberOfChannels: channels, description: t.asc };
      try {
        const sup = await AudioDecoder.isConfigSupported(conf);
        if (sup && sup.supported) {
          let decErr = null;
          const dec = new AudioDecoder({
            output: (ad) => { const tf = performance.now(); try { env.push(audioDataToMono(ad)); } catch (e) { decErr = e; } finally { ad.close(); } c.read.featureMs += performance.now() - tf; },
            error: (e) => { decErr = e; },
          });
          dec.configure(conf);
          wc = { dec, get err() { return decErr; } };
          c.path = 'AudioDecoder';
        }
      } catch (e) { c.read.webCodecsProbe = String(e && e.message || e); }
    }
    let ctx = null;
    if (!wc) {
      const OAC = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
      if (!OAC) throw new Error('This browser has no audio decoder that the page can use.');
      ctx = new OAC(1, 1, sr);
    }
    const decodeWrapped = (bytes) => new Promise((res, rej) => {
      try { const p = ctx.decodeAudioData(bytes.buffer, res, rej); if (p && p.catch) p.catch(rej); } catch (e) { rej(e); }
    });

    let next = readBatch(batches[0]);
    let expected = 0, got = 0;
    for (let bi = 0; bi < batches.length; bi++) {
      const data = await next;
      if (c.cancelled()) return;
      if (bi + 1 < batches.length && !c.stopped()) next = readBatch(batches[bi + 1]);
      const td = performance.now();
      if (wc) {
        const fr = data.frames.slice(data.pre);
        for (let k = 0; k < fr.length; k++) {
          wc.dec.decode(new EncodedAudioChunk({ type: 'key', timestamp: Math.round(((data.first + k) * spf * 1e6) / sr), data: fr[k] }));
        }
        await wc.dec.flush();
        if (wc.err) throw wc.err;
        c.read.decodeMs += performance.now() - td;
      } else {
        let ab = null;
        if (c.path !== 'M4A') {
          try { ab = await decodeWrapped(buildAdts(data.frames, cfg, channels)); c.path = 'ADTS'; }
          catch (e) { if (c.path === 'ADTS') throw e; c.read.adtsError = String(e && e.message || e); }
        }
        if (!ab) { ab = await decodeWrapped(buildM4a(data.frames, t.asc, sr, channels)); c.path = 'M4A'; }
        c.read.decodeMs += performance.now() - td;
        const tf = performance.now();
        const N = data.count * spf;
        const L = ab.length;
        let from = 0, len = Math.min(L, N);
        if (data.pre > 0 && L >= N) { from = L - N; len = N; }
        const chs = [];
        for (let c = 0; c < ab.numberOfChannels; c++) chs.push(ab.getChannelData(c).subarray(from, from + len));
        const mono = new Float32Array(len);
        for (const ch of chs) for (let i = 0; i < len; i++) mono[i] += ch[i];
        if (chs.length > 1) { const g = 1 / chs.length; for (let i = 0; i < len; i++) mono[i] *= g; }
        env.push(mono);
        got += len; expected += N;
        c.read.featureMs += performance.now() - tf;
      }
      progress(env.seconds);
      await c.tick();
      if (c.stopped()) break;
    }
    if (wc) { try { wc.dec.close(); } catch (e) {} }
    if (expected) c.read.decodeDriftMs = Math.round(((got - expected) / sr) * 1000);
    c.read.decodeMs = Math.round(c.read.decodeMs); c.read.featureMs = Math.round(c.read.featureMs);
  }

  function audioDataToMono(ad) {
    const n = ad.numberOfFrames, ch = ad.numberOfChannels;
    const out = new Float32Array(n);
    try {
      const tmp = new Float32Array(n);
      for (let c = 0; c < ch; c++) { ad.copyTo(tmp, { planeIndex: c, format: 'f32-planar' }); for (let i = 0; i < n; i++) out[i] += tmp[i]; }
    } catch (e) {
      const f = ad.format || '';
      const planar = f.endsWith('-planar');
      const Arr = f.startsWith('s16') ? Int16Array : f.startsWith('s32') ? Int32Array : f.startsWith('u8') ? Uint8Array : Float32Array;
      const scale = Arr === Int16Array ? 1 / 32768 : Arr === Int32Array ? 1 / 2147483648 : Arr === Uint8Array ? 1 / 128 : 1;
      const off = Arr === Uint8Array ? 128 : 0;
      out.fill(0);
      if (planar) {
        const tmp = new Arr(n);
        for (let c = 0; c < ch; c++) { ad.copyTo(tmp, { planeIndex: c }); for (let i = 0; i < n; i++) out[i] += (tmp[i] - off) * scale; }
      } else {
        const tmp = new Arr(n * ch);
        ad.copyTo(tmp, { planeIndex: 0 });
        for (let i = 0; i < n; i++) { let s = 0; for (let c = 0; c < ch; c++) s += tmp[i * ch + c] - off; out[i] = s * scale; }
      }
    }
    if (ch > 1) { const g = 1 / ch; for (let i = 0; i < n; i++) out[i] *= g; }
    return out;
  }

  async function readPcm(file, t, progress, c) {
    const fmt = pcmFormat(t);
    const chunks = pcmChunks(t, fmt);
    c.path = 'PCM';
    const env = c.env;
    const sr = env.sr;
    const batches = [];
    let cur = [], bytes = 0;
    for (const c of chunks) { cur.push(c); bytes += c.end - c.start; if (bytes >= 4e6) { batches.push(cur); cur = []; bytes = 0; } }
    if (cur.length) batches.push(cur);
    const readBatch = async (list) => {
      const offs = Float64Array.from(list.map((c) => c.start)), sizes = Float64Array.from(list.map((c) => c.end - c.start));
      const { ranges, map } = planRanges(offs, sizes, 0, list.length, 131072);
      const bufs = await pool(ranges, 6, (r) => readRange(file, r.start, r.end));
      c.read.reads += ranges.length;
      for (const r of ranges) c.read.bytesRead += r.end - r.start;
      return list.map((c, i) => { const rr = ranges[map[i]]; const o = c.start - rr.start; return bufs[map[i]].subarray(o, o + (c.end - c.start)); });
    };
    let next = readBatch(batches[0]);
    for (let bi = 0; bi < batches.length; bi++) {
      const parts = await next;
      if (c.cancelled()) return;
      if (bi + 1 < batches.length && !c.stopped()) next = readBatch(batches[bi + 1]);
      const tf = performance.now();
      for (const p of parts) {
        const usable = p.length - (p.length % fmt.bytesPerFrame);
        env.push(pcmToMono(p.subarray(0, usable), fmt));
      }
      c.read.featureMs += performance.now() - tf;
      progress(env.seconds);
      await c.tick();
      if (c.stopped()) break;
    }
    c.read.featureMs = Math.round(c.read.featureMs);
    c.read.pcm = fmt;
    if (sr && t.durationSec) c.read.decodeDriftMs = Math.round((env.samples / sr - t.durationSec) * 1000);
  }

  return { walkTop, children, parseMoov, parseAsc, parseEsds, trackKind, pcmFormat, sampleTable, pcmChunks, planRanges, pcmToMono, adtsHeader, buildAdts, buildM4a, readRange,
    Envelope, prepare, pickHits, groupRallies, planCut, pointBounds, planReel, pictureReel, reactionOf, netBurst, REELS, buildCut, evaluate, overlapShare, thresholds, DEFAULTS, synthMatch, wavBlobBytes, fourcc,
    pool, readAac, readPcm, audioDataToMono };
})();
if (typeof module !== 'undefined') module.exports = RF;

  globalThis.KicksmashRF = RF;
})();
