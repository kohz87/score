import type { HermesPort } from '../port.ts'
import { FakePortRunControl } from './fake-port-run-control.ts'

export { stepToObservation } from './fake-port-observations.ts'

export class FakePort extends FakePortRunControl implements HermesPort {}
