/** A search snippet whose matches are wrapped in `[[` and `]]` by the server; everything else stays plain text. */
export function SearchSnippet({ text }: { text: string }) {
  // With one capture group, split() puts the matches at the odd positions.
  const parts = text.split(/\[\[(.*?)\]\]/s)
  return (
    <>
      {parts.map((part, index) =>
        index % 2 === 1 ? <mark key={index}>{part}</mark> : <span key={index}>{part}</span>,
      )}
    </>
  )
}
