import { execFile, spawn } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { mkdir, open as openFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, extname, join } from 'node:path'

const YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be'])

// 패널이 보낸 입력은 유튜브 주소만 그대로 열고, 나머지는 유튜브 검색어로 바꾼다.
export function youtubeUrl(input) {
  const text = String(input ?? '').trim()
  if (!text) return 'https://www.youtube.com/'
  try {
    const url = new URL(/^[a-z]+:\/\//i.test(text) ? text : `https://${text}`)
    if ((url.protocol === 'https:' || url.protocol === 'http:') && YOUTUBE_HOSTS.has(url.hostname)) {
      url.protocol = 'https:'
      return url.href
    }
  } catch {}
  return `https://www.youtube.com/results?search_query=${encodeURIComponent(text)}`
}

// 유튜브 주소면 바로 열고, 아니면 패널에 검색 결과를 보여준다.
export const isYoutubeUrl = (input) => !youtubeUrl(input).startsWith('https://www.youtube.com/results?')

// 유튜브 주소에서 영상 id를 꺼낸다. 영상 주소가 아니면 null.
export function videoId(input) {
  if (!isYoutubeUrl(input)) return null
  const url = new URL(youtubeUrl(input))
  const id = url.hostname === 'youtu.be' ? url.pathname.slice(1) : (url.searchParams.get('v') ?? url.pathname.match(/^\/(?:shorts|embed|live)\/([^/]+)/)?.[1])
  return /^[\w-]{11}$/.test(id ?? '') ? id : null
}

const text = (node) => node?.simpleText ?? node?.runs?.map((run) => run.text).join('') ?? ''

function extractVideos(root) {
  const videos = []
  const walk = (value) => {
    if (!value || typeof value !== 'object') return
    const v = value.videoRenderer
    if (v?.videoId) {
      videos.push({
        id: v.videoId,
        title: text(v.title),
        channel: text(v.ownerText),
        length: text(v.lengthText) || (v.badges?.some((b) => b.metadataBadgeRenderer?.style?.includes('LIVE')) ? 'LIVE' : ''),
        views: text(v.shortViewCountText).replace(/^조회수\s+(.+?)회$/, '$1'),
        published: text(v.publishedTimeText)
      })
      return
    }
    for (const child of Object.values(value)) walk(child)
  }
  walk(root)
  return videos
}

function continuationToken(root) {
  let token = null
  const walk = (value) => {
    if (token || !value || typeof value !== 'object') return
    const found = value.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token
    if (found) {
      token = found
      return
    }
    for (const child of Object.values(value)) walk(child)
  }
  walk(root)
  return token
}

function parseSearchPage(html) {
  const match = html.match(/var ytInitialData = (\{.*?\});<\/script>/s)
  // 회사 보안망 등은 유튜브 대신 짧은 차단 페이지를 돌려준다.
  if (!match) throw new Error('유튜브 검색 결과를 읽지 못했습니다. 네트워크(회사 보안 등)에서 차단되었을 수 있습니다.')
  const data = JSON.parse(match[1])
  return {
    videos: extractVideos(data),
    continuation: continuationToken(data),
    apiKey: html.match(/"INNERTUBE_API_KEY":"([^"]+)"/)?.[1] ?? '',
    clientVersion: html.match(/"INNERTUBE_CLIENT_VERSION":"([^"]+)"/)?.[1] ?? '2.20260101.00.00'
  }
}

// 공식 API 키 없이 검색 페이지에 박힌 ytInitialData에서 영상만 뽑는다.
// ponytail: 유튜브가 페이지 구조를 바꾸면 깨진다. 그때는 videoRenderer 위치만 다시 찾으면 된다.
export const parseSearch = (html) => parseSearchPage(html).videos

const BROWSER_HEADERS = {
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
  'accept-language': 'ko-KR,ko;q=0.9'
}

// 기본 검색 결과 프리셋: 주제별 오늘의 인기 영상 30개.
export const POPULAR_AI_QUERY = 'AI 에이전트 OR 클로드 OR 제미나이 OR GPT OR LLM'
export const POPULAR_TODAY_SP = 'CAMSBAgCEAE%3D'
export const POPULAR_MUSIC_PLAYLIST = 'PL4fGSI1pDJn6Q7vxp4-2ETPMtSuAPuZ8Y' // YouTube 공식 '일간 인기 뮤직비디오 - 한국'
export const POPULAR_LIMIT = 30
export const POPULAR_PRESETS = {
  ai: { query: POPULAR_AI_QUERY, sp: POPULAR_TODAY_SP },
  music: { playlist: POPULAR_MUSIC_PLAYLIST },
  dev: { query: '개발자 OR 프로그래밍 OR 코딩 OR GitHub', sp: POPULAR_TODAY_SP },
  news: { query: '뉴스 OR 경제 OR 시사', sp: POPULAR_TODAY_SP }
}

// YouTube 재생목록 및 watch 관련 영상(lockupViewModel)에서 영상 목록을 뽑는다.
export function parsePlaylist(html, { excludeId = '' } = {}) {
  const match = html.match(/var ytInitialData = (\{.*?\});<\/script>/s)
  if (!match) throw new Error('유튜브 영상 목록을 읽지 못했습니다. 네트워크(회사 보안 등)에서 차단되었을 수 있습니다.')
  const videos = []
  const seen = new Set(excludeId ? [excludeId] : [])
  const walk = (value) => {
    if (!value || typeof value !== 'object') return
    const m = value.lockupViewModel
    if (m?.contentId && /^[\w-]{11}$/.test(m.contentId) && !seen.has(m.contentId)) {
      seen.add(m.contentId)
      const rows = m.metadata?.lockupMetadataViewModel?.metadata?.contentMetadataViewModel?.metadataRows ?? []
      const badges = m.contentImage?.thumbnailViewModel?.overlays?.flatMap((o) => o.thumbnailBottomOverlayViewModel?.badges ?? []) ?? []
      const length = badges.map((b) => b.thumbnailBadgeViewModel?.text).find(Boolean) ?? ''
      videos.push({
        id: m.contentId,
        title: m.metadata?.lockupMetadataViewModel?.title?.content ?? '',
        channel: rows[0]?.metadataParts?.[0]?.text?.content ?? '',
        length,
        views: (rows[1]?.metadataParts?.[0]?.text?.content ?? '').replace(/^조회수\s+(.+?)회$/, '$1'),
        published: rows[1]?.metadataParts?.[1]?.text?.content ?? ''
      })
      return
    }
    const c = value.compactVideoRenderer
    if (c?.videoId && !seen.has(c.videoId)) {
      seen.add(c.videoId)
      videos.push({
        id: c.videoId,
        title: text(c.title),
        channel: text(c.longBylineText) || text(c.shortBylineText),
        length: text(c.lengthText),
        views: text(c.shortViewCountText).replace(/^조회수\s+(.+?)회$/, '$1'),
        published: text(c.publishedTimeText)
      })
      return
    }
    for (const child of Object.values(value)) walk(child)
  }
  walk(JSON.parse(match[1]))
  return videos
}

