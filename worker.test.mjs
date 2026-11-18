import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pickFolder, listMusic, readMusic, cliResult, findYtDlp, isYoutubeUrl, parseSearch, videoFetcher, videoId, youtubeUrl, ytDlpError } from './worker.mjs'

// 손으로 끝낼 수 있는 가짜 yt-dlp. finish(내용)이면 파일을 쓰고 성공, fail()이면 실패한다.
async function fakeFetcher() {
  const dir = await mkdtemp(join(tmpdir(), 'orca-player-test-'))
  const runs = []
  const download = (ytdlp, id, file, onProgress, signal) =>
    new Promise((resolve, reject) => {
      runs.push({ id, file, signal, finish: async (body) => (await writeFile(file, body), resolve(file)), fail: () => reject(new Error('실패')) })
    })
  return { dir, runs, videos: videoFetcher({ dir, find: () => 'yt-dlp.exe', download, post: () => {}, wait: 50 }) }
}
const A = 'AAAAAAAAAAA'
const B = 'BBBBBBBBBBB'
const tick = () => new Promise((resolve) => setTimeout(resolve, 5))

test('A→B: 이전 다운로드를 중단하고 늦게 끝나도 버린다', async () => {
  const { runs, videos } = await fakeFetcher()
  const a = videos.fetch(A)
  await tick()
  videos.fetch(B)
  await tick()
  assert.equal(runs[0].signal.aborted, true)
  await runs[0].finish('a')
  assert.deepEqual(await a, { pending: true })
  assert.equal(existsSync(runs[0].file), false)
  await runs[1].finish('bb')
  assert.deepEqual(await videos.fetch(B), { size: 2 })
  assert.deepEqual(await videos.chunk(A), { error: '받아 둔 영상이 바뀌었습니다.' })
})

test('A→B→A: 첫 A가 먼저 끝나도 두 번째 A가 끝나기 전엔 준비되지 않는다', async () => {
  const { runs, videos } = await fakeFetcher()
  videos.fetch(A)
  await tick()
  videos.fetch(B)
  await tick()
  videos.fetch(A)
  await tick()
  assert.equal(runs.length, 3)
  assert.notEqual(runs[0].file, runs[2].file) // 같은 파일에 겹쳐 쓰지 않는다.
  await runs[0].finish('old')
  assert.deepEqual(await videos.fetch(A), { pending: true })
  await runs[2].finish('new!')
  assert.deepEqual(await videos.fetch(A), { size: 4 }) // 패널처럼 다시 묻는다.
  assert.equal(await readFile(runs[2].file, 'utf8'), 'new!')
  assert.equal(existsSync(runs[0].file), false)
  assert.equal(Buffer.from((await videos.chunk(A)).data, 'base64').toString(), 'new!')
  assert.equal(existsSync(runs[2].file), false) // 마지막 조각까지 넘기면 임시 파일을 지운다.
  assert.deepEqual(await videos.chunk(A), { error: '받아 둔 영상이 바뀌었습니다.' })
})

test('다운로드 실패는 오류로 알리고 다시 누르면 새로 받는다', async () => {
  const { runs, videos } = await fakeFetcher()
  const a = videos.fetch(A)
  await tick()
  runs[0].fail()
  assert.deepEqual(await a, { error: '실패' })
  videos.fetch(A)
  await tick()
  assert.equal(runs.length, 2)
  await runs[1].finish('ok')
  assert.deepEqual(await videos.fetch(A), { size: 2 })
})

test('유튜브 주소는 그대로, 나머지는 검색으로', () => {
  assert.equal(youtubeUrl('https://www.youtube.com/watch?v=abc'), 'https://www.youtube.com/watch?v=abc')
  assert.equal(youtubeUrl('youtu.be/abc'), 'https://youtu.be/abc')
  assert.equal(youtubeUrl('http://music.youtube.com/'), 'https://music.youtube.com/')
  assert.equal(youtubeUrl('아이유 밤편지'), 'https://www.youtube.com/results?search_query=%EC%95%84%EC%9D%B4%EC%9C%A0%20%EB%B0%A4%ED%8E%B8%EC%A7%80')
  assert.equal(youtubeUrl('https://evil.com/?youtube.com'), 'https://www.youtube.com/results?search_query=https%3A%2F%2Fevil.com%2F%3Fyoutube.com')
  assert.equal(youtubeUrl('javascript:alert(1)'), 'https://www.youtube.com/results?search_query=javascript%3Aalert(1)')
  assert.equal(youtubeUrl(''), 'https://www.youtube.com/')
})

test('검색 페이지에서 영상만 뽑는다', () => {
  const data = {
    contents: [
      { videoRenderer: { videoId: 'a1', title: { runs: [{ text: '제목' }, { text: '1' }] }, ownerText: { runs: [{ text: '채널' }] }, lengthText: { simpleText: '2:12' }, shortViewCountText: { simpleText: '7.3만' }, publishedTimeText: { simpleText: '1일 전' } } },
      { shelfRenderer: { items: [{ videoRenderer: { videoId: 'b2', title: { runs: [{ text: '라이브' }] }, badges: [{ metadataBadgeRenderer: { style: 'BADGE_STYLE_TYPE_LIVE_NOW' } }] } }] } },
      { channelRenderer: { channelId: 'x' } }
    ]
  }
  const html = `<script>var ytInitialData = ${JSON.stringify(data)};</script>`
  assert.deepEqual(parseSearch(html), [
    { id: 'a1', title: '제목1', channel: '채널', length: '2:12', views: '7.3만', published: '1일 전' },
    { id: 'b2', title: '라이브', channel: '', length: 'LIVE', views: '', published: '' }
  ])
  assert.throws(() => parseSearch('<html></html>'))
  assert.equal(isYoutubeUrl('youtu.be/abc'), true)
  assert.equal(isYoutubeUrl('2차전지'), false)
})

