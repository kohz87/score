import { escapeHtml, renderMarkdown } from './markdown.ts'

// What a share link shows: a frozen snapshot made when the link was created (PLAN 5.26). Text parts only.
export interface ShareSnapshot {
  title: string
  messages: { who: string; you: boolean; at: string; text: string; images: number[] }[]
  /** Media ids copied from the room when "include images" was on; served as /s/:token/media/:n by position. */
  images: string[]
}

// Headers the shared page and its images carry (the CSP is exactly the design's).
export const SHARE_HEADERS = {
  'content-security-policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'",
  'x-robots-tag': 'noindex',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
} as const

const STYLE = `
:root { color-scheme: light; }
* { box-sizing: border-box; }
body { margin: 0; background: #ECEEF2; color: #12131A; font: 16px/1.55 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
main { max-width: 760px; margin: 0 auto; padding: 28px 16px 64px; }
header, article { background: #fff; border-radius: 28px; padding: 22px 28px; margin-bottom: 14px; overflow-wrap: anywhere; }
h1 { font-size: 28px; line-height: 1.15; margin: 0 0 6px; }
h2 { font-size: 15px; margin: 0 0 6px; }
h2 time { font-weight: 400; color: #4a4d5c; margin-left: 8px; font-size: 13px; }
.note { color: #4a4d5c; font-size: 14px; margin: 0; }
.you { background: #12131A; color: #fff; }
.you .note, .you h2 time { color: #d6d8de; }
p, ul, ol, blockquote, pre { margin: 0 0 10px; }
pre { background: #ECEEF2; color: #12131A; border-radius: 14px; padding: 12px 16px; overflow-x: auto; }
code { font-family: ui-monospace, "JetBrains Mono", Menlo, Consolas, monospace; font-size: 14px; }
:not(pre) > code { background: rgba(127,127,140,.18); border-radius: 6px; padding: 1px 5px; }
blockquote { border-left: 3px solid #b9bdc6; padding-left: 12px; color: #3a3d45; }
a { color: inherit; }
img { max-width: 100%; border-radius: 14px; display: block; margin-top: 8px; }
@media (max-width: 480px) { header, article { padding: 18px; border-radius: 22px; } }
`

function shell(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
${body}
</main>
</body>
</html>
`
}

/** Identical for an unknown, expired or revoked link, so nothing tells them apart. */
export const NOT_FOUND_PAGE = shell(
  'Not found',
  `<header><h1>This link doesn't work</h1><p class="note">It may have expired or been withdrawn, or the address may be wrong.</p></header>`,
)

export const TOO_MANY_PAGE = shell(
  'Please wait',
  `<header><h1>Too many requests</h1><p class="note">Please wait a minute and try again.</p></header>`,
)

function stamp(iso: string): string {
  return iso.slice(0, 16).replace('T', ' ') + ' UTC'
}

export function renderSharePage(snapshot: ShareSnapshot, token: string, expiresAt: string): string {
  const messages = snapshot.messages
    .map((message) => {
      const images = message.images
        .filter((n) => n >= 0 && n < snapshot.images.length)
        .map(
          (n) => `<img src="/s/${escapeHtml(token)}/media/${n}" alt="Shared image" loading="lazy">`,
        )
        .join('')
      return `<article class="${message.you ? 'you' : 'agent'}">
<h2>${escapeHtml(message.who)}<time datetime="${escapeHtml(message.at)}">${stamp(message.at)}</time></h2>
${renderMarkdown(message.text)}${images}
</article>`
    })
    .join('\n')
  return shell(
    snapshot.title,
    `<header><h1>${escapeHtml(snapshot.title)}</h1>
<p class="note">A read-only snapshot of a conversation shared from Score. It will stop working on ${stamp(expiresAt)}.</p></header>
${messages || '<article><p class="note">Nothing in this snapshot.</p></article>'}`,
  )
}
