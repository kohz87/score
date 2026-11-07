import type { ReactNode } from 'react'

const svg = (children: ReactNode) => (
  <svg
    viewBox="0 0 20 20"
    width="18"
    height="18"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.6"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    {children}
  </svg>
)

export const ICONS = {
  undo: svg(
    <>
      <path d="M7 4 3.5 7.5 7 11" />
      <path d="M4 7.5h8a4 4 0 0 1 0 8H8" />
    </>,
  ),
  redo: svg(
    <>
      <path d="M13 4l3.5 3.5L13 11" />
      <path d="M16 7.5H8a4 4 0 0 0 0 8h4" />
    </>,
  ),
  heading: svg(
    <>
      <path d="M4 4v12M12 4v12M4 10h8" />
      <path d="M15 8l2-1v6" />
    </>,
  ),
  bold: svg(<path d="M6 4h5a3 3 0 0 1 0 6H6zM6 10h6a3 3 0 0 1 0 6H6z" />),
  italic: svg(<path d="M8 4h7M5 16h7M11.5 4l-3 12" />),
  strike: svg(
    <>
      <path d="M3 10h14" />
      <path d="M13.5 6.5C13 4.8 11.7 4 10 4S6.5 5 6.5 6.6c0 1.1.7 1.8 2 2.2M6.5 13.4c.5 1.8 1.8 2.6 3.5 2.6s3.5-1 3.5-2.6c0-.8-.4-1.4-1.1-1.8" />
    </>,
  ),
  code: svg(<path d="M7 6 3 10l4 4M13 6l4 4-4 4" />),
  bullet: svg(
    <>
      <circle cx="4.5" cy="5.5" r="1" />
      <circle cx="4.5" cy="10" r="1" />
      <circle cx="4.5" cy="14.5" r="1" />
      <path d="M8 5.5h9M8 10h9M8 14.5h9" />
    </>,
  ),
  numbered: svg(
    <>
      <path d="M8 5.5h9M8 10h9M8 14.5h9" />
      <path d="M3.5 4.5 5 4v3M3.5 12.5c0-1 1.8-1 1.8 0S3.5 13.5 3.5 14.5h2" />
    </>,
  ),
  task: svg(
    <>
      <rect x="3" y="4" width="5" height="5" rx="1" />
      <path d="m4 6.5 1 1 2-2.5M3 14h5M11 6.5h6M11 14h6" />
    </>,
  ),
  quote: svg(<path d="M4 7h4v4H5.5c0 1.5.8 2.2 2.5 2.5M12 7h4v4h-2.5c0 1.5.8 2.2 2.5 2.5" />),
  link: svg(
    <>
      <path d="M8.5 11.5a3 3 0 0 0 4.2 0l2.6-2.6a3 3 0 0 0-4.2-4.2l-.9.9" />
      <path d="M11.5 8.5a3 3 0 0 0-4.2 0L4.7 11.1a3 3 0 0 0 4.2 4.2l.9-.9" />
    </>,
  ),
  codeblock: svg(
    <>
      <rect x="3" y="4" width="14" height="12" rx="2" />
      <path d="m8 8.5-1.5 1.5L8 11.5M12 8.5l1.5 1.5-1.5 1.5" />
    </>,
  ),
  callout: svg(
    <>
      <rect x="3" y="4" width="14" height="12" rx="2" />
      <path d="M10 8v3M10 13v.01" />
    </>,
  ),
  rule: svg(<path d="M3 10h14" />),
  table: svg(
    <>
      <rect x="3" y="4" width="14" height="12" rx="2" />
      <path d="M3 8.5h14M3 12.5h14M8 4v12" />
    </>,
  ),
  image: svg(
    <>
      <rect x="3" y="4" width="14" height="12" rx="2" />
      <circle cx="7.5" cy="8.5" r="1.3" />
      <path d="m4 14 4-3.5 3 2.5 2-1.5 3 2.5" />
    </>,
  ),
}
