import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pickFolder, listMusic, loadMusicFolder, readMusic, cliResult, findYtDlp, isYoutubeUrl, parsePlaylist, parseSearch, playbackCoordinator, popularYoutube, POPULAR_AI_QUERY, POPULAR_MUSIC_PLAYLIST, POPULAR_TODAY_SP, relatedYoutube, videoFetcher, videoId, youtubeUrl, ytDlpError } from './worker.mjs'

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

test('오늘의 AI 인기 영상은 continuation으로 중복 없이 30개로 제한해  채우고 조회수 형식을 맞춘다', async () => {
  const item = (n, views) => ({
    videoRenderer: {
      videoId: `vid_${String(n).padStart(7, '0')}`,
      title: { runs: [{ text: `AI 영상 ${n}` }] },
      ownerText: { runs: [{ text: `채널 ${n}` }] },
      lengthText: { simpleText: '5:00' },
      shortViewCountText: { simpleText: views },
      publishedTimeText: { simpleText: '3시간 전' }
    }
  })
  const page1 = {
    contents: [
      ...Array.from({ length: 20 }, (_, i) => item(i + 1, `${20 - i}만`)),
      { continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token: 'TOK1' } } } }
    ]
  }
  const page2 = {
    onResponseReceivedCommands: [
      item(20, '조회수 1만회'), // 첫 페이지와 중복 id는 건너뛴다.
      ...Array.from({ length: 15 }, (_, i) => item(i + 21, `조회수 ${15 - i}천회`))
    ]
  }
  const calls = []
  const fakeFetch = async (url, init) => {
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body })
    if (url.startsWith('https://www.youtube.com/results?')) {
      return { ok: true, text: async () => `<script>"INNERTUBE_API_KEY":"KEY123","INNERTUBE_CLIENT_VERSION":"2.2026"</script><script>var ytInitialData = ${JSON.stringify(page1)};</script>` }
    }
    if (url.startsWith('https://www.youtube.com/youtubei/v1/search?key=KEY123')) {
      return { ok: true, json: async () => page2 }
    }
    return { ok: true, arrayBuffer: async () => new Uint8Array([1, 2]).buffer }
  }

  const list = await popularYoutube({ limit: 30, fetchImpl: fakeFetch })
  assert.equal(list.length, 30)
  assert.equal(new Set(list.map((v) => v.id)).size, 30)
  assert.equal(list[0].views, '20만')
  assert.equal(list[20].id, 'vid_0000021')
  assert.equal(list[20].views, '15천') // "조회수 15천회" -> "15천"
  assert.equal(list[0].thumb, 'data:image/jpeg;base64,AQI=')
  assert.ok(calls[0].url.includes(`search_query=${encodeURIComponent(POPULAR_AI_QUERY)}`))
  assert.ok(calls[0].url.includes(`sp=${POPULAR_TODAY_SP}`))
  assert.equal(calls[1].method, 'POST')
  assert.equal(JSON.parse(calls[1].body).continuation, 'TOK1')
})

test('continuation 요청이 실패해도 첫 페이지 인기 영상은 그대로 돌려준다', async () => {
  const page1 = {
    contents: [
      { videoRenderer: { videoId: 'vid_0000001', title: { simpleText: 'AI 1' } } },
      { continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token: 'TOK_FAIL' } } } }
    ]
  }
  const fakeFetch = async (url) => {
    if (url.startsWith('https://www.youtube.com/results?')) {
      return { ok: true, text: async () => `<script>"INNERTUBE_API_KEY":"K"</script><script>var ytInitialData = ${JSON.stringify(page1)};</script>` }
    }
    if (url.includes('/youtubei/v1/search')) throw new Error('network error')
    return { ok: false }
  }
  const list = await popularYoutube({ fetchImpl: fakeFetch })
  assert.equal(list.length, 1)
  assert.equal(list[0].id, 'vid_0000001')
})

