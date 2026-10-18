import { z } from 'zod'

/**
 * Themes (PLAN 9, design docs/briefs/9-themes.md, decision 90): declarative packages — a manifest, sanitised CSS,
 * woff2 fonts and raster images. No theme code runs.
 */

/** The `theme.json` format this Score reads; a newer format is refused with a plain message. */
export const THEME_FORMAT = 1

/**
 * Colour tokens a theme may set (the public token list, design §3). Agent identity colours and the rules colours
 * (go / ask / never) are not on it: they carry meaning a theme must not change.
 */
export const THEME_COLOR_TOKENS = [
  'ground',
  'card',
  'ink',
  'ink-muted',
  'muted',
  'hairline',
  'line-strong',
  'subtle',
  'subtle-2',
  'track',
  'track-2',
  'link-hover',
  'on-dark',
  'panel-card',
  'panel-ink',
  'chat-text',
  'chat-secondary',
  'chat-soft',
  'chat-card-border',
  'chat-dark-border',
  'bubble-own',
  'bubble-own-ink',
  'flow-canvas',
  'flow-canvas-dot',
  'flow-edge',
  'flow-edge-planned',
  'flow-edge-sent-back',
  'flow-done-border',
  'flow-log-border',
  'tasks-ground',
  'tasks-border',
  'tasks-done',
  'tasks-note',
  'profile-dashed',
  'profile-add-ink',
  'watch-stage',
  'watch-window',
  'watch-text',
] as const
export const ThemeColorTokenSchema = z.enum(THEME_COLOR_TOKENS)
export type ThemeColorToken = z.infer<typeof ThemeColorTokenSchema>