export async function relatedYoutube(id, { limit = 10, fetchImpl = fetch } = {}) {
  if (!/^[\w-]{11}$/.test(id ?? '')) throw new Error('잘못된 영상 id입니다.')
  const url = `https://www.youtube.com/watch?v=${id}&hl=ko&gl=KR`
  const res = await fetchImpl(url, { headers: BROWSER_HEADERS, signal: AbortSignal.timeout(15000) }).catch((error) => {
    throw new Error(`유튜브에 연결하지 못했습니다 (${error.cause?.code ?? error.cause?.message ?? error.message})`)
  })
  if (!res.ok) throw new Error(`유튜브 응답 ${res.status}`)
  const videos = parsePlaylist(await res.text(), { excludeId: id }).slice(0, limit)
  await Promise.all(videos.map(async (video) => (video.thumb = await thumbnail(video.id, fetchImpl))))
  return videos
}

// 패널은 외부 이미지를 못 불러서 썸네일을 data URL로 넘긴다. 실패한 썸네일은 비워 둔다.
async function thumbnail(id, fetchImpl = fetch) {
  try {
    const res = await fetchImpl(`https://i.ytimg.com/vi/${id}/mqdefault.jpg`, { signal: AbortSignal.timeout(8000) })
    if (!res.ok) return ''
    return `data:image/jpeg;base64,${Buffer.from(await res.arrayBuffer()).toString('base64')}`
  } catch {
    return ''
  }
}

export async function searchYoutube(query, { sp = '', limit = 0, fetchImpl = fetch } = {}) {
  const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}${sp ? `&sp=${sp}` : ''}&hl=ko&gl=KR`
  const res = await fetchImpl(url, { headers: BROWSER_HEADERS, signal: AbortSignal.timeout(15000) }).catch((error) => {
    throw new Error(`유튜브에 연결하지 못했습니다 (${error.cause?.code ?? error.cause?.message ?? error.message})`)
  })
  if (!res.ok) throw new Error(`유튜브 응답 ${res.status}`)
  const page = parseSearchPage(await res.text())
  const seen = new Set()
  const videos = []
  const append = (items) => {
    for (const item of items) {
      if (seen.has(item.id)) continue
      seen.add(item.id)
      videos.push(item)
    }
  }
  append(page.videos)
  // 첫 검색 페이지는 보통 20개만 오므로, limit(예: 30개)을 채우기 위해 다음 페이지를 이어서 받는다.
  let token = page.continuation
  for (let i = 0; limit > 0 && videos.length < limit && token && page.apiKey && i < 3; i++) {
    try {
      const more = await fetchImpl(`https://www.youtube.com/youtubei/v1/search?key=${page.apiKey}`, {
        method: 'POST',
        headers: { ...BROWSER_HEADERS, 'content-type': 'application/json' },
        body: JSON.stringify({
          context: { client: { hl: 'ko', gl: 'KR', clientName: 'WEB', clientVersion: page.clientVersion } },
          continuation: token
        }),
        signal: AbortSignal.timeout(15000)
      })
      if (!more.ok) break
      const data = await more.json()
      append(extractVideos(data))
      token = continuationToken(data)
    } catch {
      break
    }
  }
  const result = limit > 0 ? videos.slice(0, limit) : videos
  await Promise.all(result.map(async (video) => (video.thumb = await thumbnail(video.id, fetchImpl))))
  return result
}

export async function popularYoutube({ topic = 'ai', limit = POPULAR_LIMIT, fetchImpl = fetch } = {}) {
  const preset = POPULAR_PRESETS[topic] ?? POPULAR_PRESETS.ai
  if (preset.playlist) {
    const url = `https://www.youtube.com/playlist?list=${preset.playlist}&hl=ko&gl=KR`
    const res = await fetchImpl(url, { headers: BROWSER_HEADERS, signal: AbortSignal.timeout(15000) }).catch((error) => {
      throw new Error(`유튜브에 연결하지 못했습니다 (${error.cause?.code ?? error.cause?.message ?? error.message})`)
    })
    if (!res.ok) throw new Error(`유튜브 응답 ${res.status}`)
    const videos = parsePlaylist(await res.text()).slice(0, limit)
    await Promise.all(videos.map(async (video) => (video.thumb = await thumbnail(video.id, fetchImpl))))
    return videos
  }
  return searchYoutube(preset.query, { sp: preset.sp, limit, fetchImpl })
}

// --- 패널 안 재생: 패널은 외부 미디어를 못 틀어서(CSP media-src 'self' blob:) yt-dlp로 받은 파일을 조각내 넘긴다.
// ponytail: Windows 전용(yt-dlp.exe). 다른 OS가 필요하면 바이너리 이름과 설치 URL만 나누면 된다.

const LOCAL_APP_DATA = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local')
const OWN_YTDLP = join(LOCAL_APP_DATA, 'orca-music-player', 'yt-dlp.exe')
const YTDLP_URL = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe'
const VIDEO_DIR = join(tmpdir(), 'orca-music-player')
export const CHUNK_BYTES = 750 * 1024 // 응답 한도 1 MiB, base64로 4/3배(약 1000KB)가 된다. 클수록 요청 수가 준다. 패널의 MUSIC_CHUNK와 같아야 한다.

// winget은 PATH를 바꾸지만 Orca를 다시 켜기 전엔 worker에 반영되지 않아 설치 폴더도 직접 본다.
export function findYtDlp({ env = process.env, exists = existsSync, list = readdirSync } = {}) {
  const candidates = [OWN_YTDLP]
  for (const dir of (env.PATH ?? env.Path ?? '').split(';')) if (dir) candidates.push(join(dir, 'yt-dlp.exe'))
  const packages = join(LOCAL_APP_DATA, 'Microsoft', 'WinGet', 'Packages')
  try {
    for (const name of list(packages)) if (name.startsWith('yt-dlp.yt-dlp')) candidates.push(join(packages, name, 'yt-dlp.exe'))
  } catch {}
  return candidates.find((path) => exists(path)) ?? null
}

