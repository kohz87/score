export const codeParts = [
  {
    name: 'Panel',
    selectors: { prototype: '.side', app: '.bold-workbench' },
    props: ['width', 'padding', 'borderRadius', 'backgroundColor'],
  },
  {
    name: 'Tabs',
    selectors: { prototype: '.tabs', app: '.bold-bench-tabs' },
    props: ['display', 'gap', 'flexWrap'],
  },
  {
    name: 'Tab',
    selectors: { prototype: '.tabs .chip', app: '.bold-bench-tab' },
    props: [
      'minHeight',
      'padding',
      'borderRadius',
      'fontSize',
      'fontWeight',
      'color',
      'backgroundColor',
    ],
  },
  {
    name: 'Code surface',
    selectors: { prototype: '.code', app: '.bold-bench-code' },
    props: [
      'fontFamily',
      'fontSize',
      'lineHeight',
      'paddingTop',
      'paddingBottom',
      'borderRadius',
      'backgroundColor',
    ],
  },
  {
    name: 'Line',
    selectors: { prototype: '.code .ln', app: '.bold-bench-line' },
    props: ['display', 'minHeight', 'color'],
  },
  {
    name: 'Line number',
    selectors: { prototype: '.code .no', app: '.bold-bench-no' },
    props: ['width', 'paddingRight', 'color', 'fontSize'],
  },
  {
    name: 'Colour bar',
    selectors: { prototype: '.code .bar', app: '.bold-bench-bar' },
    props: ['width', 'backgroundColor'],
  },
  {
    name: 'Line text',
    selectors: { prototype: '.code .tx', app: '.bold-bench-tx' },
    props: ['paddingLeft', 'paddingRight'],
  },
]

export const screenParts = [
  {
    name: 'Panel',
    selectors: { prototype: '.side', app: '.bold-workbench' },
    props: ['width', 'padding', 'borderRadius', 'backgroundColor'],
  },
  {
    name: 'Screen head',
    selectors: { prototype: '.sidebody .row.small', app: '.bold-bench-screen-head' },
    props: ['fontSize', 'color', 'gap'],
  },
  {
    name: 'Screen frame',
    selectors: { prototype: '.sidebody .term', app: '.bold-bench-screen-frame' },
    props: [
      'minHeight',
      'height',
      'borderRadius',
      'padding',
      'fontFamily',
      'fontSize',
      'backgroundColor',
    ],
  },
]

export const replayParts = [
  {
    name: 'Page',
    selectors: { prototype: '.page', app: '.bold-screen' },
    props: ['padding', 'gap', 'color'],
  },
  {
    name: 'Steps list',
    selectors: { prototype: '.page ol', app: '.bold-screen-steps' },
    props: ['display', 'flexDirection', 'gap', 'maxWidth', 'padding'],
  },
  {
    name: 'Step',
    selectors: { prototype: '.page .step', app: '.bold-screen-step' },
    props: ['minHeight', 'padding', 'gap', 'borderRadius', 'fontSize', 'color', 'backgroundColor'],
  },
  {
    name: 'Stage',
    selectors: { prototype: '.page .term', app: '.bold-screen-stage' },
    props: ['minHeight', 'borderRadius', 'padding', 'fontFamily', 'fontSize', 'backgroundColor'],
  },
  {
    name: 'Badge',
    selectors: { prototype: '.page .badge', app: '.bold-screen-badge' },
    props: ['padding', 'borderRadius', 'fontSize', 'fontWeight', 'color', 'backgroundColor'],
  },
]
