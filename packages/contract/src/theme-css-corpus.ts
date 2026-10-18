/**
 * Accept/reject corpus for theme CSS (decision 102). Run against the browser's sanitiser and the server's check
 * (apps/web/src/themes/sanitise.agreement.test.ts, apps/server/test/themes/css-allowlist.test.ts) so the two cannot
 * drift apart. `refused` lists the properties (or `@at-rules`) that must be refused, nothing else may be.
 */
export type ThemeCssCase = { name: string; css: string; refused: string[] }

export const THEME_CSS_CORPUS: readonly ThemeCssCase[] = [
  { name: 'colours', css: '.a { color: #112233; background-color: rgb(1, 2, 3) }', refused: [] },
  {
    name: 'own picture, gradient and position',
    css: '.a { background-image: url(asset:img/bg.webp), linear-gradient(red, rgb(0 0 0 / 50%)); background-size: cover; background-position: center top; background-repeat: no-repeat }',
    refused: [],
  },
  {
    name: 'background shorthand',
    css: '.a { background: #fff url(asset:img/a.png) no-repeat center / cover }',
    refused: [],
  },
  {
    name: 'borders and radius',
    css: '.a { border: 1px solid #ccc; border-radius: 12px; border-top-color: red; border-width: 2px }',
    refused: [],
  },
  {
    name: 'a small shadow',
    css: '.a { box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2); text-shadow: 1px 1px 2px #000 }',
    refused: [],
  },
  {
    name: 'fonts',
    css: '.a { font-family: "Source Serif 4", serif; font-weight: 600; font-style: italic }',
    refused: [],
  },
  {
    name: 'decoration, accent, caret, outline colour',
    css: '.a { text-decoration-line: underline; text-decoration-color: red; accent-color: #123456; caret-color: red; outline-color: red; outline-style: dashed }',
    refused: [],
  },
  { name: 'opacity', css: '.a { opacity: 0.8 }', refused: [] },
  {
    name: 'public tokens',
    css: ':root { --link-hover: #123456; --radius-m: 12px; --flow-edge: rgb(1 2 3); --h1-size: 38px; --body-size: 14px }',
    refused: [],
  },
  {
    name: 'nesting and grouping rules',
    css: '@media (width < 700px) { @supports (display: grid) { .a { color: red; & .b { color: blue } } } } @layer theme { .c { color: red } }',
    refused: [],
  },
  {
    name: 'word spacing (re-gate 3)',
    css: ':root { word-spacing: -100px }',
    refused: ['word-spacing'],
  },
  {
    name: 'transform (re-gate 3)',
    css: '.chat-message { transform: scaleY(-1) }',
    refused: ['transform'],
  },
  {
    name: 'translate, rotate, scale',
    css: '.a { translate: 10px; rotate: 90deg; scale: 2 }',
    refused: ['translate', 'rotate', 'scale'],
  },
  {
    name: 'clipping (re-gate 4)',
    css: '.a { height: 1px; overflow: clip; clip-path: inset(0); mask: none }',
    refused: ['height', 'overflow', 'clip-path', 'mask'],
  },
  {
    name: 'position and offsets',
    css: '.a { position: relative; top: 0; left: 0; inset: 0; z-index: 3 }',
    refused: ['position', 'top', 'left', 'inset', 'z-index'],
  },
  {
    name: 'sizes and spacing',
    css: '.a { width: 10px; min-height: 1px; max-width: 5px; margin: 0; padding: 0 }',
    refused: ['width', 'min-height', 'max-width', 'margin', 'padding'],
  },
  {
    name: 'display, flex, grid',
    css: '.a { display: none; flex: 1; grid-template-columns: 1fr; gap: 4px }',
    refused: ['display', 'flex', 'grid-template-columns', 'gap'],
  },
  {
    name: 'effects',
    css: '.a { filter: blur(2px); backdrop-filter: blur(2px); mix-blend-mode: multiply; visibility: hidden }',
    refused: ['filter', 'backdrop-filter', 'mix-blend-mode', 'visibility'],
  },
  {
    name: 'type metrics',
    css: '.a { font-size: 1px; line-height: 0; letter-spacing: -5px; text-indent: 999px; text-transform: uppercase; font: 12px serif }',
    refused: [
      'font-size',
      'line-height',
      'letter-spacing',
      'text-indent',
      'text-transform',
      'font',
    ],
  },
  {
    name: 'writing mode and direction',
    css: '.a { writing-mode: vertical-rl; direction: rtl; unicode-bidi: bidi-override }',
    refused: ['writing-mode', 'direction', 'unicode-bidi'],
  },
  {
    name: 'content and pointer events',
    css: '.a::before { content: "x"; pointer-events: none }',
    refused: ['content', 'pointer-events'],
  },
  {
    name: 'motion',
    css: '.a { animation: x 1s; transition: opacity 1s; animation-delay: 3s }',
    refused: ['animation', 'transition', 'animation-delay'],
  },
  { name: 'path geometry', css: 'path { d: path("M0 0 L1 1") }', refused: ['d'] },
  {
    name: 'outline shorthand and width',
    css: '.a { outline: 3px solid red; outline-width: 50px; outline-offset: 99px }',
    refused: ['outline', 'outline-width', 'outline-offset'],
  },
  {
    name: 'text decoration thickness, line-through',
    css: '.a { text-decoration-thickness: 40px; text-decoration-line: line-through }',
    refused: ['text-decoration-thickness', 'text-decoration-line'],
  },
  {
    name: 'values: var, calc, attr',
    css: '.a { color: var(--x); background-color: calc(1); border-color: attr(x) }',
    refused: ['color', 'background-color', 'border-color'],
  },
  {
    name: 'values: other addresses',
    css: '.a { background-image: url(https://x.test/a.png); background: url(data:image/png;base64,AA) }',
    refused: ['background-image', 'background'],
  },
  {
    name: 'values: a font file as a picture',
    css: '.a { background-image: url(asset:fonts/x.woff2) }',
    refused: ['background-image'],
  },
  {
    name: 'values: oversized border and shadow',
    css: '.a { border-width: 40px; box-shadow: 0 0 0 999px red; text-shadow: 0 0 99px red }',
    refused: ['border-width', 'box-shadow', 'text-shadow'],
  },
  {
    name: 'values: radius out of range',
    css: ':root { --radius-m: 99px; border-radius: 99999px }',
    refused: ['--radius-m', 'border-radius'],
  },
  { name: 'values: opacity above 1', css: '.a { opacity: 4 }', refused: ['opacity'] },
  {
    name: 'custom properties of the manifest pairs',
    css: ':root { --ground: #fff; --ink: #000; --card: #fff; --muted: #ccc }',
    refused: ['--ground', '--ink', '--card', '--muted'],
  },
  {
    name: 'custom properties of Score',
    css: ':root { --agent-violet: red; --rules-never: red; --h1-size: 90px; --body-size: 4px; --density: 0 }',
    refused: ['--agent-violet', '--rules-never', '--h1-size', '--body-size', '--density'],
  },
  {
    name: 'at-rules with a body',
    css: '@font-face { font-family: X; src: url(asset:fonts/x.woff2) } @keyframes x { to { color: red } } .a { color: red }',
    refused: ['@font-face', '@keyframes'],
  },
  {
    name: 'a refused declaration inside a media rule and a nested rule',
    css: '@media (min-width: 1px) { .a { color: red; word-spacing: 4px; & .b { transform: none } } }',
    refused: ['word-spacing', 'transform'],
  },
]