// yt-dlp와 같은 방식으로 PATH, 없으면 winget 설치 폴더에서 ffmpeg.exe를 찾는다.
export function findFfmpeg({ env = process.env, exists = existsSync, list = readdirSync } = {}) {
  const candidates = (env.PATH ?? env.Path ?? '').split(';').filter(Boolean).map((dir) => join(dir, 'ffmpeg.exe'))
  const packages = join(LOCAL_APP_DATA, 'Microsoft', 'WinGet', 'Packages')
  try {
    for (const name of list(packages)) {
      if (!/ffmpeg/i.test(name)) continue
      for (const sub of list(join(packages, name))) candidates.push(join(packages, name, sub, 'bin', 'ffmpeg.exe'))
    }
  } catch {}
  return candidates.find((path) => exists(path)) ?? null
}

async function installYtDlp() {
  const res = await fetch(YTDLP_URL, { signal: AbortSignal.timeout(120000) })
  if (!res.ok) throw new Error(`yt-dlp 다운로드 실패 (${res.status})`)
  await mkdir(dirname(OWN_YTDLP), { recursive: true })
  await writeFile(OWN_YTDLP, Buffer.from(await res.arrayBuffer()))
  return OWN_YTDLP
}

// yt-dlp 오류를 사람이 읽을 말로. 회사 보안망은 유튜브 대신 차단 페이지를 돌려줘서 이 오류가 난다.
export function ytDlpError(stderr) {
  const last = stderr.trim().split(/\r?\n/).filter((line) => line.startsWith('ERROR')).pop() ?? stderr.trim().split(/\r?\n/).pop() ?? ''
  if (/Failed to extract any player response|Unable to download API page|Failed to parse JSON/.test(stderr)) {
    return '유튜브 영상 정보를 받지 못했습니다. 네트워크(회사 보안 등)에서 차단되었거나 yt-dlp 업데이트가 필요합니다.'
  }
  if (/Sign in to confirm|age/i.test(last)) return '로그인이 필요한 영상이라 받을 수 없습니다.'
  return last.replace(/^ERROR:\s*/, '') || 'yt-dlp가 실패했습니다.'
}

// signal로 중단하면 spawn이 yt-dlp를 죽이고 AbortError로 끝난다.
function downloadVideo(ytdlp, id, file, onProgress, signal, { audioOnly = false } = {}) {
  const args = [
    // 회사 SSL 검사 인증서처럼 Windows에만 등록된 루트 인증서도 믿도록 OS 인증서 저장소를 쓴다.
    '--compat-options', 'no-certifi'
  ]
  if (audioOnly) {
    // 오디오 전용 모드는 m4a 단일 스트림만 받아 ffmpeg 병합 없이 빠르고 가볍게 재생한다.
    args.push('-f', 'ba[ext=m4a]/ba')
  } else {
    const ffmpeg = findFfmpeg()
    if (!ffmpeg) return Promise.reject(new Error('ffmpeg가 필요합니다. 터미널에서 `winget install Gyan.FFmpeg` 실행 후 Orca를 다시 켜 주세요.'))
    // 유튜브가 영상+소리 한 파일 포맷(18)을 없애서 영상(avc1)+소리(m4a)를 ffmpeg로 합친다.
    args.push('-f', 'bv*[ext=mp4][vcodec^=avc1][height<=480]+ba[ext=m4a]/b[ext=mp4]', '--merge-output-format', 'mp4', '--ffmpeg-location', ffmpeg)
  }
  args.push('--no-playlist', '--newline', '--force-overwrites', '-o', file, `https://www.youtube.com/watch?v=${id}`)
  return new Promise((resolve, reject) => {
    const child = spawn(ytdlp, args, { windowsHide: true, signal })
    let stderr = ''
    child.stdout.on('data', (data) => {
      const match = String(data).match(/\[download\]\s+([\d.]+)%/g)?.pop()
      if (match) onProgress(Number(match.match(/([\d.]+)%/)[1]))
    })
    child.stderr.on('data', (data) => (stderr += data))
    child.on('error', reject)
    child.on('close', (code) => (code === 0 ? resolve(file) : reject(new Error(ytDlpError(stderr)))))
  })
}

