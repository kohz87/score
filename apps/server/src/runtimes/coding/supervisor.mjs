// The in-unit supervisor of a coding run (7.7a design v7 sections 1, 3, 4). Plain JavaScript, Node built-ins only: it
// runs as the main process of a transient systemd user unit, started by absolute node path with a minimal environment.
//
// Wire protocol (JSON lines, each <= 64 KB; the Score side is coding-socket.ts):
//   supervisor -> Score  hello{v,launch,generation,token,specHash}  ready{pid,start,cgroup}
//                        out{stream,seq,data(base64)}  eof{stream,lastSeq}  exit{code,signal}  end{}  error{code}
//   Score -> supervisor  welcome  reject{reason}  go  cancel  stop{cause}  ack-end
// Terminal order: eof (both streams) + exit, payload cgroup empty, `ended` receipt, `end`, Score's `ack-end`, exit 0.
// Any socket close other than after `ack-end` is socket loss: stop the CLI tree, wait for the payload to empty, exit 2.
import { unlinkSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { EXIT } from './supervisor-protocol.mjs'
import { runSupervisor } from './supervisor-run.mjs'
import { loadSpec } from './supervisor-spec.mjs'

export {
  EXIT,
  MAX_CHUNK_BYTES,
  MAX_FRAME_BYTES,
  PROTOCOL_VERSION,
  hashSpec,
  procStart,
} from './supervisor-protocol.mjs'
export { parseReceipt, replaceReceipt, syncReceipt, writeReceipt } from './supervisor-receipts.mjs'
export { systemdCgroup } from './supervisor-cgroup.mjs'
export { runSupervisor } from './supervisor-run.mjs'

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let spec
  try {
    spec = loadSpec(process.argv[2])
  } catch {
    process.exit(EXIT.badSpec)
  }
  // The spec holds the single-use token: delete it right after reading, before `hello` (lead answer, part 3). Score
  // deletes it again on `ready` or settlement as a backstop.
  try {
    unlinkSync(process.argv[2])
  } catch {
    // Score's backstop removes it
  }
  runSupervisor(spec).then(
    (code) => process.exit(code),
    () => process.exit(EXIT.failed),
  )
}
