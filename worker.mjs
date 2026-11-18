import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
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

const text = (node) => node?.simpleText ?? node?.runs?.map((run) => run.text).join('') ?? ''

// 공식 API 키 없이 검색 페이지에 박힌 ytInitialData에서 영상만 뽑는다.
// ponytail: 유튜브가 페이지 구조를 바꾸면 깨진다. 그때는 videoRenderer 위치만 다시 찾으면 된다.
export function parseSearch(html) {
  const match = html.match(/var ytInitialData = (\{.*?\});<\/script>/s)
  if (!match) throw new Error('유튜브 검색 결과를 읽지 못했습니다.')
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
  const res = await fetch(url, { headers: BROWSER_HEADERS, signal: AbortSignal.timeout(15000) })
  if (!res.ok) throw new Error(`유튜브 응답 ${res.status}`)
  const videos = parseSearch(await res.text())
  await Promise.all(videos.map(async (video) => (video.thumb = await thumbnail(video.id))))
  return videos
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
    if (isYoutubeUrl(q)) return { opened: true, ...(await open(q)) }
    try {
      return { videos: await searchYoutube(q) }
    } catch (error) {
      return { error: error.message }
    }
  })
}