// 한 번에 한 영상만 받아 두고, 새 영상을 받을 때 이전 파일을 지운다.
// 패널 요청은 최대 2분이라 다운로드는 뒤에서 돌리고, 끝나지 않았으면 pending을 돌려 패널이 다시 묻게 한다.
// 새 영상을 고르면 이전 다운로드는 중단하고, 작업마다 다른 파일에 받아 A→B→A에서도 같은 파일에 겹쳐 쓰지 않는다.
export function videoFetcher({ dir, find, download, post, wait = 90000, keepFile = false }) {
  let current = null // { id, key, file, size, audioOnly }
  let job = null // { id, key, abort, promise } — 완료 판정은 id가 아니라 이 객체로 한다.
  let seq = 0
  // 영상 파일과, 영상+소리를 합치다 실패해 남는 조각(<이름>.f137.mp4, .part, .ytdl, .temp.mp4 등)을 함께 지운다.
  const discard = async (file) => {
    const prefix = basename(file, extname(file)) + '.'
    const names = await readdir(dirname(file)).catch(() => [])
    await Promise.all([file, ...names.filter((n) => n.startsWith(prefix)).map((n) => join(dirname(file), n))].map((f) => rm(f, { force: true }).catch(() => {})))
  }

  async function fetchVideo(id, { audioOnly = false } = {}) {
    if (!/^[\w-]{11}$/.test(id ?? '')) return { error: '잘못된 영상 id입니다.' }
    const key = `${id}:${audioOnly ? 'audio' : 'video'}`
    const reply = (item) => (item.audioOnly ? { size: item.size, mime: 'audio/mp4' } : { size: item.size })
    if (current?.key === key) return reply(current)
    if (job?.key !== key) {
      const ytdlp = find()
      if (!ytdlp) return { needsYtDlp: true }
      job?.abort.abort()
      const me = { id, key, abort: new AbortController() }
      const file = join(dir, `${id}-${++seq}.${audioOnly ? 'm4a' : 'mp4'}`)
      const old = current
      current = null
      let last = -1
      me.promise = (async () => {
        if (old) await discard(old.file)
        await mkdir(dir, { recursive: true })
        try {
          await download(ytdlp, id, file, (percent) => {
            if (Math.floor(percent) === last) return
            last = Math.floor(percent)
            post('youtube.progress', { id, percent: last })
          }, me.abort.signal, { audioOnly })
        } catch (error) {
          await discard(file)
          throw error
        }
        // 그사이 다른 영상(같은 id의 새 작업 포함)을 눌렀으면 이 파일은 버린다.
        if (job !== me) return void (await discard(file))
        current = { id, key, file, size: (await stat(file)).size, audioOnly }
      })()
      job = me
      me.promise.catch(() => {}).finally(() => job === me && (job = null))
    }
    const me = job
    try {
      const done = await Promise.race([me.promise.then(() => true), new Promise((resolve) => setTimeout(resolve, wait, false))])
      // 밀려난 작업을 기다리던 요청은 pending으로 돌려 최신 작업을 다시 기다리게 한다.
      return done && current?.key === key ? reply(current) : { pending: true }
    } catch (error) {
      return me.abort.signal.aborted ? { pending: true } : { error: error.message }
    }
  }

  async function chunk(id, offset = 0) {
    if (current?.id !== id) return { error: '받아 둔 영상이 바뀌었습니다.' }
    const handle = await openFile(current.file, 'r')
    try {
      const buffer = Buffer.alloc(Math.min(CHUNK_BYTES, current.size - offset))
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset)
      const data = buffer.subarray(0, bytesRead).toString('base64')
      // 마지막 조각까지 패널에 넘겼으면 keepFile이 아닐 때 임시 파일을 지운다.
      // keepFile이면 다른 플러그인으로 이동했을 때 백그라운드 이어 재생에 재사용하고, 새 영상/reset 때 지운다.
      const last = offset + bytesRead >= current.size
      await handle.close()
      if (last && !keepFile) {
        const { file } = current
        current = null
        await discard(file)
      }
      return { data }
    } finally {
      await handle.close().catch(() => {})
    }
  }

  // 받던 다운로드를 멈추고 받아 둔 영상 파일도 지운다.
  async function reset() {
    job?.abort.abort()
    job = null
    const old = current
    current = null
    if (old) await discard(old.file)
  }

  const fileFor = (id) => (current?.id === id ? current.file : null)

  return { fetch: fetchVideo, chunk, reset, fileFor }
}

// --- 음악 폴더 고르기: 패널(브라우저)의 폴더 선택 창 대신 윈도 기본 폴더 트리 창을 띄운다.
// 패널은 디스크를 못 읽어서 곡 목록만 넘기고, 곡 내용은 재생할 때 조각으로 읽어 간다.

const MUSIC_FILE = /\.(mp3|flac|m4a|mp4|aac|ogg|oga|opus|wav|webm|lrc)$/i
const library = [] // 패널이 읽을 수 있는 파일 목록. 목록에 있는 번호로만 읽게 해서 임의 경로 읽기를 막는다.

const PICK_FOLDER = `Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices; using System.Text; using System.Threading;
public class OrcaPick {
  public delegate int Callback(IntPtr hwnd, uint msg, IntPtr lParam, IntPtr lpData);
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Auto)]
  public struct BROWSEINFO { public IntPtr hwndOwner; public IntPtr pidlRoot; public IntPtr pszDisplayName; public string lpszTitle; public uint ulFlags; public Callback lpfn; public IntPtr lParam; public int iImage; }
  [DllImport("shell32.dll", CharSet = CharSet.Auto)] static extern IntPtr SHBrowseForFolder(ref BROWSEINFO bi);
  [DllImport("shell32.dll", CharSet = CharSet.Auto)] static extern bool SHGetPathFromIDList(IntPtr pidl, StringBuilder path);
  [DllImport("ole32.dll")] static extern void CoTaskMemFree(IntPtr p);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr SendMessage(IntPtr h, uint m, IntPtr w, string l);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr SendMessage(IntPtr h, uint m, IntPtr w, StringBuilder l);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr FindWindowEx(IntPtr p, IntPtr a, string cls, string title);
  static volatile bool done;
  static readonly Callback cb = Watch;
  // 입력칸에 \\서버 같은 네트워크 경로를 치고 잠시 멈추면 트리가 그 위치로 이동한다. 그 아래 공유 폴더는 트리를 펼쳐 고른다.
  static int Watch(IntPtr hwnd, uint msg, IntPtr lParam, IntPtr data) {
    if (msg != 1) return 0; // BFFM_INITIALIZED
    new Thread(() => {
      IntPtr edit = FindWindowEx(hwnd, IntPtr.Zero, "Edit", null);
      string last = "", handled = "";
      while (!done && edit != IntPtr.Zero) {
        Thread.Sleep(300);
        var sb = new StringBuilder(1040);
        SendMessage(edit, 0xD, (IntPtr)1040, sb); // WM_GETTEXT
        string text = sb.ToString().Trim();
        if (text == last && text != handled && text.StartsWith(@"\\\\")) {
          handled = text;
          SendMessage(hwnd, 0x467, (IntPtr)1, text); // BFFM_SETSELECTIONW
        }
        last = text;
      }
    }) { IsBackground = true }.Start();
    return 0;
  }
  public static string Show(IntPtr owner, string title) {
    IntPtr name = Marshal.AllocHGlobal(1040);
    done = false;
    // 0x1 폴더만, 0x10 경로 입력칸, 0x40 새 대화상자 스타일
    var bi = new BROWSEINFO { hwndOwner = owner, pszDisplayName = name, lpszTitle = title, ulFlags = 0x1 | 0x10 | 0x40, lpfn = cb };
    IntPtr pidl = SHBrowseForFolder(ref bi);
    done = true;
    Marshal.FreeHGlobal(name);
    if (pidl == IntPtr.Zero) return null;
    var sb = new StringBuilder(1040);
    string path = SHGetPathFromIDList(pidl, sb) ? sb.ToString() : null;
    CoTaskMemFree(pidl);
    return path;
  }
}
'@
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$o = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true; ShowInTaskbar = $false; Opacity = 0 }
$o.Show()
$path = [OrcaPick]::Show($o.Handle, '음악 폴더를 선택하세요. 아래 칸에 \\\\서버 같은 네트워크 경로를 입력해도 됩니다.')
$o.Close()
if ($path) { $path }`

