// A small, server-side Markdown renderer for shared pages (PLAN 5.26). It never passes raw HTML through: all text is
// escaped first, and only the constructs below produce tags. Links need an http(s) or mailto target; images become
// their alt text (the page loads nothing from outside).

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => ESCAPES[char]!)
}

function safeHref(target: string): string | null {
  try {
    const url = new URL(target)
    return ['http:', 'https:', 'mailto:'].includes(url.protocol) ? url.href : null
  } catch {
    return null
  }
}

function emphasis(html: string): string {
  return html
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^\w*])\*([^*\n]+)\*(?![\w*])/g, '$1<em>$2</em>')
    .replace(/(^|[^\w])_([^_\n]+)_(?!\w)/g, '$1<em>$2</em>')
    .replace(/~~([^~\n]+)~~/g, '<del>$1</del>')
}

function inlineText(raw: string): string {
  // Escape first; emphasis and links then work on text that cannot contain tags. Links are set aside while emphasis
  // runs so a URL is never rewritten.
  const links: string[] = []
  const html = escapeHtml(raw.replace(/[\uE000\uE001]/g, ''))
    .replace(/!\[([^\]]*)\]\(([^)\s]*)\)/g, (_match, alt: string) => alt || 'image')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (match, label: string, target: string) => {
      const href = safeHref(
        target.replaceAll('&amp;', '&').replaceAll('&lt;', '<').replaceAll('&gt;', '>'),
      )
      if (!href) return match
      links.push(
        `<a href="${escapeHtml(href)}" rel="noopener noreferrer nofollow" target="_blank">${emphasis(label)}</a>`,
      )
      return `\uE000${links.length - 1}\uE001`
    })
  return emphasis(html).replace(/\uE000(\d+)\uE001/g, (_match, n: string) => links[Number(n)]!)
}

function inline(raw: string): string {
  // Code spans are cut out first so their content is shown literally.
  return raw
    .split(/(`[^`\n]+`)/)
    .map((piece, index) =>
      index % 2 === 1 ? `<code>${escapeHtml(piece.slice(1, -1))}</code>` : inlineText(piece),
    )
    .join('')
}

export function renderMarkdown(source: string): string {
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  const out: string[] = []
  let index = 0
  const flushParagraph = (paragraph: string[]) => {
    if (paragraph.length) out.push(`<p>${paragraph.map(inline).join('<br>\n')}</p>`)
  }
  let paragraph: string[] = []
  while (index < lines.length) {
    const line = lines[index]!
    const fence = /^ {0,3}(```|~~~)\s*([\w+#.-]*)/.exec(line)
    if (fence) {
      flushParagraph(paragraph)
      paragraph = []
      const code: string[] = []
      index++
      while (index < lines.length && !lines[index]!.trimStart().startsWith(fence[1]!)) {
        code.push(lines[index]!)
        index++
      }
      index++
      out.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`)
      continue
    }
    const heading = /^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line)
    if (heading) {
      flushParagraph(paragraph)
      paragraph = []
      const level = Math.min(heading[1]!.length + 2, 6)
      out.push(`<h${level}>${inline(heading[2]!)}</h${level}>`)
      index++
      continue
    }
    if (/^ {0,3}>/.test(line)) {
      flushParagraph(paragraph)
      paragraph = []
      const quote: string[] = []
      while (index < lines.length && /^ {0,3}>/.test(lines[index]!)) {
        quote.push(lines[index]!.replace(/^ {0,3}> ?/, ''))
        index++
      }
      out.push(`<blockquote>${renderMarkdown(quote.join('\n'))}</blockquote>`)
      continue
    }
    const list = /^ {0,3}([-*+]|\d{1,9}[.)])\s+(.*)$/.exec(line)
    if (list) {
      flushParagraph(paragraph)
      paragraph = []
      const ordered = /\d/.test(list[1]!)
      const items: string[] = []
      while (index < lines.length) {
        const item = /^ {0,3}([-*+]|\d{1,9}[.)])\s+(.*)$/.exec(lines[index]!)
        if (!item || /\d/.test(item[1]!) !== ordered) break
        items.push(`<li>${inline(item[2]!)}</li>`)
        index++
      }
      out.push(`<${ordered ? 'ol' : 'ul'}>${items.join('')}</${ordered ? 'ol' : 'ul'}>`)
      continue
    }
    if (/^ {0,3}([-*_])( *\1){2,} *$/.test(line)) {
      flushParagraph(paragraph)
      paragraph = []
      out.push('<hr>')
      index++
      continue
    }
    if (line.trim() === '') {
      flushParagraph(paragraph)
      paragraph = []
    } else paragraph.push(line)
    index++
  }
  flushParagraph(paragraph)
  return out.join('\n')
}
