export const parts = {
  jobs: [
    {
      name: 'Job card',
      selectors: { board: 'a[href="03-phone-room.dc.html"]', app: '.bold-phone-job' },
      props: ['minHeight', 'padding', 'borderRadius', 'gap', 'backgroundColor'],
    },
    {
      name: 'Jobs heading',
      selectors: {
        board: 'span[style*="font-size: 12px"][style*="font-weight: 700"]',
        app: '.bold-phone-jobs-head h2',
      },
      props: ['fontSize', 'fontWeight', 'color', 'padding'],
    },
    {
      name: 'Pinned request',
      selectors: {
        board: 'div[style*="border-radius: 22px"][style*="padding: 14px 16px"]',
        app: '.bold-pins .bold-request',
      },
      props: ['padding', 'borderRadius', 'gap', 'backgroundColor'],
    },
    {
      name: 'Pinned Allow',
      selectors: {
        board: 'button[style*="background: #12131a"]',
        app: '.bold-pins .bold-approval-actions .btn:not(.ghost)',
      },
      props: ['minHeight', 'borderRadius', 'fontSize', 'fontWeight', 'backgroundColor'],
    },
  ],
  chat: [
    {
      name: 'Back',
      selectors: {
        board: 'button[aria-label="Back to chats"]',
        app: '[aria-label="Back to jobs"]',
      },
      props: ['width', 'height', 'borderRadius', 'backgroundColor'],
    },
    {
      name: 'Chat title',
      selectors: { board: 'header b', app: '.bold-phone-chat-id b' },
      props: ['fontSize', 'fontFamily', 'fontWeight'],
    },
    {
      name: 'Chat state',
      selectors: {
        board: 'header span[style*="font-size: 12px"]',
        app: '.bold-phone-chat-id > span',
      },
      props: ['fontSize', 'color'],
    },
    {
      name: 'Composer send',
      selectors: {
        board:
          'div[style*="border-radius: 999px"][style*="padding: 4px 4px 4px 6px"] button[aria-label="Send"]',
        app: '.bold-room-composer .chat-send',
      },
      props: ['width', 'height', 'borderRadius', 'backgroundColor'],
    },
  ],
  oneToOne: [
    {
      name: 'Privacy',
      selectors: { board: 'header span[style*="font-size: 12px"]', app: '.bold-dm-privacy' },
      props: ['fontSize', 'color'],
    },
    {
      name: 'Earlier chats',
      selectors: {
        board: 'button[aria-label="Earlier chats"]',
        app: 'button[aria-label="Earlier chats"]',
      },
      props: ['width', 'height', 'borderRadius', 'backgroundColor'],
    },
    {
      name: 'Private send',
      selectors: { board: 'button[aria-label="Send privately"]', app: 'button[aria-label="Send"]' },
      props: ['width', 'height', 'borderRadius', 'backgroundColor'],
    },
  ],
  team: [
    {
      name: 'Team card',
      selectors: { board: 'div[style*="padding: 6px 14px"] > a', app: '.bold-agentcard' },
      props: ['padding', 'borderRadius', 'gap'],
    },
    {
      name: 'Add',
      selectors: { board: 'header button', app: '.bold-team .pagehead .btn' },
      props: ['minHeight', 'padding', 'borderRadius', 'fontSize', 'fontWeight'],
    },
    {
      name: 'Message',
      selectors: {
        board:
          'div[style*="padding: 6px 14px"] > a span[style*="border-radius: 999px"][style*="padding: 8px 14px"]',
        app: '.bold-agentcard-actions .btn.primary',
      },
      props: ['minHeight', 'padding', 'borderRadius', 'fontSize', 'fontWeight'],
    },
  ],
  tabbar: [
    {
      name: 'Tab bar',
      selectors: { board: 'nav[aria-label="Main"]', app: '.bold-tabbar' },
      props: ['padding', 'borderTopColor', 'backgroundColor', 'justifyContent'],
    },
    {
      name: 'Tab',
      selectors: {
        board: 'nav[aria-label="Main"] > *:first-child',
        app: '.bold-tabbar button:first-child',
      },
      props: ['minWidth', 'minHeight', 'fontSize', 'fontWeight', 'color'],
    },
  ],
}
