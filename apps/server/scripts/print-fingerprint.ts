import { currentMachineFingerprint } from '../src/hermes/live/fingerprint-command.ts'

console.log(JSON.stringify(await currentMachineFingerprint(), null, 2))
