import assert from 'node:assert/strict'
import { test } from 'node:test'
import { formatTime, lrcMatcher, lyricIndex, nameInfo, nextIndex, parseId3, parseLrc } from './player.js'

test('LRC: 같은 시각 줄을 묶고 offset과 여러 시각 태그를 처리한다', () => {
  const lrc = '[ti:노래]\n[offset:500]\n[00:01.00]첫 줄\n[00:01.00]first\n[00:03.50][00:10.00]후렴\n[00:05:20]콜론 표기'
  const lyrics = parseLrc(lrc)
  assert.deepEqual(lyrics.map((l) => l.lines), [['첫 줄', 'first'], ['후렴'], ['콜론 표기'], ['후렴']])
  assert.equal(lyrics[0].time, 0.5)
  assert.equal(lyricIndex(lyrics, 0.2), -1)
  assert.equal(lyricIndex(lyrics, 3.1), 1)
  assert.equal(lyricIndex(lyrics, 99), 3)
})

function frame(id, body) {
  const head = new Uint8Array(10)
  head.set([...id].map((c) => c.charCodeAt(0)))
  new DataView(head.buffer).setUint32(4, body.length)
  return [...head, ...body]
}

test('ID3v2.3: CP949 제목, UTF-16 아티스트, USLT, APIC를 읽는다', () => {
  const utf16 = (s) => [0xff, 0xfe, ...[...s].flatMap((c) => [c.charCodeAt(0) & 255, c.charCodeAt(0) >> 8])]
  const frames = [
    ...frame('TIT2', [0, 0xb3, 0xeb, 0xb7, 0xa1]), // "노래" (CP949)
    ...frame('TPE1', [1, ...utf16('가수')]),
    ...frame('USLT', [3, 0x6b, 0x6f, 0x72, 0, ...new TextEncoder().encode('[00:01.00]가사')]),
    ...frame('APIC', [0, ...new TextEncoder().encode('image/png'), 0, 3, 0, 1, 2, 3])
  ]
  const size = frames.length + 16 // 패딩
  const head = [0x49, 0x44, 0x33, 3, 0, 0, (size >> 21) & 127, (size >> 14) & 127, (size >> 7) & 127, size & 127]
  const tags = parseId3(new Uint8Array([...head, ...frames, ...new Array(16).fill(0), 0xff, 0xfb]).buffer)
  assert.equal(tags.title, '노래')
  assert.equal(tags.artist, '가수')
  assert.equal(tags.lyrics, '[00:01.00]가사')
  assert.equal(tags.picture.mime, 'image/png')
  assert.deepEqual([...tags.picture.data], [1, 2, 3])
  assert.deepEqual(parseId3(new Uint8Array([0xff, 0xfb, 0, 0]).buffer), {})
})

test('LRC 짝: 폴더가 다른 같은 이름 곡은 각자 폴더의 가사를 받는다', () => {
  const f = (name, dir = '') => ({ name, webkitRelativePath: dir && `${dir}/${name}` })
  const lrcA = f('01.lrc', 'top/albumA')
  const lrcB = f('01.lrc', 'top/albumB')
  const folder = lrcMatcher([lrcA, lrcB])
  assert.equal(folder(f('01.mp3', 'top/albumA')), lrcA)
  assert.equal(folder(f('01.mp3', 'top/albumB')), lrcB)
  assert.equal(folder(f('01.mp3', 'top/albumC')), undefined)
  assert.equal(folder(f('01.mp3')), undefined) // 같은 이름이 여럿이면 고르지 않는다.
  // 파일로 고른 경우와, 폴더로 넣은 곡에 .lrc만 따로 넣는 경우
  const single = f('아이유 - 밤편지.LRC')
  assert.equal(lrcMatcher([single])(f('아이유 - 밤편지.mp3')), single)
  assert.equal(lrcMatcher([single])(f('아이유 - 밤편지.mp3', 'top/x')), single)
  assert.equal(lrcMatcher([lrcA])(f('01.mp3')), lrcA)
  assert.equal(lrcMatcher([])(f('01.mp3')), undefined)
})

test('파일 이름, 다음 곡, 시간 표시', () => {
  assert.deepEqual(nameInfo('아이유 - 밤편지.mp3'), { artist: '아이유', title: '밤편지' })
  assert.deepEqual(nameInfo('track01.flac'), { artist: '', title: 'track01' })
  assert.equal(nextIndex(2, 3, { auto: true }), -1)
  assert.equal(nextIndex(2, 3, { auto: true, repeat: 'all' }), 0)
  assert.equal(nextIndex(1, 3, { auto: true, repeat: 'one' }), 1)
  assert.equal(nextIndex(1, 3, { repeat: 'one' }), 2)
  assert.equal(nextIndex(0, 3, { step: -1 }), 2)
  assert.notEqual(nextIndex(1, 3, { shuffle: true }), 1)
  assert.equal(formatTime(125.9), '2:05')
})
