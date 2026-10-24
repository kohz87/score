import { z } from 'zod'

// Contract § Where an agent runs (PLAN 11.8a, D15): the profile's Hermes terminal backend and what it separates.
export const RunsOnSchema = z.object({
  backend: z.enum(['local', 'docker', 'ssh', 'other']),
  /** `terminal.backend` as Hermes has it; null = never set (local). */
  raw: z.string().nullable(),
  /** Never "yes": some tools always run on this machine, whatever the backend. */
  separated: z.enum(['no', 'partly', 'unknown']),
  docker: z
    .object({
      image: z.string().nullable(),
      network: z.boolean(),
      mountsWorkspace: z.boolean(),
      runsAsRoot: z.boolean(),
      extraMounts: z.number().int().nonnegative(),
    })
    .nullable(),
  ssh: z
    .object({
      host: z.string().nullable(),
      user: z.string().nullable(),
      port: z.number().int().positive().nullable(),
      sameMachine: z.boolean(),
    })
    .nullable(),
  separatedTools: z.array(z.string()),
  hostTools: z.array(z.string()),
  notes: z.array(z.string()),
  checked: z.object({ how: z.enum(['source', 'live']), hermes: z.string(), at: z.string() }),
})

const DockerImageSchema = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[a-z0-9][a-z0-9._/:@-]*$/u)
// A host name, an IPv4 address or a bare IPv6 address (ssh takes `user@host`, so no brackets).
const HostSchema = z
  .string()
  .min(1)
  .max(253)
  .refine(
    (host) =>
      /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*\.?$/u.test(
        host,
      ) ||
      /^(?:\d{1,3}\.){3}\d{1,3}$/u.test(host) ||
      (/^[0-9A-Fa-f:.]+$/u.test(host) && host.includes(':') && /[0-9A-Fa-f]/u.test(host)),
    'Not a host name or address',
  )
export const RunsOnUpdateSchema = z.discriminatedUnion('backend', [
  z.object({ backend: z.literal('local') }).strict(),
  z
    .object({
      backend: z.literal('docker'),
      image: DockerImageSchema.optional(),
      network: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      backend: z.literal('ssh'),
      host: HostSchema,
      user: z.string().regex(/^[a-z_][a-z0-9_-]{0,31}$/u),
      port: z.number().int().min(1).max(65535).optional(),
      // The key's path only; Score never reads the key.
      keyPath: z
        .string()
        .min(2)
        .max(4096)
        .regex(/^\/[^\0\n\r]*$/u)
        .optional(),
    })
    .strict(),
])

export type RunsOn = z.infer<typeof RunsOnSchema>
export type RunsOnUpdate = z.infer<typeof RunsOnUpdateSchema>