test('음악 폴더 자동 복원은 존재하는 폴더만 읽고 없는 경로는 missing을 돌려준다', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-music-restore-'))
  await writeFile(join(root, 'song.mp3'), '1234')
  const files = []
  const ok = loadMusicFolder(root, files)
  assert.equal(ok.root, root)
  assert.equal(ok.files.length, 1)
  assert.deepEqual(loadMusicFolder(join(root, 'missing-dir'), files), { missing: true })
  assert.deepEqual(loadMusicFolder('', files), { missing: true })
})

test('유튜브 오디오 전용 모드는 같은 id라도 별도 작업으로 m4a와 audio/mp4를 반환한다', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'orca-player-audio-'))
  const runs = []
  const download = (ytdlp, id, file, onProgress, signal, opts) =>
    new Promise((resolve) => {
      runs.push({ id, file, opts, finish: async (body) => (await writeFile(file, body), resolve(file)) })
    })
  const videos = videoFetcher({ dir, find: () => 'yt-dlp.exe', download, post: () => {}, wait: 50 })

  const v = videos.fetch(A)
  await tick()
  await runs[0].finish('mp4data')
  assert.deepEqual(await v, { size: 7 })
  assert.equal(runs[0].opts.audioOnly, false)
  assert.ok(runs[0].file.endsWith('.mp4'))

  const a = videos.fetch(A, { audioOnly: true })
  await tick()
  await runs[1].finish('m4a')
  assert.deepEqual(await a, { size: 3, mime: 'audio/mp4' })
  assert.equal(runs[1].opts.audioOnly, true)
  assert.ok(runs[1].file.endsWith('.m4a'))
})

test('인기 음악 프리셋은 공식 차트 재생목록(lockupViewModel)을 파싱한다', async () => {
  const playlistData = {
    contents: [
      {
        lockupViewModel: {
          contentId: 'AAAAAAAAAAA',
          metadata: {
            lockupMetadataViewModel: {
              title: { content: '인기곡 1' },
              metadata: {
                contentMetadataViewModel: {
                  metadataRows: [
                    { metadataParts: [{ text: { content: '아티스트' } }] },
                    { metadataParts: [{ text: { content: '조회수 120만회' } }, { text: { content: '2일 전' } }] }
                  ]
                }
              }
            }
          },
          contentImage: {
            thumbnailViewModel: {
              overlays: [{ thumbnailBottomOverlayViewModel: { badges: [{ thumbnailBadgeViewModel: { text: '3:25' } }] } }]
            }
          }
        }
      }
    ]
  }
  const html = `<script>var ytInitialData = ${JSON.stringify(playlistData)};</script>`
  assert.deepEqual(parsePlaylist(html), [
    { id: 'AAAAAAAAAAA', title: '인기곡 1', channel: '아티스트', length: '3:25', views: '120만', published: '2일 전' }
  ])
  const calls = []
  const fakeFetch = async (url) => {
    calls.push(url)
    if (url.includes('/playlist?')) return { ok: true, text: async () => html }
    return { ok: true, arrayBuffer: async () => new Uint8Array([9]).buffer }
  }
  const list = await popularYoutube({ topic: 'music', fetchImpl: fakeFetch })
  assert.ok(calls[0].includes(`list=${POPULAR_MUSIC_PLAYLIST}`))
  assert.equal(list.length, 1)
  assert.equal(list[0].thumb, 'data:image/jpeg;base64,CQ==')
})

test('관련 영상(다음 자동 재생)은 자기 자신 id를 제외하고 추천 영상을 뽑는다', async () => {
  const watchData = {
    contents: [
      { lockupViewModel: { contentId: A, metadata: { lockupMetadataViewModel: { title: { content: '현재 영상' } } } } },
      { lockupViewModel: { contentId: B, metadata: { lockupMetadataViewModel: { title: { content: '다음 추천' } } } } },
      { compactVideoRenderer: { videoId: 'CCCCCCCCCCC', title: { simpleText: '추천 2' }, longBylineText: { runs: [{ text: '채널' }] }, shortViewCountText: { simpleText: '조회수 5만회' } } }
    ]
  }
  const html = `<script>var ytInitialData = ${JSON.stringify(watchData)};</script>`
  const fakeFetch = async (url) => {
    if (url.includes('/watch?')) return { ok: true, text: async () => html }
    return { ok: true, arrayBuffer: async () => new Uint8Array([3]).buffer }
  }
  const list = await relatedYoutube(A, { limit: 2, fetchImpl: fakeFetch })
  assert.deepEqual(list.map((v) => v.id), [B, 'CCCCCCCCCCC'])
  assert.equal(list[1].views, '5만')
  assert.equal(list[0].thumb, 'data:image/jpeg;base64,Aw==')
  await assert.rejects(() => relatedYoutube('bad', { fetchImpl: fakeFetch }))
})

