export const parts = [
  {
    name: 'Top bar',
    selector: '.top',
    props: ['fontSize', 'height', 'gap', 'padding', 'backgroundColor'],
  },
  { name: 'Wordmark', selector: '.word', props: ['fontSize', 'height', 'letterSpacing', 'color'] },
  { name: 'Nav', selector: '.nav', props: ['height', 'gap', 'backgroundColor'] },
  {
    name: 'Nav item',
    selector: '.nav button',
    props: ['fontSize', 'height', 'borderRadius', 'padding', 'color', 'backgroundColor'],
  },
  {
    name: 'Dock',
    selector: '.dock',
    props: ['fontSize', 'height', 'borderRadius', 'gap', 'padding', 'color', 'backgroundColor'],
  },
  {
    name: 'Dock ring',
    selector: '.ring',
    props: ['width', 'height', 'borderRadius', 'backgroundColor'],
  },
  {
    name: 'Search',
    selector: '.searchbtn',
    props: ['fontSize', 'height', 'borderRadius', 'gap', 'padding', 'color', 'backgroundColor'],
  },
  {
    name: 'Key hint',
    selector: '.kbd',
    props: ['fontSize', 'height', 'borderRadius', 'padding', 'color', 'backgroundColor'],
  },
  {
    name: 'Gear',
    selector: '.icon-btn.gear',
    props: ['width', 'height', 'borderRadius', 'color', 'backgroundColor'],
  },
  {
    name: 'Avatar',
    selector: '.avatar',
    props: ['fontSize', 'width', 'height', 'borderRadius', 'color', 'backgroundColor'],
  },
  {
    name: 'Room title',
    selector: '.roomtitle',
    props: ['fontSize', 'height', 'gap', 'letterSpacing', 'color'],
  },
  {
    name: 'Side panel',
    selector: '.side',
    props: ['width', 'height', 'borderRadius', 'color', 'backgroundColor', 'boxShadow'],
  },
  {
    name: 'Side head',
    selector: '.sidehead',
    props: ['height', 'gap', 'padding', 'borderBottomColor'],
  },
  {
    name: 'Tab bar',
    selector: '.tabbar',
    props: ['height', 'gap', 'padding', 'color', 'backgroundColor', 'borderTopColor'],
  },
  {
    name: 'Tab item',
    selector: '.tabbar button',
    props: ['fontSize', 'height', 'minWidth', 'gap', 'color'],
  },
]

