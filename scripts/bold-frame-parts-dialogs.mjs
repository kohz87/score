// PLAN 11.10f: the prototype's vSearch/searchList and the app's BoldSearch use different class names, so each side
// gets its own selector while the part names and measured properties stay aligned.
export const searchPrototypeParts = [
  {
    name: 'Scrim',
    selector: '.scrim',
    props: ['position', 'inset', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft'],
  },
  {
    name: 'Dialog',
    selector: '.scrim .dialog',
    props: ['width', 'maxWidth', 'borderRadius', 'padding', 'gap', 'overflow', 'backgroundColor'],
  },
  {
    name: 'Head',
    selector: '.scrim .dialog > .row',
    props: ['padding', 'gap', 'borderBottomColor'],
  },
  { name: 'Input', selector: '#sq', props: ['fontSize', 'color', 'backgroundColor'] },
  {
    name: 'List',
    selector: '#sres',
    props: ['padding', 'gap', 'maxHeight', 'overflowY', 'backgroundColor'],
  },
  {
    name: 'Section',
    selector: '#sres .sec',
    props: ['padding', 'fontSize', 'fontWeight', 'color'],
  },
  {
    name: 'Result',
    selector: '#sres .mi',
    props: ['minHeight', 'padding', 'borderRadius', 'gap', 'backgroundColor'],
  },
]

export const searchAppParts = [
  {
    name: 'Scrim',
    selector: '.bold-search-scrim',
    props: ['position', 'inset', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft'],
  },
  {
    name: 'Dialog',
    selector: '.bold-search-dialog',
    props: ['width', 'maxWidth', 'borderRadius', 'padding', 'gap', 'overflow', 'backgroundColor'],
  },
  {
    name: 'Head',
    selector: '.bold-search-head',
    props: ['padding', 'gap', 'borderBottomColor'],
  },
  {
    name: 'Input',
    selector: '.bold-search-head input',
    props: ['fontSize', 'color', 'backgroundColor'],
  },
  {
    name: 'List',
    selector: '.bold-search-list',
    props: ['padding', 'gap', 'maxHeight', 'overflowY', 'backgroundColor'],
  },
  {
    name: 'Section',
    selector: '.bold-search-section',
    props: ['padding', 'fontSize', 'fontWeight', 'color'],
  },
  {
    name: 'Result',
    selector: '.bold-search-result',
    props: ['minHeight', 'padding', 'borderRadius', 'gap', 'backgroundColor'],
  },
]

// PLAN 11.10d: the recipe dialog. The app's class names are prefixed, so each row names both selectors.
export const recipeParts = [
  {
    name: 'Recipe dialog',
    selectors: { prototype: '.dialog.wide', app: '.bold-dialog.wide' },
    props: ['width', 'maxWidth', 'padding', 'gap', 'borderRadius', 'backgroundColor', 'boxShadow'],
  },
  {
    name: 'Recipe switcher',
    selectors: { prototype: '.seg', app: '.bold-seg' },
    props: ['display', 'gap', 'padding', 'borderRadius', 'backgroundColor'],
  },
  {
    name: 'Selected recipe',
    selectors: { prototype: '.seg button.on', app: '.bold-seg button.on' },
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
    name: 'Problems badge',
    selectors: { prototype: '.badge', app: '.bold-badge' },
    props: ['padding', 'borderRadius', 'fontSize', 'fontWeight', 'color', 'backgroundColor'],
  },
  {
    name: 'Step',
    selectors: { prototype: '.step', app: '.bold-step' },
    props: ['minHeight', 'padding', 'gap', 'borderRadius', 'color', 'backgroundColor'],
  },
  {
    name: 'Selected step',
    selectors: { prototype: '.step.sel', app: '.bold-step.sel' },
    props: ['boxShadow', 'backgroundColor'],
  },
  {
    name: 'Inspector',
    selectors: { prototype: '.inner', app: '.bold-recipes-inspector' },
    props: ['padding', 'gap', 'borderRadius', 'backgroundColor'],
  },
  {
    name: 'Field',
    selectors: { prototype: '.field', app: '.bold-recipes-inspector .orch-field select' },
    props: ['minHeight', 'padding', 'borderRadius', 'color', 'backgroundColor'],
  },
  {
    name: 'Save',
    selectors: { prototype: '.btn.sm.primary', app: '.bold-recipes-actions .btn.primary' },
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
]
