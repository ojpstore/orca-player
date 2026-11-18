// 패널과 테스트가 같이 쓰는 순수 로직: LRC 가사, ID3v2 태그, 셔플/반복 순서.

const TIME = /\[(\d+):(\d+(?:[.:]\d+)?)\]/g

// 알송 가사는 같은 시각에 원문·발음·번역 줄이 겹쳐 오므로 시각별로 묶는다.
export function parseLrc(text) {
  const offsetMatch = text.match(/\[offset:\s*([+-]?\d+)\]/i)
  const offset = offsetMatch ? Number(offsetMatch[1]) / 1000 : 0
  const byTime = new Map()
  for (const raw of text.split(/\r?\n/)) {
    const times = [...raw.matchAll(TIME)]
    if (!times.length) continue
    const line = raw.replace(TIME, '').trim()
    for (const [, m, s] of times) {
      const t = Math.max(0, Number(m) * 60 + Number(s.replace(':', '.')) - offset)
      const key = Math.round(t * 100)
      if (!byTime.has(key)) byTime.set(key, { time: t, lines: [] })
      if (line) byTime.get(key).lines.push(line)
    }
  }
  return [...byTime.values()].sort((a, b) => a.time - b.time)
}

// 현재 시각에 보일 가사 줄의 인덱스, 첫 줄 전이면 -1.
export function lyricIndex(lyrics, time) {
  let lo = 0
  let hi = lyrics.length - 1
  let found = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (lyrics[mid].time <= time) {
      found = mid
      lo = mid + 1
    } else hi = mid - 1
  }
  return found
}

const syncsafe = (b, i) => (b[i] << 21) | (b[i + 1] << 14) | (b[i + 2] << 7) | b[i + 3]

// 인코딩 0은 규격상 Latin-1이지만 국내 MP3는 대부분 CP949로 써서 euc-kr로 읽는다.
const DECODERS = ['euc-kr', 'utf-16', 'utf-16be', 'utf-8']

// 종료 문자(UTF-16은 0x0000)까지 읽고 [문자열, 다음 위치]를 돌려준다.
function readString(bytes, start, encoding, end = bytes.length) {
  const wide = encoding === 1 || encoding === 2
  let stop = start
  while (stop < end && (wide ? bytes[stop] || bytes[stop + 1] : bytes[stop])) stop += wide ? 2 : 1
  const text = new TextDecoder(DECODERS[encoding] ?? 'utf-8').decode(bytes.subarray(start, stop))
  return [text.replace(/^﻿/, '').trim(), Math.min(end, stop + (wide ? 2 : 1))]
}

// ID3v2.3/2.4의 제목·아티스트·앨범·가사·앨범아트만 읽는다.
// ponytail: unsynchronisation 플래그와 v2.2(3글자 프레임)는 무시한다. 깨진 태그가 보이면 그때 처리.
export function parseId3(buffer) {
  const b = new Uint8Array(buffer)
  const tags = {}
  if (b.length < 10 || b[0] !== 0x49 || b[1] !== 0x44 || b[2] !== 0x33) return tags
  const version = b[3]
  if (version !== 3 && version !== 4) return tags
  const end = Math.min(b.length, 10 + syncsafe(b, 6))
  let pos = 10
  if (b[5] & 0x40) pos += version === 4 ? syncsafe(b, pos) : 4 + ((b[pos] << 24) | (b[pos + 1] << 16) | (b[pos + 2] << 8) | b[pos + 3])
  while (pos + 10 <= end) {
    const id = String.fromCharCode(b[pos], b[pos + 1], b[pos + 2], b[pos + 3])
    if (!/^[A-Z0-9]{4}$/.test(id)) break
    const size = version === 4 ? syncsafe(b, pos + 4) : ((b[pos + 4] << 24) | (b[pos + 5] << 16) | (b[pos + 6] << 8) | b[pos + 7]) >>> 0
    const body = pos + 10
    const stop = Math.min(end, body + size)
    const enc = b[body]
    if (id === 'TIT2' || id === 'TPE1' || id === 'TALB') {
      tags[{ TIT2: 'title', TPE1: 'artist', TALB: 'album' }[id]] = readString(b, body + 1, enc, stop)[0]
    } else if (id === 'USLT' && !tags.lyrics) {
      const [, textStart] = readString(b, body + 4, enc, stop)
      tags.lyrics = new TextDecoder(DECODERS[enc] ?? 'utf-8').decode(b.subarray(textStart, stop)).replace(/^﻿/, '')
    } else if (id === 'APIC' && !tags.picture) {
      const [mime, afterMime] = readString(b, body + 1, 0, stop)
      const [, dataStart] = readString(b, afterMime + 1, enc, stop)
      tags.picture = { mime: mime || 'image/jpeg', data: b.slice(dataStart, stop) }
    }
    pos = stop
  }
  return tags
}

// "아티스트 - 제목.mp3" 형식의 파일 이름에서 태그 대신 쓸 값을 얻는다.
export function nameInfo(fileName) {
  const base = fileName.replace(/\.[^.]+$/, '')
  const dash = base.indexOf(' - ')
  return dash > 0 ? { artist: base.slice(0, dash).trim(), title: base.slice(dash + 3).trim() } : { artist: '', title: base }
}

// 다음 곡 인덱스. repeat: 'off' | 'all' | 'one'. 끝나면 -1.
export function nextIndex(current, length, { repeat = 'off', shuffle = false, step = 1, auto = false, random = Math.random } = {}) {
  if (!length) return -1
  if (auto && repeat === 'one') return current
  if (shuffle && length > 1) {
    let pick = current
    while (pick === current) pick = Math.floor(random() * length)
    return pick
  }
  const next = current + step
  if (next >= 0 && next < length) return next
  if (repeat === 'off' && auto) return -1
  return (next + length) % length
}

export function formatTime(seconds) {
  if (!Number.isFinite(seconds)) return '0:00'
  const s = Math.floor(seconds)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