// PLAN 11.4a: the prototype's room classes and the app's bold-room classes line up part by part.
export const roomParts = [
  {
    name: 'Room column',
    selector: '.roomcol',
    props: ['display', 'gap', 'maxWidth', 'flexGrow', 'flexBasis'],
  },
  {
    name: 'Room title',
    selector: '.roomtitle',
    props: ['fontSize', 'fontWeight', 'height', 'gap', 'letterSpacing', 'color'],
  },
  {
    name: 'Job tabs',
    selector: '.tabs',
    appSelector: '.bold-job-tabs',
    props: ['display', 'gap', 'flexWrap'],
  },
  {
    name: 'Selected job',
    selector: '.tabs .chip.on',
    appSelector: '.bold-job-tab.on',
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
    name: 'Filter row',
    selector: '.tabs',
    appSelector: '.bold-job-filters',
    props: ['display', 'gap', 'paddingLeft'],
  },
  {
    name: 'Request card',
    selector: '.pin',
    appSelector: '.bold-request',
    props: ['padding', 'borderRadius', 'gap', 'color', 'backgroundColor'],
  },
  {
    name: 'Request title',
    selector: '.pin > b:not(.small)',
    appSelector: '.bold-request-title',
    props: ['fontSize', 'fontWeight', 'lineHeight', 'color'],
  },
  {
    name: 'Stream',
    selector: '.stream',
    props: ['display', 'gap', 'minHeight', 'padding', 'overflowY'],
  },
  {
    name: 'Agent bubble',
    selector: '.theirs .bub',
    appSelector: '.bold-message .chat-message:not(.chat-message--you) .chat-text',
    props: ['padding', 'borderRadius', 'fontSize', 'color', 'backgroundColor'],
  },
  {
    name: 'Own bubble',
    selector: '.mine .bub',
    appSelector: '.bold-message .chat-message--you .chat-text',
    props: ['padding', 'borderRadius', 'fontSize', 'color', 'backgroundColor'],
  },
  {
    name: 'Capsule',
    selector: '.capsule',
    appSelector: '.bold-capsule',
    props: ['padding', 'borderRadius', 'gap', 'marginLeft', 'borderTopColor'],
  },
  {
    name: 'Result card',
    selector: '.result',
    appSelector: '.bold-result',
    props: ['width', 'padding', 'borderRadius', 'gap', 'color', 'backgroundColor'],
  },
  {
    name: 'Composer',
    selector: '.composer',
    appSelector: '.chat-composer-box--room',
    props: ['display', 'gap', 'padding', 'borderRadius', 'backgroundColor'],
  },
  {
    name: 'To chip',
    selector: '.composer .to',
    appSelector: '.chat-composer-room-to',
    props: ['padding', 'borderRadius', 'fontSize', 'fontWeight', 'color', 'backgroundColor'],
  },
  {
    name: 'Composer input',
    selector: '.composer input',
    appSelector: '.chat-composer-box--room > textarea',
    props: ['fontSize', 'padding', 'color', 'backgroundColor'],
  },
  {
    name: 'Send',
    selector: '.composer button[aria-label="Send"]',
    appSelector: '.chat-send',
    props: ['width', 'height', 'borderRadius', 'color', 'backgroundColor'],
  },
  {
    name: 'Plus',
    selector: '.composer button[aria-label="Attach, voice and commands"]',
    appSelector: '.chat-attach',
    props: ['width', 'height', 'borderRadius', 'color', 'backgroundColor'],
  },
  {
    name: 'Actions',
    selector: '.acts',
    appSelector: '.bold-acts',
    props: ['gap', 'alignItems', 'flexWrap'],
  },
]

// Board 09 has inline layout rather than the prototype's classes, so the empty room gets its own paired selectors.
export const emptyParts = [
  {
    name: 'Room column',
    selector: 'section[aria-label="Team room"]',
    appSelector: '.roomcol',
    props: ['display', 'gap', 'maxWidth', 'flexGrow', 'flexBasis'],
  },
  {
    name: 'Empty heading',
    selector: 'section h1 + div > p:first-child',
    appSelector: '.bold-empty-copy h2',
    props: ['fontFamily', 'fontSize', 'fontWeight', 'letterSpacing', 'lineHeight', 'color'],
  },
  {
    name: 'Empty description',
    selector: 'section h1 + div > p:nth-child(2)',
    appSelector: '.bold-empty-copy p',
    props: ['fontSize', 'lineHeight', 'color'],
  },
  {
    name: 'Starters grid',
    selector: 'section h1 + div > div',
    appSelector: '.bold-starters',
    props: ['display', 'gridTemplateColumns', 'gap'],
  },
  {
    name: 'Starter',
    selector: 'section button:has(b)',
    appSelector: '.bold-starter',
    props: ['padding', 'borderRadius', 'gap', 'color', 'backgroundColor'],
  },
  {
    name: 'Composer',
    selector: 'section > div:last-child',
    appSelector: '.chat-composer-box--room',
    props: ['display', 'gap', 'padding', 'borderRadius', 'backgroundColor', 'boxShadow'],
  },
  {
    name: 'Composer input',
    selector: '#first',
    appSelector: '.chat-composer-box--room > textarea',
    props: ['fontSize', 'padding', 'color', 'backgroundColor'],
  },
  {
    name: 'Send',
    selector: 'section button[aria-label="Send"]',
    appSelector: '.chat-send',
    props: ['width', 'height', 'borderRadius', 'color', 'backgroundColor'],
  },
]