// C# 컴파일이 막힌 PC(보안 정책 등)용. 경로 입력칸은 없지만 같은 폴더 트리 창이다.
const PICK_FOLDER_PLAIN = `Add-Type -AssemblyName System.Windows.Forms
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$d = New-Object System.Windows.Forms.FolderBrowserDialog
$d.Description = '음악 폴더를 선택하세요'
$o = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true }
if ($d.ShowDialog($o) -eq 'OK') { $d.SelectedPath }`

const runPowerShell = (script) =>
  new Promise((resolve, reject) =>
    execFile('powershell.exe', ['-NoProfile', '-STA', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true }, (error, stdout) =>
      error ? reject(error) : resolve(stdout.trim() || null)
    )
  )

// 취소하면 null. Windows PowerShell 5.1이 필요하다. 입력칸 있는 창이 실패하면 입력칸 없는 창으로 다시 시도한다.
export const pickFolder = (run = runPowerShell) => run(PICK_FOLDER).catch(() => run(PICK_FOLDER_PLAIN))

// 폴더 안의 음악/.lrc 파일. path는 패널 목록에 보일 "폴더이름/하위경로"다.
// 권한이 없는 폴더(System Volume Information 등)는 건너뛴다. 하나 실패한다고 전체를 버리지 않는다.
export function listMusic(root, files = library) {
  const out = []
  const walk = (dir, rel) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      const path = `${rel}/${entry.name}`
      if (entry.isDirectory()) walk(full, path)
      else if (MUSIC_FILE.test(entry.name)) {
        try {
          out.push({ id: files.push(full) - 1, path, size: statSync(full).size })
        } catch {}
      }
    }
  }
  walk(root, basename(root) || root.replace(/[:\/]+$/, ''))
  return out
}

export async function readMusic(id, offset = 0, files = library) {
  const file = files[id]
  if (!file) return { error: '목록에 없는 파일입니다.' }
  const handle = await openFile(file, 'r')
  try {
    const { size } = await handle.stat()
    const buffer = Buffer.alloc(Math.max(0, Math.min(CHUNK_BYTES, size - offset)))
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset)
    return { data: buffer.subarray(0, bytesRead).toString('base64') }
  } finally {
    await handle.close()
  }
}

// 창이 열려 있는 동안 패널 요청(최대 2분)이 끝나지 않게, 오래 걸리면 pending을 돌려 다시 묻게 한다.
let pick = null
async function pickMusic(wait = 90000) {
  if (!pick) {
    const me = (pick = { result: null })
    me.promise = pickFolder().then(
      (root) => (me.result = root ? { root, files: listMusic(root) } : { cancelled: true }),
      (error) => (me.result = { error: error.message })
    )
  }
  const me = pick
  await Promise.race([me.promise, new Promise((resolve) => setTimeout(resolve, wait))])
  if (!me.result) return { pending: true }
  pick = null
  return me.result
}

// 저장해 둔 마지막 음악 폴더를 다시 연다. 폴더가 없어졌으면 missing을 돌려준다.
export function loadMusicFolder(path, files = library) {
  const root = String(path ?? '').trim()
  try {
    if (!root || !existsSync(root) || !statSync(root).isDirectory()) return { missing: true }
    return { root, files: listMusic(root, files) }
  } catch {
    return { missing: true }
  }
}

// worker는 Orca.exe로 실행되므로 그 옆의 번들 CLI를 먼저 쓴다.
export function orcaCli(execPath = process.execPath, exists = existsSync) {
  const bundled = join(dirname(execPath), 'resources', 'bin', 'orca.exe')
  return exists(bundled) ? bundled : 'orca'
}

// CLI는 --json 실패 이유를 stdout으로 보낸다.
export function cliResult(error, stdout) {
  let reply = null
  try {
    reply = JSON.parse(stdout)
  } catch {
    if (!error) throw new Error('orca CLI가 JSON이 아닌 응답을 보냈습니다.')
  }
  if (reply?.ok) return reply.result
  const failure = new Error(reply?.error?.message ?? error?.message ?? 'orca CLI가 실패했습니다.')
  failure.code = reply?.error?.code
  throw failure
}

