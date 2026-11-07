import { memo, useMemo } from 'react'
import { tokenize } from '../routes/chat/highlight.ts'

export const CodeText = memo(function CodeText({
  text,
  language,
}: {
  text: string
  language: string | null
}) {
  const tokens = useMemo(() => tokenize(text, language), [language, text])
  return (
    <>
      {tokens.map((token, index) =>
        token.type === 'plain' ? (
          token.text
        ) : (
          <span key={index} className={`tok-${token.type}`}>
            {token.text}
          </span>
        ),
      )}
    </>
  )
})
