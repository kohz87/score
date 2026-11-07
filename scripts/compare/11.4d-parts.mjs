export const menuParts = [
  {
    name: 'Menu',
    selectors: {
      prototype: '.menu[role="listbox"], .menu',
      app: '.bold-room-switch, .bold-room-menu, .bold-job-menu',
    },
    props: ['width', 'padding', 'borderRadius', 'gap', 'backgroundColor', 'boxShadow'],
  },
  {
    name: 'Menu row',
    selectors: {
      prototype: '.menu .mi',
      app: '.bold-room-switch .mi, .bold-room-menu .mi, .bold-job-menu .mi',
    },
    props: ['minHeight', 'padding', 'borderRadius', 'gap', 'fontSize', 'color', 'backgroundColor'],
  },
  {
    name: 'Section label',
    selectors: { prototype: '.menu .sec', app: '.bold-room-switch .sec' },
    props: ['fontSize', 'fontWeight', 'color', 'padding'],
  },
]

export const elsewhereParts = [
  {
    name: 'Read-only note',
    selectors: { prototype: '.sidebody > .note', app: '.bold-elsewhere-note' },
    props: ['padding', 'borderRadius', 'fontSize', 'fontWeight', 'color', 'backgroundColor'],
  },
  {
    name: 'Bring button',
    selectors: { prototype: '.sidebody .btn.primary', app: '.bold-elsewhere-actions .btn.primary' },
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
    name: 'Side body',
    selectors: { prototype: '.sidebody', app: '.bold-elsewhere' },
    props: ['padding', 'gap', 'display', 'backgroundColor'],
  },
]
