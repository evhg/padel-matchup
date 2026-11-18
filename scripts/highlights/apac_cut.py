"""Cut the spatial sound track out of an iPhone video, as a small file of its own.

    python apac_cut.py <in.mov> <out.mov> [start s] [seconds]

An iPhone 16 or newer records a second sound track beside the stereo one: four channels that hold
the sound field around the phone (codec tag "apac"). FFmpeg cannot decode it, and a plain
"-c copy" drops the settings block ("dapa") that Apple's decoder needs. So this tool copies the
track by hand: the sample description goes over byte for byte, the tables are written again, and
nothing else from the video comes along (no picture, no stereo track, no location tags).

The result is about 3 MB a minute. A Mac decodes it with:
    afconvert -f WAVE -d LEI24@48000 out.mov out.wav
"""
import os
import struct
import sys

CONTAINERS = ('moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'dinf')


def boxes(f, start, end):
    p = start
    while p + 8 <= end:
        f.seek(p)
        size, kind = struct.unpack('>I4s', f.read(8))
        head = 8
        if size == 1:
            size = struct.unpack('>Q', f.read(8))[0]
            head = 16
        elif size == 0:
            size = end - p
        if size < head:
            break
        yield p, size, head, kind.decode('latin1')
        p += size


def children(f, box):
    p, size, head, _ = box
    return {k: (q, s, h, k) for q, s, h, k in boxes(f, p + head, p + size)}


def body(f, box):
    p, size, head, _ = box
    f.seek(p + head)
    return f.read(size - head)


def raw(f, box):
    f.seek(box[0])
    return f.read(box[1])


def box(kind, payload):
    return struct.pack('>I4s', 8 + len(payload), kind.encode('latin1')) + payload


def find_track(f, moov):
    """The first track whose sample description is 'apac'."""
    for b in boxes(f, moov[0] + moov[2], moov[0] + moov[1]):
        if b[3] != 'trak':
            continue
        trak = children(f, b)
        mdia = children(f, trak['mdia'])
        stbl = children(f, children(f, mdia['minf'])['stbl'])
        if body(f, stbl['stsd'])[12:16] == b'apac':
            return b, trak, mdia, stbl
    return None


def runs(data, at=4):
    """A table of (count, value) pairs after a 4-byte version and a 4-byte entry count."""
    n = struct.unpack('>I', data[at:at + 4])[0]
    return [struct.unpack('>II', data[at + 4 + 8 * i:at + 12 + 8 * i]) for i in range(n)]


def cut_runs(pairs, a, b):
    """Keep samples a..b-1 of a run-length table."""
    out, at = [], 0
    for count, value in pairs:
        lo, hi = max(at, a), min(at + count, b)
        if hi > lo:
            if out and out[-1][1] == value:
                out[-1] = (out[-1][0] + hi - lo, value)
            else:
                out.append((hi - lo, value))
        at += count
    return out


def main():
    src, dst = sys.argv[1], sys.argv[2]
    start_s = float(sys.argv[3]) if len(sys.argv) > 3 else 0.0
    length_s = float(sys.argv[4]) if len(sys.argv) > 4 else None
    f = open(src, 'rb')
    top = {k: (p, s, h, k) for p, s, h, k in boxes(f, 0, os.path.getsize(src))}
    if 'moov' not in top:
        sys.exit('no moov box: the file is not complete')
    found = find_track(f, top['moov'])
    if not found:
        sys.exit('no spatial sound track (apac) in this file')
    _, trak, mdia, stbl = found

    mdhd = body(f, mdia['mdhd'])
    if mdhd[0] != 0:
        sys.exit('mdhd version 1 is not handled')
    scale = struct.unpack('>I', mdhd[12:16])[0]
    stts = runs(body(f, stbl['stts']))
    sizes_raw = body(f, stbl['stsz'])
    fixed, total = struct.unpack('>II', sizes_raw[4:12])
    sizes = [fixed] * total if fixed else list(struct.unpack('>%dI' % total, sizes_raw[12:12 + 4 * total]))
    if 'co64' in stbl:
        d = body(f, stbl['co64'])
        chunks = list(struct.unpack('>%dQ' % struct.unpack('>I', d[4:8])[0], d[8:]))
    else:
        d = body(f, stbl['stco'])
        chunks = list(struct.unpack('>%dI' % struct.unpack('>I', d[4:8])[0], d[8:]))
    d = body(f, stbl['stsc'])
    n = struct.unpack('>I', d[4:8])[0]
    stsc = [struct.unpack('>III', d[8 + 12 * i:20 + 12 * i]) for i in range(n)]

    # Where each sample is in the source file.
    offsets, s = [], 0
    for i, (first, per, _desc) in enumerate(stsc):
        last = stsc[i + 1][0] - 1 if i + 1 < len(stsc) else len(chunks)
        for c in range(first - 1, last):
            at = chunks[c]
            for _ in range(per):
                if s >= total:
                    break
                offsets.append(at)
                at += sizes[s]
                s += 1
    if len(offsets) != total:
        sys.exit('the tables do not agree: %d places for %d samples' % (len(offsets), total))

    # Sample times, then the wanted range. The cut starts on a sync sample.
    times, t = [], 0
    for count, delta in stts:
        for _ in range(count):
            times.append(t)
            t += delta
    media_len = t
    sync = None
    if 'stss' in stbl:
        d = body(f, stbl['stss'])
        sync = list(struct.unpack('>%dI' % struct.unpack('>I', d[4:8])[0], d[8:]))
    a = 0
    while a + 1 < total and times[a + 1] <= start_s * scale:
        a += 1
    if sync:
        a = max([x - 1 for x in sync if x - 1 <= a] or [0])
    b = total
    if length_s is not None:
        end = times[a] + length_s * scale
        b = a
        while b < total and times[b] < end:
            b += 1
    count = b - a
    new_len = (times[b] if b < total else media_len) - times[a]

    # New tables.
    PER = 64
    n_chunks = (count + PER - 1) // PER
    new_stts = cut_runs(stts, a, b)
    v = b'\0\0\0\0'
    t_stts = box('stts', v + struct.pack('>I', len(new_stts)) + b''.join(struct.pack('>II', *r) for r in new_stts))
    t_stsz = box('stsz', v + struct.pack('>II', 0, count) + struct.pack('>%dI' % count, *sizes[a:b]))
    entries = [(1, PER, 1)] if count >= PER else []
    if count % PER:
        entries.append((n_chunks, count % PER, 1))
    t_stsc = box('stsc', v + struct.pack('>I', len(entries)) + b''.join(struct.pack('>III', *e) for e in entries))
    extra = b''
    if sync:
        keep = [x - a for x in sync if a < x <= b]
        extra += box('stss', v + struct.pack('>I', len(keep)) + struct.pack('>%dI' % len(keep), *keep))
    groups = b''
    minf = children(f, mdia['minf'])
    stbl_box = minf['stbl']
    for q, s_, h, k in boxes(f, stbl_box[0] + stbl_box[2], stbl_box[0] + stbl_box[1]):
        if k == 'sgpd':
            groups += raw(f, (q, s_, h, k))
        if k == 'sbgp':
            d = body(f, (q, s_, h, k))
            skip = 12 if d[0] == 1 else 8
            pairs = cut_runs(runs(d, skip), a, b)
            groups += box('sbgp', d[:skip] + struct.pack('>I', len(pairs)) + b''.join(struct.pack('>II', *r) for r in pairs))

    def moov_bytes(first_offset):
        offs, at = [], first_offset
        for c in range(n_chunks):
            offs.append(at)
            at += sum(sizes[a + c * PER:a + min((c + 1) * PER, count)])
        t_co64 = box('co64', v + struct.pack('>I', n_chunks) + struct.pack('>%dQ' % n_chunks, *offs))
        new_stbl = box('stbl', raw(f, stbl['stsd']) + groups + t_stts + extra + t_stsc + t_stsz + t_co64)
        keep = b''.join(raw(f, minf[k]) for k in ('smhd', 'hdlr', 'dinf') if k in minf)
        new_mdhd = box('mdhd', mdhd[:16] + struct.pack('>I', new_len) + mdhd[20:])
        new_mdia = box('mdia', new_mdhd + b''.join(raw(f, mdia[k]) for k in ('elng', 'hdlr') if k in mdia)
                       + box('minf', keep + new_stbl))
        mvhd = body(f, children(f, top['moov'])['mvhd'])
        if mvhd[0] != 0:
            sys.exit('mvhd version 1 is not handled')
        movie_scale = struct.unpack('>I', mvhd[12:16])[0]
        movie_len = round(new_len * movie_scale / scale)
        tkhd = bytearray(body(f, trak['tkhd']))
        tkhd[1:4] = (0, 0, 0x0f)                      # enabled, in the movie, in preview and poster
        tkhd[20:24] = struct.pack('>I', movie_len)
        tkhd[34:36] = b'\0\0'                         # no alternate group: this is the only track
        # The first sample of a cut is a sync sample, so the edit list starts at media time 0.
        elst = box('edts', box('elst', v + struct.pack('>IIiI', 1, movie_len, 0, 0x00010000)))
        new_trak = box('trak', box('tkhd', bytes(tkhd)) + elst + new_mdia)
        new_mvhd = box('mvhd', mvhd[:16] + struct.pack('>I', movie_len) + mvhd[20:])
        return box('moov', new_mvhd + new_trak)

    ftyp = raw(f, top['ftyp'])
    data_len = sum(sizes[a:b])
    head = 16 if data_len + 8 > 0xffffffff else 8
    moov = moov_bytes(len(ftyp) + len(moov_bytes(0)) + head)
    with open(dst, 'wb') as out:
        out.write(ftyp)
        out.write(moov)
        if head == 16:
            out.write(struct.pack('>I4sQ', 1, b'mdat', data_len + 16))
        else:
            out.write(struct.pack('>I4s', data_len + 8, b'mdat'))
        # Samples that touch in the source are read in one go.
        i = a
        while i < b:
            j, size = i + 1, sizes[i]
            while j < b and offsets[j] == offsets[j - 1] + sizes[j - 1] and size < (8 << 20):
                size += sizes[j]
                j += 1
            f.seek(offsets[i])
            out.write(f.read(size))
            i = j
    print('APAC_CUT samples %d  from %.2f s  length %.2f s  %.1f MB' % (
        count, times[a] / scale, new_len / scale, os.path.getsize(dst) / 1e6))


if __name__ == '__main__':
    main()
