import assert from 'node:assert/strict'
import { test } from 'node:test'
import { cliResult, isYoutubeUrl, parseSearch, youtubeUrl } from './worker.mjs'

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
