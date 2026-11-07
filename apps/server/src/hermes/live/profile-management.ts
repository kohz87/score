import type { ProfileStepName } from '@score/contract'
import type {
  ProfileInventory,
  ProfileManagementPort,
  ProfileStepContext,
} from '../profile-management.ts'
import type { LiveProfileManagementOptions } from './profile-management-context.ts'
import { writeProfileDescription } from './profile-management-description.ts'
import { profileExportPath, readProfileInventory } from './profile-management-inventory.ts'
import { runProfileStep } from './profile-management-steps.ts'

export {
  foreignOwned,
  foreignOwnedMessage,
  verifyProfileArchive,
} from './profile-management-files.ts'

export class LiveProfileManagement implements ProfileManagementPort {
  constructor(private readonly options: LiveProfileManagementOptions) {}
  async profileInventory(name: string, cloneFrom?: string): Promise<ProfileInventory> {
    return readProfileInventory(this.options, name, cloneFrom)
  }
  profileExportPath(name: string, revision: string) {
    return profileExportPath(this.options, name, revision)
  }
  async describeProfile(name: string, description: string) {
    await writeProfileDescription(this.options, name, description)
  }
  async profileStep(
    step: ProfileStepName,
    context: ProfileStepContext,
  ): Promise<{ identity: string | null }> {
    return runProfileStep(this.options, step, context)
  }
}