test('패널이 닫히거나 하트비트가 끊기면 백그라운드 재생을 이어받고, 다시 열리면 현재 위치를 돌려준다', async () => {
  let clock = 1000
  const played = []
  let endedCb = null
  const fakePlayer = {
    warmup() {},
    async play(file, opts) { played.push({ file, ...opts }) },
    async stop() { return 42.5 },
    onEnded(fn) { endedCb = fn },
    dispose() {}
  }
  const bg = playbackCoordinator({
    player: fakePlayer,
    resolveFile: (s) => (s.kind === 'music' ? `/music/${s.trackId}.mp3` : null),
    nextItem: async (ended) => ({ ...ended, trackId: ended.trackId + 1, path: 'next.mp3' }),
    now: () => clock,
    staleMs: 25
  })

  bg.updateState({ kind: 'music', trackId: 1, path: 'first.mp3', time: 10, volume: 0.7, rate: 1, playing: true })
  clock = 3000 // 하트비트가 끊긴 뒤 2초 경과 시뮬레이션
  await new Promise((r) => setTimeout(r, 40))

  assert.equal(played.length, 1)
  assert.equal(played[0].file, '/music/1.mp3')
  assert.equal(played[0].time, 12) // 10초 + 2초 경과 보정
  assert.equal(played[0].volume, 0.7)

  // 백그라운드 재생 중 곡이 끝나면 다음 곡으로 이어 재생한다.
  await endedCb()
  assert.equal(played.length, 2)
  assert.equal(played[1].file, '/music/2.mp3')
  assert.equal(played[1].time, 0)

  // 다시 패널로 돌아오면 백그라운드 재생을 멈추고 현재 위치와 바뀐 곡 정보를 넘긴다.
  const resumed = await bg.takeover()
  assert.equal(resumed.active, true)
  assert.equal(resumed.state.trackId, 2)
  assert.equal(resumed.state.time, 42.5)
  assert.deepEqual(await bg.takeover(), { active: false })

  // pagehide 즉시 인계(handoff)도 바로 백그라운드 재생을 시작한다.
  bg.handoff({ kind: 'music', trackId: 3, path: 'third.mp3', time: 5, volume: 0.5, rate: 1, playing: true })
  await tick()
  assert.equal(played.length, 3)
  assert.equal(played[2].file, '/music/3.mp3')
  assert.equal(played[2].time, 5)
  await bg.stop()
})

test('하트비트에 큐가 없으면 이전 큐를 유지하고, stop 뒤에는 시작 중이던 재생이 되살아나지 않는다', async () => {
  const played = []
  let endedCb
  const bg = playbackCoordinator({
    player: { play: async (f) => played.push(f), stop: async () => 0, onEnded: (fn) => (endedCb = fn), warmup() {}, dispose() {} },
    resolveFile: (s) => `/m/${s.trackId}.mp3`,
    nextItem: async (e) => e.queue[1] && { ...e, trackId: e.queue[1].id },
    staleMs: 10
  })
  bg.updateState({ kind: 'music', trackId: 1, time: 0, rate: 1, playing: true, queue: [{ id: 1 }, { id: 2 }] })
  bg.updateState({ kind: 'music', trackId: 1, time: 1, rate: 1, playing: true })
  await new Promise((r) => setTimeout(r, 30))
  await endedCb()
  assert.deepEqual(played, ['/m/1.mp3', '/m/2.mp3'])
  await bg.stop()
})
