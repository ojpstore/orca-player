import { execFile, spawn } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { mkdir, open as openFile, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

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

// 공식 API 키 없이 검색 페이지에 박힌 ytInitialData에서 영상만 뽑는다.
// ponytail: 유튜브가 페이지 구조를 바꾸면 깨진다. 그때는 videoRenderer 위치만 다시 찾으면 된다.
export function parseSearch(html) {
  const match = html.match(/var ytInitialData = (\{.*?\});<\/script>/s)
  // 회사 보안망 등은 유튜브 대신 짧은 차단 페이지를 돌려준다.
  if (!match) throw new Error('유튜브 검색 결과를 읽지 못했습니다. 네트워크(회사 보안 등)에서 차단되었을 수 있습니다.')
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
        views: text(v.shortViewCountText),
        published: text(v.publishedTimeText)
      })
      return
    }
    for (const child of Object.values(value)) walk(child)
  }
  walk(JSON.parse(match[1]))
  return videos
}

const BROWSER_HEADERS = {
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
  'accept-language': 'ko-KR,ko;q=0.9'
}

// 패널은 외부 이미지를 못 불러서 썸네일을 data URL로 넘긴다. 실패한 썸네일은 비워 둔다.
async function thumbnail(id) {
  try {
    const res = await fetch(`https://i.ytimg.com/vi/${id}/mqdefault.jpg`, { signal: AbortSignal.timeout(8000) })
    if (!res.ok) return ''
    return `data:image/jpeg;base64,${Buffer.from(await res.arrayBuffer()).toString('base64')}`
  } catch {
    return ''
  }
}

export async function searchYoutube(query) {
  const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}&hl=ko&gl=KR`
  const res = await fetch(url, { headers: BROWSER_HEADERS, signal: AbortSignal.timeout(15000) }).catch((error) => {
    throw new Error(`유튜브에 연결하지 못했습니다 (${error.cause?.code ?? error.cause?.message ?? error.message})`)
  })
  if (!res.ok) throw new Error(`유튜브 응답 ${res.status}`)
  const videos = parseSearch(await res.text())
  await Promise.all(videos.map(async (video) => (video.thumb = await thumbnail(video.id))))
  return videos
}

// --- 패널 안 재생: 패널은 외부 미디어를 못 틀어서(CSP media-src 'self' blob:) yt-dlp로 받은 파일을 조각내 넘긴다.
// ponytail: Windows 전용(yt-dlp.exe). 다른 OS가 필요하면 바이너리 이름과 설치 URL만 나누면 된다.

const LOCAL_APP_DATA = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local')
const OWN_YTDLP = join(LOCAL_APP_DATA, 'orca-music-player', 'yt-dlp.exe')
const YTDLP_URL = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe'
const VIDEO_DIR = join(tmpdir(), 'orca-music-player')
export const CHUNK_BYTES = 512 * 1024 // 응답 한도 1 MiB, base64로 4/3배가 된다.

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

function downloadVideo(ytdlp, id, onProgress) {
  const file = join(VIDEO_DIR, `${id}.mp4`)
  const args = [
    // 회사 SSL 검사 인증서처럼 Windows에만 등록된 루트 인증서도 믿도록 OS 인증서 저장소를 쓴다.
    '--compat-options', 'no-certifi',
    // 18 = 360p 영상+소리 한 파일. ffmpeg 없이 바로 재생된다.
    '-f', '18/b[ext=mp4][height<=480]/b[ext=mp4]',
    '--no-playlist', '--newline', '--force-overwrites',
    '-o', file,
    `https://www.youtube.com/watch?v=${id}`
  ]
  return new Promise((resolve, reject) => {
    const child = spawn(ytdlp, args, { windowsHide: true })
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

  plugin.panels.handle('youtube.status', () => ({ ytdlp: findYtDlp() }))
  plugin.panels.handle('youtube.install', async () => {
    try {
      return { ytdlp: await installYtDlp() }
    } catch (error) {
      return { error: error.message }
    }
  })

  // 한 번에 한 영상만 받아 두고, 새 영상을 받을 때 이전 파일을 지운다.
  // 패널 요청은 최대 2분이라 다운로드는 뒤에서 돌리고, 끝나지 않았으면 pending을 돌려 패널이 다시 묻게 한다.
  let current = null // { id, file, size }
  let job = null // { id, promise }
  plugin.panels.handle('youtube.fetch', async ({ id } = {}) => {
    if (!/^[\w-]{11}$/.test(id ?? '')) return { error: '잘못된 영상 id입니다.' }
    if (current?.id === id) return { size: current.size }
    if (job?.id !== id) {
      const ytdlp = findYtDlp()
      if (!ytdlp) return { needsYtDlp: true }
      let last = -1
      const promise = (async () => {
        if (current) await rm(current.file, { force: true })
        current = null
        await mkdir(VIDEO_DIR, { recursive: true })
        const file = await downloadVideo(ytdlp, id, (percent) => {
          if (Math.floor(percent) === last) return
          last = Math.floor(percent)
          plugin.panels.post('youtube.progress', { id, percent: last })
        })
        // 그사이 다른 영상을 눌렀으면 이 파일은 버린다.
        if (job?.id !== id) return void (await rm(file, { force: true }))
        current = { id, file, size: (await stat(file)).size }
      })()
      job = { id, promise }
      promise.catch(() => {}).finally(() => job?.promise === promise && (job = null))
    }
    const { promise } = job
    try {
      const done = await Promise.race([promise.then(() => true), new Promise((resolve) => setTimeout(resolve, 90000, false))])
      return done ? { size: current.size } : { pending: true }
    } catch (error) {
      return { error: error.message }
    }
  })
  plugin.panels.handle('youtube.chunk', async ({ id, offset = 0 } = {}) => {
    if (current?.id !== id) return { error: '받아 둔 영상이 바뀌었습니다.' }
    const handle = await openFile(current.file, 'r')
    try {
      const buffer = Buffer.alloc(Math.min(CHUNK_BYTES, current.size - offset))
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset)
      return { data: buffer.subarray(0, bytesRead).toString('base64') }
    } finally {
      await handle.close()
    }
  })
}