const orca = (args) =>
  new Promise((resolve, reject) => {
    execFile(
      orcaCli(),
      [...args, '--json'],
      {
        // 워커 환경에는 APPDATA가 없어서 CLI가 Orca 런타임을 찾지 못한다.
        env: { ...process.env, APPDATA: process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming') },
        timeout: 20000,
        windowsHide: true
      },
      (error, stdout) => {
        try {
          resolve(cliResult(error, stdout))
        } catch (failure) {
          reject(failure)
        }
      }
    )
  })

// --- 백그라운드 이어 재생: 상단의 다른 플러그인으로 이동해 패널이 닫혀도 worker에서 오디오를 이어 재생한다.
const BG_PLAYER_CS = `
using System;
using System.Globalization;
using System.Threading;
using System.Windows.Media;
using System.Windows.Threading;
public class OrcaBgPlayer {
  public static void Run() {
    var disp = Dispatcher.CurrentDispatcher;
    var mp = new MediaPlayer();
    double pendingSec = 0;
    double pendingRate = 1;
    bool autoplay = true;
    bool opened = false;
    mp.MediaOpened += (s, e) => {
      opened = true;
      if (autoplay) {
        if (pendingSec > 0) mp.Position = TimeSpan.FromSeconds(pendingSec);
        mp.SpeedRatio = pendingRate;
        mp.Play();
      }
      Console.Out.WriteLine("OPENED");
      Console.Out.Flush();
    };
    mp.MediaEnded += (s, e) => {
      Console.Out.WriteLine("ENDED");
      Console.Out.Flush();
    };
    mp.MediaFailed += (s, e) => {
      Console.Out.WriteLine("ERR " + (e.ErrorException != null ? e.ErrorException.Message : "failed"));
      Console.Out.Flush();
    };
    new Thread(() => {
      string line;
      while ((line = Console.In.ReadLine()) != null) {
        var cmd = line;
        disp.Invoke(() => {
          var parts = cmd.Split('\\t');
          if (parts[0] == "PLAY" && parts.Length >= 5) {
            mp.Stop();
            autoplay = true;
            opened = false;
            pendingSec = double.Parse(parts[2], CultureInfo.InvariantCulture);
            mp.Volume = double.Parse(parts[3], CultureInfo.InvariantCulture);
            pendingRate = double.Parse(parts[4], CultureInfo.InvariantCulture);
            mp.Open(new Uri(parts[1]));
          } else if (parts[0] == "LOAD" && parts.Length >= 2) {
            // 소리 없이 파일만 열어 둔다. GO가 오면 바로 재생한다.
            mp.Stop();
            autoplay = false;
            opened = false;
            mp.Volume = 0;
            mp.Open(new Uri(parts[1]));
          } else if (parts[0] == "GO" && parts.Length >= 4) {
            pendingSec = double.Parse(parts[1], CultureInfo.InvariantCulture);
            mp.Volume = double.Parse(parts[2], CultureInfo.InvariantCulture);
            pendingRate = double.Parse(parts[3], CultureInfo.InvariantCulture);
            autoplay = true;
            if (opened) {
              mp.Position = TimeSpan.FromSeconds(pendingSec);
              mp.SpeedRatio = pendingRate;
              mp.Play();
            }
          } else if (parts[0] == "STOP") {
            opened = false;
            double pos = mp.Source != null ? mp.Position.TotalSeconds : 0;
            mp.Stop();
            mp.Close();
            Console.Out.WriteLine("STOPPED " + pos.ToString(CultureInfo.InvariantCulture));
            Console.Out.Flush();
          } else if (parts[0] == "EXIT") {
            mp.Close();
            disp.BeginInvokeShutdown(DispatcherPriority.Normal);
          }
        });
      }
      disp.BeginInvokeShutdown(DispatcherPriority.Normal);
    }) { IsBackground = true }.Start();
    Console.Out.WriteLine("READY");
    Console.Out.Flush();
    Dispatcher.Run();
  }
}
`
const BG_PLAYER_SCRIPT = `Add-Type -ReferencedAssemblies PresentationCore, WindowsBase -TypeDefinition "${BG_PLAYER_CS.replace(/"/g, '""')}"\n[Console]::InputEncoding = [Text.Encoding]::UTF8\n[Console]::OutputEncoding = [Text.Encoding]::UTF8\n[OrcaBgPlayer]::Run()`

export function createBgPlayer(log = () => {}) {
  let child = null
  let ready = null
  let stopWaiter = null
  let endedHandler = null
  let loadedFile = null // 소리 없이 열어 둔 파일(preload)
  let gen = 0 // stop()마다 올려서, 아직 시작 중이던 play()가 stop 뒤에 되살아나지 않게 한다.

  function ensure() {
    if (child && !child.killed && child.exitCode === null) return ready
    ready = new Promise((resolve, reject) => {
      log('[bg] spawning powershell')
      const proc = spawn(
        'powershell.exe',
        ['-NoProfile', '-STA', '-EncodedCommand', Buffer.from(BG_PLAYER_SCRIPT, 'utf16le').toString('base64')],
        { windowsHide: true }
      )
      child = proc
      let buf = ''
      let settled = false
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true
          reject(new Error('bg player timeout'))
        }
      }, 10000)
      proc.stdout.on('data', (chunk) => {
        buf += String(chunk)
        for (let nl = buf.indexOf('\n'); nl >= 0; nl = buf.indexOf('\n')) {
          const line = buf.slice(0, nl).trim()
          buf = buf.slice(nl + 1)
          log(`[bg] ps: ${line}`)
          if (line === 'READY' && !settled) {
            settled = true
            clearTimeout(timer)
            resolve(proc)
          } else if (line.startsWith('STOPPED ') && stopWaiter) {
            const w = stopWaiter
            stopWaiter = null
            w(Number(line.slice(8)) || 0)
          } else if (line === 'ENDED') {
            loadedFile = null
            endedHandler?.()
          }
        }
      })
      proc.on('error', (err) => {
        log(`[bg] ps error: ${err.message}`)
        if (!settled) {
          settled = true
          clearTimeout(timer)
          reject(err)
        }
      })
      proc.on('close', (code) => {
        log(`[bg] ps close: ${code}`)
        if (child === proc) {
          child = null
          loadedFile = null
        }
        if (stopWaiter) {
          const w = stopWaiter
          stopWaiter = null
          w(0)
        }
      })
    })
    ready.catch(() => {})
    return ready
  }

  return {
    warmup() {
      ensure().catch(() => {})
    },
    async play(filePath, { time = 0, volume = 0.8, rate = 1 } = {}) {
      const g = gen
      const proc = await ensure()
      if (g !== gen) return
      const cleanPath = String(filePath).replace(/[\t\r\n]/g, '')
      const vol = Math.min(1, Math.max(0, Number(volume) || 0))
      const spd = Math.max(0.25, Number(rate) || 1)
      if (loadedFile === cleanPath) {
        loadedFile = null // 이미 열려 있으니 위치·음량만 지정해 바로 재생
        proc.stdin.write(`GO\t${Math.max(0, Number(time) || 0)}\t${vol}\t${spd}\n`)
        return
      }
      loadedFile = null
      proc.stdin.write(`PLAY\t${cleanPath}\t${Math.max(0, Number(time) || 0)}\t${Math.min(1, Math.max(0, Number(volume) || 0))}\t${Math.max(0.25, Number(rate) || 1)}\n`)
    },
    // 곧 이어 재생할 파일을 소리 없이 미리 열어 둔다. 전환 때 시작 지연을 줄인다.
    async preload(filePath) {
      const clean = String(filePath).replace(/[\t\r\n]/g, '')
      if (loadedFile === clean) return
      const g = gen
      const proc = await ensure()
      if (g !== gen || loadedFile === clean) return
      loadedFile = clean
      proc.stdin.write(`LOAD\t${clean}\n`)
    },
    async stop() {
      gen++
      loadedFile = null
      if (!child || child.killed || child.exitCode !== null) return 0
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          if (stopWaiter === done) stopWaiter = null
          resolve(0)
        }, 2000)
        const done = (pos) => {
          clearTimeout(timer)
          resolve(pos)
        }
        stopWaiter = done
        try {
          child.stdin.write('STOP\n')
        } catch {
          done(0)
        }
      })
    },
    onEnded(fn) {
      endedHandler = fn
    },
    dispose() {
      if (!child) return
      try {
        child.stdin.write('EXIT\n')
      } catch {}
      const proc = child
      child = null
      loadedFile = null
      setTimeout(() => {
        try {
          if (proc.exitCode === null) proc.kill()
        } catch {}
      }, 500)
    }
  }
}

