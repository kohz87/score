// PLAN 11.9c: the Settings frame and Usage blocks. Both pages use the prototype's class names.
export const usageParts = [
  {
    name: 'Settings grid',
    selector: '.setgrid',
    props: ['display', 'gap', 'alignItems', 'width'],
  },
  {
    name: 'Settings nav',
    selector: '.setnav',
    props: ['width', 'maxWidth', 'gap', 'flexDirection', 'flexWrap'],
  },
  {
    name: 'Selected section',
    selector: '.setnav button.on',
    props: ['padding', 'borderRadius', 'color', 'backgroundColor'],
  },
  {
    name: 'Settings main',
    selector: '.setmain',
    props: ['minWidth', 'gap', 'flexGrow', 'flexBasis'],
  },
  {
    name: 'Range selector',
    selector: '.seg',
    props: ['display', 'gap', 'padding', 'borderRadius', 'backgroundColor'],
  },
  {
    name: 'Range item',
    selector: '.seg button.on',
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
    name: 'Numbers',
    selector: '.grid4',
    props: ['display', 'gap', 'gridTemplateColumns'],
  },
  {
    name: 'Number card',
    selector: '.grid4 .card',
    props: ['padding', 'borderRadius', 'gap', 'backgroundColor'],
  },
  {
    name: 'Charts',
    selector: '.grid2',
    props: ['display', 'gap', 'gridTemplateColumns'],
  },
  {
    name: 'Chart card',
    selector: '.grid2 .card',
    props: ['padding', 'borderRadius', 'gap', 'backgroundColor'],
  },
]

// PLAN 11.9b: Rules and System use the prototype's frame but real editors, so their element names differ.
export const rulesParts = [
  {
    name: 'Section title',
    selector: '.setmain > h2',
    appSelector: '.rules-card > div:first-child h2',
    props: ['fontSize', 'lineHeight', 'letterSpacing', 'color'],
  },
  {
    name: 'Mode card',
    selector: '.setmain > .card',
    appSelector: '.rules-style',
    props: ['padding', 'borderRadius', 'gap', 'backgroundColor'],
  },
  {
    name: 'Mode label',
    selector: '.setmain > .card .lab',
    appSelector: '.rules-style legend',
    props: ['fontSize', 'color'],
  },
  {
    name: 'Mode choices',
    selector: '.setmain > .card .seg',
    appSelector: '.rules-style .rules-option',
    props: ['display', 'gap', 'padding', 'borderRadius', 'backgroundColor'],
  },
  {
    name: 'Mode choice',
    selector: '.seg button.on',
    appSelector: '.rules-option:has(input:checked)',
    props: ['fontSize', 'fontWeight', 'color', 'backgroundColor'],
  },
  {
    name: 'Lists',
    selector: '.setmain > .grid3',
    appSelector: '.rules-columns',
    props: ['display', 'gap', 'gridTemplateColumns'],
  },
  {
    name: 'List card',
    selector: '.grid3 > .card',
    appSelector: '.rules-column',
    props: ['padding', 'borderRadius', 'gap', 'backgroundColor'],
  },
  {
    name: 'List heading',
    selector: '.grid3 > .card h3',
    appSelector: '.rules-column .rules-heading',
    props: ['fontSize', 'fontWeight', 'color'],
  },
  {
    name: 'Explanatory note',
    selector: '.setmain > .row .small.muted',
    appSelector: '.rules-card > .rules-note',
    props: ['fontSize', 'color'],
  },
]

export const systemParts = [
  {
    name: 'Section title',
    selector: '.setmain > h2',
    appSelector: '.bold-system > h2',
    props: ['fontSize', 'lineHeight', 'letterSpacing', 'color'],
  },
  {
    name: 'Cards',
    selector: '.setmain > .grid2',
    appSelector: '.system-grid',
    props: ['display', 'gap', 'gridTemplateColumns'],
  },
  {
    name: 'Card',
    selector: '.grid2 > .card:not(.span2)',
    appSelector: '.system-grid > .settings-card',
    props: ['padding', 'borderRadius', 'gap', 'backgroundColor'],
  },
  {
    name: 'Card heading',
    selector: '.grid2 > .card h3',
    appSelector: '.system-grid > .settings-card h2',
    props: ['fontSize', 'fontWeight', 'color'],
  },
  {
    name: 'Wide card',
    selector: '.grid2 > .card.span2',
    appSelector: '.system-logs .settings-card',
    props: ['padding', 'borderRadius', 'gap', 'backgroundColor'],
  },
  {
    name: 'Log surface',
    selector: '.grid2 > .card.span2 .term',
    appSelector: '.system-logs .logs-scroll',
    props: ['padding', 'borderRadius', 'fontFamily', 'fontSize', 'color', 'backgroundColor'],
  },
  {
    name: 'Pause row',
    selector: '.grid2 > .card.span2.row',
    appSelector: '.system-pause',
    props: ['padding', 'borderRadius', 'gap', 'backgroundColor'],
  },
  {
    name: 'Pause button',
    selector: '.grid2 > .card.span2.row .btn',
    appSelector: '.system-pause .btn',
    props: ['minHeight', 'padding', 'borderRadius', 'fontWeight', 'color', 'backgroundColor'],
  },
]
