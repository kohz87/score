import { Fragment } from 'react'

/** Rule or plugin names on one line, "A, B and C"; each name is its own span, so a reader or a test can find one. */
export function NameList({ names }: { names: string[] }) {
  return names.map((name, index) => (
    <Fragment key={`${index}:${name}`}>
      {index > 0 && (index === names.length - 1 ? ' and ' : ', ')}
      <span>{name}</span>
    </Fragment>
  ))
}
