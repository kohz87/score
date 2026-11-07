import { UnitBackendRecovery } from './unit-backend-recovery.ts'

export {
  LAUNCHES_PER_MINUTE,
  STOP_CAUSE,
  UNIT_CAPABLE_FILE,
  fallbackForced,
  fenceBarrier,
} from './unit-backend-helpers.ts'
export type {
  BackendKind,
  BackendStatus,
  RecoveredLaunch,
  RecoveryReport,
  UnitBackendDeps,
  UnitLaunchRequest,
  UnitOutcome,
  UnitRun,
} from './unit-backend-types.ts'

// Coding runs as supervised systemd user units (7.7a design v7). `service.ts` decides *whether* to use the unit backend
// (the capability check) and what a finished run means for the person; this backend is the Score side of one launch.
export class UnitBackend extends UnitBackendRecovery {}
