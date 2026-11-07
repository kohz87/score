// Bot Screen (3.3.0, decision 135, docs/briefs/3.3.0-bot-screen.md): a read-only view of a profile's Hermes Bot
// Desktop. Hermes runs Xvnc on `<profile home>/bot-desktop/rfb.sock` (0600, no TCP); this is a minimal RFB 3.8 client
// that sends SetPixelFormat, SetEncodings and FramebufferUpdateRequest, and serves PNG snapshots. Hermes' input filter
// sits on its dashboard bridge, not here, so this module is the filter: KeyEvent and PointerEvent go out only while
// Score holds Hermes' lease for the viewer that took over (3.17.0, docs/briefs/3.17.0-take-over.md), never anything
// else (no cut text, no desktop size, no QEMU or other extensions).
//
// This path is the public facade; the implementation is split by responsibility in the sibling modules below.

export {
  CONTROL_IDLE_MS,
  MAX_SIDE,
  type BotControl,
  type BotScreenFrame,
  type BotScreenOptions,
  type BotScreenState,
  type BotScreenStatus,
} from './bot-screen-types.ts'
export {
  CLIENT_INIT_SHARED,
  CLIENT_VERSION,
  RfbSession,
  SECURITY_NONE,
  framebufferUpdateRequest,
  keyEvent,
  pointerEvent,
  setEncodings,
  setPixelFormat,
} from './bot-screen-protocol.ts'
export { encodePng } from './bot-screen-png.ts'
export { type LeaseView, leaseHolder, readLease } from './bot-screen-lease.ts'
export { BotScreens } from './bot-screen-screens.ts'