// 패널이 닫히거나(pagehide -> handoff) 재생 중 하트비트가 끊기면 worker가 백그라운드 재생을 이어받고, 다시 열리면(takeover) 패널로 되돌린다.
export function playbackCoordinator({ player, resolveFile, nextItem, now = Date.now, staleMs = 1200, log = () => {} }) {
  let lastState = null // 패널이 마지막으로 보고한 상태
  let bgState = null // 현재 백그라운드에서 재생 중인 상태
  let handoffSeq = 0
  let staleTimer = null
  let preloadKey = null // 이미 미리 열었거나 여는 중인 곡

  // 재생 중인 파일을 worker 플레이어에 소리 없이 미리 열어 두면 전환 때 바로 이어진다.
  function preload(state) {
    if (bgState || !player.preload) return
    const key = `${state.kind}:${state.kind === 'music' ? state.trackId : state.video?.id}`
    if (key === preloadKey) return
    preloadKey = key
    Promise.resolve(resolveFile(state, { preload: true }))
      .then((file) => {
        if (!file) preloadKey = null // 아직 받는 중일 수 있어 다음 하트비트에 다시 본다.
        else if (preloadKey === key && !bgState) return player.preload(file)
      })
      .catch(() => (preloadKey = null))
  }

  const clearStale = () => {
    if (staleTimer) {
      clearTimeout(staleTimer)
      staleTimer = null
    }
  }

  async function startBg(state, time) {
    clearStale()
    const seq = ++handoffSeq
    const t0 = now()
    const file = await Promise.resolve(resolveFile(state)).catch(() => null)
    if (seq !== handoffSeq) return
    if (!file) return log(`[bg] 이어 재생할 파일을 찾지 못했습니다 kind=${state.kind}`)
    time += Math.max(0, (now() - t0) / 1000) * (state.rate || 1) // 파일을 다시 받느라 걸린 시간만큼 보정
    log(`[bg] start kind=${state.kind} time=${time.toFixed(1)}`)
    bgState = { ...state, time, startedAt: now() }
    try {
      await player.play(file, { time, volume: state.muted ? 0 : state.volume, rate: state.rate || 1 })
      if (seq !== handoffSeq) return
    } catch (error) {
      log(`[bg] play 실패: ${error.message}`)
      if (seq === handoffSeq) bgState = null
    }
  }

  player.onEnded(async () => {
    const ended = bgState
    if (!ended) return
    const seq = handoffSeq
    const next = await nextItem?.(ended).catch(() => null)
    if (seq !== handoffSeq || !bgState) return
    if (!next) {
      bgState = null
      return
    }
    lastState = { ...next, playing: true, time: 0, updatedAt: now() }
    await startBg(lastState, 0)
  })

  return {
    updateState(state) {
      clearStale()
      // 패널이 살아 있다는 뜻이다. 끊김을 잘못 판단해 이어받았다면 겹치지 않게 백그라운드는 멈춘다(방금 시작한 경우는 이전 하트비트일 수 있어 둔다).
      if (bgState && now() - bgState.startedAt > 1500) {
        log('[bg] 패널 하트비트 재개 → 백그라운드 중지')
        bgState = null
        handoffSeq++
        player.stop()
      }
      if (!state || typeof state !== 'object' || !state.playing) {
        lastState = null
        return { ok: true }
      }
      lastState = { ...state, queue: state.queue ?? lastState?.queue, updatedAt: now() }
      player.warmup?.()
      preload(lastState)
      staleTimer = setTimeout(() => {
        staleTimer = null
        if (lastState?.playing && !bgState) {
          log('[bg] 하트비트 끊김 → 이어받기')
          const elapsed = Math.max(0, (now() - lastState.updatedAt) / 1000) * (lastState.rate || 1)
          startBg(lastState, (lastState.time || 0) + elapsed)
        }
      }, staleMs)
      return { ok: true }
    },
    handoff(state) {
      log(`[bg] handoff playing=${Boolean(state?.playing)} bg=${Boolean(bgState)}`)
      clearStale()
      const target = state?.playing ? { ...state, updatedAt: now() } : lastState
      if (!target?.playing || bgState) return { ok: true }
      lastState = target
      const elapsed = Math.max(0, (now() - target.updatedAt) / 1000) * (target.rate || 1)
      startBg(target, (target.time || 0) + elapsed)
      return { ok: true }
    },
    async takeover() {
      clearStale()
      preloadKey = null
      handoffSeq++
      if (!bgState) return { active: false }
      const state = bgState
      bgState = null
      const pos = await player.stop()
      const time = pos > 0 ? pos : (state.time || 0) + Math.max(0, (now() - state.startedAt) / 1000) * (state.rate || 1)
      lastState = { ...state, time, playing: true, updatedAt: now() }
      return { active: true, state: { ...state, time } }
    },
    async stop() {
      clearStale()
      preloadKey = null
      handoffSeq++
      lastState = null
      if (!bgState) return
      bgState = null
      await player.stop()
    },
    dispose() {
      clearStale()
      preloadKey = null
      handoffSeq++
      bgState = null
      lastState = null
      player.dispose?.()
    }
  }
}

let activeDispose = null
export function deactivate() {
  return activeDispose?.()
}

