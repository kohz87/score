import { z } from 'zod'
import { redact } from '../../redact.ts'
import { ProfileNameSchema } from './paths.ts'
import { type LiveProfileManagementOptions, runProfileCli } from './profile-management-context.ts'
import { failure } from './profile-management-files.ts'

export async function writeProfileDescription(
  options: LiveProfileManagementOptions,
  name: string,
  description: string,
) {
  ProfileNameSchema.parse(name)
  const text = z
    .string()
    .trim()
    .min(1)
    .max(2000)
    .refine((v) => !v.includes('\0'))
    .parse(description)
  await runProfileCli(options, ['-p', 'default', 'profile', 'describe', name, '--text', text])
  options.profiles.invalidate(name)
  const detail = await options.profiles.read(name, 0, false, {
    status: 'offline',
    activity: null,
  })
  if (detail.role !== redact(text)) throw failure('Hermes didn’t keep the description.')
}