test('CLI 응답의 실패 코드를 살린다', () => {
  assert.deepEqual(cliResult(null, '{"ok":true,"result":{"a":1}}'), { a: 1 })
  assert.throws(() => cliResult(new Error('x'), '{"ok":false,"error":{"code":"browser_tab_not_found","message":"없음"}}'), { code: 'browser_tab_not_found', message: '없음' })
})

test('영상 주소에서 id를 꺼낸다', () => {
  assert.equal(videoId('https://www.youtube.com/watch?v=EVpLgcyptSc&t=3'), 'EVpLgcyptSc')
  assert.equal(videoId('youtu.be/EVpLgcyptSc'), 'EVpLgcyptSc')
  assert.equal(videoId('https://m.youtube.com/shorts/EVpLgcyptSc'), 'EVpLgcyptSc')
  assert.equal(videoId('https://www.youtube.com/@channel'), null)
  assert.equal(videoId('https://www.youtube.com/watch?v=bad'), null)
  assert.equal(videoId('2차전지'), null)
})

test('yt-dlp는 PATH, winget 폴더 순으로 찾는다', () => {
  const seen = new Set([join('C:/bin', 'yt-dlp.exe')])
  assert.equal(findYtDlp({ env: { PATH: 'C:/x;C:/bin' }, exists: (p) => seen.has(p), list: () => [] }), join('C:/bin', 'yt-dlp.exe'))
  const winget = (p) => p.includes('yt-dlp.yt-dlp_Microsoft')
  assert.match(findYtDlp({ env: { PATH: '' }, exists: winget, list: () => ['other', 'yt-dlp.yt-dlp_Microsoft.Winget.Source_8wekyb3d8bbwe'] }), /yt-dlp\.yt-dlp_Microsoft.*yt-dlp\.exe$/)
  assert.equal(findYtDlp({ env: {}, exists: () => false, list: () => { throw new Error('no dir') } }), null)
})

test('yt-dlp 오류 메시지', () => {
  assert.match(ytDlpError('WARNING: x\nERROR: [youtube] a: Failed to extract any player response; please report'), /차단/)
  assert.equal(ytDlpError('ERROR: Video unavailable'), 'Video unavailable')
})

test('음악 폴더는 음악/lrc만 목록에 넣고, 목록에 있는 번호만 읽게 한다', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-music-'))
  await mkdir(join(root, 'sub'))
  await writeFile(join(root, 'sub', 'a.mp3'), 'abc')
  await writeFile(join(root, 'sub', 'a.lrc'), '[00:01.00]x')
  await writeFile(join(root, 'memo.txt'), 'no')
  const files = []
  const list = listMusic(root, files)
  assert.deepEqual(list.map((f) => [f.path.replace(/^[^/]+\//, ''), f.size]).sort(), [['sub/a.lrc', 11], ['sub/a.mp3', 3]])
  const mp3 = list.find((f) => f.path.endsWith('.mp3'))
  assert.equal(Buffer.from((await readMusic(mp3.id, 0, files)).data, 'base64').toString(), 'abc')
  assert.equal((await readMusic(mp3.id, 3, files)).data, '')
  assert.ok((await readMusic(99, 0, files)).error)
})

test('입력칸 있는 폴더 창이 실패하면 기본 폴더 창으로 다시 시도한다', async () => {
  const calls = []
  const run = async (script) => (calls.push(script), calls.length === 1 ? Promise.reject(new Error('Add-Type 차단')) : 'D:\music')
  assert.equal(await pickFolder(run), 'D:\music')
  assert.equal(calls.length, 2)
  assert.equal(await pickFolder(async () => null), null) // 취소는 다시 열지 않는다.
})

test('다운로드가 실패하면 합치다 남은 조각 파일도 지운다', async () => {
  const { dir, runs, videos } = await fakeFetcher()
  const pending = videos.fetch(A)
  await tick()
  const base = runs[0].file.replace(/\.mp4$/, '')
  const leftovers = [`${base}.f137.mp4`, `${base}.f140.m4a.part`, `${base}.temp.mp4`]
  for (const f of leftovers) await writeFile(f, 'x')
  const other = join(dir, 'ZZZZZZZZZZZ-1.f137.mp4') // 다른 영상 파일은 건드리지 않는다.
  await writeFile(other, 'x')
  runs[0].fail()
  await pending
  for (const f of leftovers) assert.equal(existsSync(f), false, f)
  assert.equal(existsSync(other), true)
})

test('초기화하면 받던 다운로드를 멈추고 받아 둔 영상 파일을 지운다', async () => {
  const { runs, videos } = await fakeFetcher()
  const first = videos.fetch(A)
  await tick()
  await runs[0].finish('abc')
  assert.deepEqual(await first, { size: 3 })
  assert.equal(existsSync(runs[0].file), true)
  await videos.reset()
  assert.equal(existsSync(runs[0].file), false)
  assert.deepEqual(await videos.chunk(A), { error: '받아 둔 영상이 바뀌었습니다.' })
  videos.fetch(B)
  await tick()
  await videos.reset()
  assert.equal(runs[1].signal.aborted, true) // 받는 중이던 것은 중단한다.
})