export default function activate(plugin) {
  // 처음엔 새 탭을 열고, 그 뒤로는 같은 탭을 이동시킨다. 사용자가 탭을 닫았으면 다시 연다.
  let pageId = null
  async function open(query) {
    const url = youtubeUrl(query)
    if (pageId) {
      try {
        await orca(['goto', '--page', pageId, '--url', url])
        return { url }
      } catch (error) {
        if (error.code !== 'browser_tab_not_found') return { error: error.message }
      }
    }
    try {
      pageId = (await orca(['tab', 'create', '--url', url])).browserPageId
      return { url }
    } catch (error) {
      return { error: error.message }
    }
  }
  plugin.panels.handle('youtube.open', ({ query } = {}) => open(query))
  plugin.panels.handle('youtube.popular', async ({ topic } = {}) => {
    try {
      return { videos: await popularYoutube({ topic }) }
    } catch (error) {
      return { error: error.message }
    }
  })
  plugin.panels.handle('youtube.related', async ({ id, limit = 10 } = {}) => {
    try {
      return { videos: await relatedYoutube(id, { limit }) }
    } catch (error) {
      return { error: error.message }
    }
  })
  // 유튜브 주소를 넣으면 검색하지 않고 바로 연다.
  plugin.panels.handle('youtube.search', async ({ query } = {}) => {
    const q = String(query ?? '').trim()
    if (!q) return { videos: [] }
    // 영상 주소면 검색 대신 그 영상을 재생하고, 채널 등 다른 유튜브 주소는 브라우저 탭으로 연다.
    const id = videoId(q)
    if (id) return { videoId: id }
    if (isYoutubeUrl(q)) return { opened: true, ...(await open(q)) }
    try {
      return { videos: await searchYoutube(q) }
    } catch (error) {
      return { error: error.message }
    }
  })

  plugin.panels.handle('music.pickFolder', () => pickMusic())
  plugin.panels.handle('music.loadFolder', ({ path } = {}) => loadMusicFolder(path))
  plugin.panels.handle('music.read', ({ id, offset } = {}) => readMusic(id, offset))

  plugin.panels.handle('youtube.status', () => ({ ytdlp: findYtDlp() }))
  plugin.panels.handle('youtube.install', async () => {
    try {
      return { ytdlp: await installYtDlp() }
    } catch (error) {
      return { error: error.message }
    }
  })

  const videos = videoFetcher({ dir: VIDEO_DIR, find: () => findYtDlp(), download: downloadVideo, post: (name, data) => plugin.panels.post(name, data), keepFile: true })
  const bg = playbackCoordinator({
    player: createBgPlayer((m) => plugin.log(m)),
    log: (m) => plugin.log(m),
    resolveFile: async (state, opts = {}) => {
      let f = state.kind === 'music' ? (library[state.trackId] ?? null) : state.kind === 'youtube' ? videos.fileFor(state.video?.id) : null
      if (opts.preload) return f // 미리 열기는 다운로드를 건드리지 않는다(패널이 받는 영상을 끊지 않도록).
      // worker가 재시작돼 받아 둔 영상을 잃었으면 오디오만 다시 받아 이어 재생한다.
      if (!f && state.kind === 'youtube' && state.video?.id) {
        let res
        do res = await videos.fetch(state.video.id, { audioOnly: true })
        while (res?.pending)
        f = res?.error || res?.needsYtDlp ? null : videos.fileFor(state.video.id)
      }
      plugin.log(`[bg] resolveFile kind=${state.kind} -> ${f}`)
      return f
    },
    nextItem: async (ended) => {
      if (ended.kind === 'music' && Array.isArray(ended.queue) && ended.queue.length) {
        const idx = ended.queue.findIndex((item) => item.id === ended.trackId)
        if (idx < 0) return null
        if (ended.repeat === 'one') return ended
        let nextIdx = -1
        if (ended.shuffle && ended.queue.length > 1) {
          nextIdx = idx
          while (nextIdx === idx) nextIdx = Math.floor(Math.random() * ended.queue.length)
        } else if (idx + 1 < ended.queue.length) {
          nextIdx = idx + 1
        } else if (ended.repeat === 'all') {
          nextIdx = 0
        }
        if (nextIdx < 0) return null
        const target = ended.queue[nextIdx]
        return { ...ended, trackId: target.id, path: target.path }
      }
      if (ended.kind === 'youtube' && ended.autoplay && ended.video?.id) {
        const queue = Array.isArray(ended.queue) ? ended.queue : []
        const played = new Set([...(ended.playedIds ?? []), ended.video.id])
        const idx = queue.findIndex((v) => v.id === ended.video.id)
        let next = idx >= 0 && idx + 1 < queue.length ? queue[idx + 1] : null
        let nextQueue = queue
        if (!next) {
          const related = await relatedYoutube(ended.video.id, { limit: 10 }).catch(() => [])
          next = related.find((v) => !played.has(v.id)) ?? related[0] ?? null
          if (next && !nextQueue.some((v) => v.id === next.id)) nextQueue = [...nextQueue, next]
        }
        if (!next) return null
        let res
        do res = await videos.fetch(next.id, { audioOnly: Boolean(ended.audioOnly) })
        while (res?.pending)
        if (res?.error || res?.needsYtDlp) return null
        return { ...ended, video: next, queue: nextQueue, playedIds: [...played, next.id] }
      }
      return null
    }
  })
  activeDispose = async () => {
    bg.dispose()
    await videos.reset()
  }

  plugin.panels.handle('youtube.fetch', ({ id, audioOnly = false } = {}) => videos.fetch(id, { audioOnly }))
  plugin.panels.handle('youtube.reset', async () => {
    await bg.stop()
    return videos.reset()
  })
  plugin.panels.handle('youtube.chunk', ({ id, offset = 0 } = {}) => videos.chunk(id, offset))
  plugin.panels.handle('playback.state', (state) => bg.updateState(state))
  plugin.panels.handle('playback.handoff', (state) => {
    plugin.log(`[bg] handoff kind=${state?.kind ?? ''} time=${state?.time?.toFixed?.(1) ?? ''}`)
    return bg.handoff(state)
  })
  plugin.panels.handle('playback.takeover', async () => {
    const res = await bg.takeover()
    if (res.active) plugin.log(`[bg] takeover kind=${res.state?.kind ?? ''} time=${res.state?.time?.toFixed?.(1) ?? ''}`)
    return res
  })
  plugin.panels.handle('playback.stop', () => bg.stop())
  // 패널이 오래 걸리는 요청을 걸어 두면, 패널이 닫히는 순간 signal이 중단돼 하트비트 끊김을 기다리지 않고 바로 이어받는다.
  // 요청 시간 초과와 구분되지 않으므로 25초마다 먼저 끝내고 패널이 다시 건다.
  plugin.panels.handle('playback.watch', (_input, { signal }) =>
    new Promise((resolve) => {
      const done = (result) => {
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        resolve(result)
      }
      const onAbort = () => {
        plugin.log('[bg] 패널 닫힘 감지 → 즉시 이어받기')
        bg.handoff(null)
        done({ closed: true })
      }
      const timer = setTimeout(() => done({ renew: true }), 25000)
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    })
  )
}