/** `#rgb`, `#rrggbb`, `#rrggbbaa`, or `rgb()/rgba()/hsl()/hsla()/oklch()` with plain numbers: never `url()`, `var()`. */
export const ThemeColorSchema = z
  .string()
  .max(64)
  .regex(
    /^(#[0-9a-fA-F]{3}|#[0-9a-fA-F]{6}|#[0-9a-fA-F]{8}|(rgb|rgba|hsl|hsla|oklch)\(\s*[0-9.%\s,/+-]+\))$/,
  )

const ColorSetSchema = z.partialRecord(ThemeColorTokenSchema, ThemeColorSchema)

/** `asset:<path>` inside the package: `fonts/x.woff2`, `img/bg.webp`. */
export const ThemeAssetRefSchema = z
  .string()
  .max(160)
  .regex(/^asset:(fonts|img)\/[A-Za-z0-9][A-Za-z0-9._-]{0,80}\.(woff2|png|jpg|jpeg|webp|avif)$/)

const FontFamilySchema = z
  .string()
  .min(1)
  .max(60)
  .regex(/^[A-Za-z0-9][A-Za-z0-9 _-]*$/)

export const ThemeFontFaceSchema = z
  .object({
    family: FontFamilySchema,
    src: ThemeAssetRefSchema,
    weight: z
      .string()
      .regex(/^[1-9]00( [1-9]00)?$/)
      .default('400'),
    style: z.enum(['normal', 'italic']).default('normal'),
  })
  .strict()

export const ThemeDestinationSchema = z.enum([
  '/now',
  '/chat',
  '/tasks',
  '/team',
  '/knowledge',
  '/reports',
  '/settings',
])
export const ThemeNowCardSchema = z.enum([
  'timeline',
  'room',
  'needs-you',
  'made-today',
  'todo',
  'composer',
])

/**
 * Characters that show nothing by themselves: separators and spaces, controls, invisible formatting (zero-width
 * spaces and joiners, direction marks, word joiner, byte order mark, soft hyphen, invisible operators, tags), unassigned
 * and private-use code points, combining marks and variation selectors (they need a base), and the blank fillers that
 * are letters or symbols in Unicode but paint nothing (the Hangul fillers and the Braille blank).
 */
const INVISIBLE = /^[\p{Z}\p{Cc}\p{Cf}\p{Cn}\p{Co}\p{Cs}\p{M}\u115f\u1160\u2800\u3164\uffa0]$/u

/** Does the text contain a character that paints something? (A menu label of only spaces would blank a destination.) */
export function hasVisibleCharacter(text: string): boolean {
  return Array.from(text).some((character) => !INVISIBLE.test(character))
}

const ThemeLayoutSchema = z
  .object({
    nav: z.enum(['top', 'left', 'right', 'launcher']).optional(),
    contentWidth: z.enum(['narrow', 'wide', 'full']).optional(),
    /** Order and labels; a destination left out is hidden, except Settings (always shown, added last if missing). */
    menu: z
      .array(
        z
          .object({
            to: ThemeDestinationSchema,
            label: z
              .string()
              .min(1)
              .max(24)
              .refine(hasVisibleCharacter, 'The label needs at least one visible character')
              .optional(),
          })
          .strict(),
      )
      .max(7)
      .optional(),
    now: z
      .object({
        columns: z.int().min(1).max(4),
        /** Needs-you is always shown: added if missing. */
        cards: z
          .array(
            z.object({ card: ThemeNowCardSchema, span: z.int().min(1).max(4).default(1) }).strict(),
          )
          .max(12),
      })
      .strict()
      .optional(),
    chat: z
      .object({
        messages: z.enum(['plain', 'bubbles']).optional(),
        roomList: z.enum(['left', 'right', 'hidden-until-opened']).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()

const ThemeLookSchema = z
  .object({
    colors: z
      .object({ light: ColorSetSchema.optional(), dark: ColorSetSchema.optional() })
      .strict()
      .optional(),
    fonts: z
      .object({
        heading: FontFamilySchema.optional(),
        body: FontFamilySchema.optional(),
        code: FontFamilySchema.optional(),
        faces: z.array(ThemeFontFaceSchema).max(12).optional(),
      })
      .strict()
      .optional(),
    shape: z
      .object({
        radius: z.union([z.enum(['sharp', 'soft', 'round']), z.int().min(0).max(40)]).optional(),
        density: z.enum(['compact', 'comfortable', 'airy']).optional(),
        border: z.enum(['none', 'hairline', 'strong']).optional(),
        elevation: z.enum(['flat', 'raised', 'floating']).optional(),
        surface: z.enum(['solid', 'glass']).optional(),
      })
      .strict()
      .optional(),
    layout: ThemeLayoutSchema.optional(),
    background: z
      .object({
        image: ThemeAssetRefSchema.optional(),
        fit: z.enum(['cover', 'tile']).default('cover'),
        dim: z.int().min(0).max(80).default(0),
      })
      .strict()
      .optional(),
  })
  .strict()

export const ThemeIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/)
/**
 * Ids of the built-in themes; an import can't take them. The first four are the 8.3 packs (CSS in the web app); the
 * last three (9.5) are packages shipped with the server, in the same format as an import.
 */
export const BUILTIN_THEME_IDS = [
  'score',
  'paper',
  'night',
  'dense',
  'harbour',
  'ledger',
  'studio',
] as const

/** `theme.json`. Everything but `format`, `id` and `name` is optional; left-out settings use the Score default. */
export const ThemeManifestSchema = ThemeLookSchema.extend({
  format: z.literal(THEME_FORMAT),
  id: ThemeIdSchema,
  name: z.string().min(1).max(60),
  version: z
    .string()
    .regex(/^\d{1,4}\.\d{1,4}\.\d{1,4}$/)
    .default('1.0.0'),
  author: z.string().max(80).optional(),
  description: z.string().max(400).optional(),
  /** Overrides for the chat-first user view (8.4). */
  views: z.object({ user: ThemeLookSchema.optional() }).strict().optional(),
}).strict()
export type ThemeManifest = z.infer<typeof ThemeManifestSchema>

export const ThemeSourceSchema = z.enum(['builtin', 'imported', 'custom'])

/** Counts the host's `score look reset` runs (`meta` setting `look.resetGeneration`); a server without it says `0`. */
export const ResetGenerationSchema = z.number().int().min(0)

/** `GET /api/themes` items. */
export const ThemeSummarySchema = z.object({
  id: ThemeIdSchema,
  name: z.string(),
  version: z.string(),
  author: z.string().nullable(),
  description: z.string().nullable(),
  source: ThemeSourceSchema,
  updatedAt: z.iso.datetime(),
  hasCss: z.boolean(),
})
export type ThemeSummary = z.infer<typeof ThemeSummarySchema>
export const ThemeListSchema = z.object({
  items: z.array(ThemeSummarySchema),
  active: ThemeIdSchema,
  mode: z.enum(['light', 'dark', 'system']),
  /** Bumped by `scripts/score look reset`: a device whose saved override or boot cache saw an older number drops them. */
  resetGeneration: ResetGenerationSchema.default(0),
})
export type ThemeList = z.infer<typeof ThemeListSchema>

/** `GET /api/themes/:id`: the manifest, the stored (already sanitised) CSS and the asset paths. */
export const ThemeDetailSchema = z.object({
  summary: ThemeSummarySchema,
  manifest: ThemeManifestSchema,
  css: z.string().max(262_144),
  assets: z.array(z.string()),
  etag: z.string().min(1),
})
export type ThemeDetail = z.infer<typeof ThemeDetailSchema>

/** What the sanitiser dropped (design §4.1), shown before install and in the Customizer. */
export const ThemeSanitiseReportSchema = z.object({
  dropped: z.array(
    z.object({
      rule: z.string().max(200),
      reason: z.enum([
        'import',
        'external_url',
        'content',
        'property_not_allowed',
        'value_not_allowed',
        'important',
        'protected_selector',
        'selector_not_allowed',
        'font_face',
        'other_at_rule',
      ]),
    }),
  ),
})
export type ThemeSanitiseReport = z.infer<typeof ThemeSanitiseReportSchema>

/** `PUT /api/themes/:id` (custom themes only). `css` is the browser-sanitised text; the server re-checks it. */
export const ThemeSaveSchema = z
  .object({
    manifest: ThemeManifestSchema,
    css: z.string().max(262_144).default(''),
    etag: z.string().min(1).nullable(),
  })
  .strict()
export type ThemeSave = z.infer<typeof ThemeSaveSchema>

/**
 * `POST /api/themes/import` result. The theme is stored but not activated. `detail` is the theme exactly as this import
 * committed it (its `etag` included), read inside the same serialised step, so a client adopts what it wrote and not
 * whatever another writer stored a moment later.
 */
export const ThemeImportResultSchema = z.object({
  theme: ThemeSummarySchema,
  report: ThemeSanitiseReportSchema,
  detail: ThemeDetailSchema,
})
export type ThemeImportResult = z.infer<typeof ThemeImportResultSchema>

/** `PUT /api/look`: the theme every device uses unless it chose its own. */
export const LookSettingsSchema = z
  .object({ activeTheme: ThemeIdSchema, mode: z.enum(['light', 'dark', 'system']) })
  .strict()
export type LookSettings = z.infer<typeof LookSettingsSchema>

/** The `look.changed` event: the new shared look and the reset generation at that moment. */
export const LookChangedSchema = LookSettingsSchema.extend({
  resetGeneration: ResetGenerationSchema.default(0),
})
export type LookChanged = z.infer<typeof LookChangedSchema>
