/**
 * Tool-output cap LEVEL → effective cap resolution.
 *
 * Replaces the legacy binary `unrestricted_tool_output` toggle with a 6-level
 * scale. One scalar is applied to each cap site's OWN base constant:
 *
 *   economic = 1× base   medium = 2×   high = 4×   extra = 6×
 *   max      = the site's unrestricted CEILING (legacy "unrestricted" value)
 *   ultra    = 4× that ceiling (bounded — NOT truly uncapped; auto-compaction
 *              still runs, and a hard ceiling prevents a single tool dump from
 *              overflowing the model context window mid-turn)
 *
 * Finite non-max levels are clamped to the ceiling so the curve is monotonic
 * and can never exceed `max`; `ultra` then sits a fixed 4× above it. Pure
 * module — no imports. Each call-site passes its own (base, ceiling) so the
 * math stays unit-agnostic (works for byte caps AND line caps like read_file).
 */
export type ToolOutputCapLevel = 'economic' | 'medium' | 'high' | 'extra' | 'max' | 'ultra';

export const TOOL_OUTPUT_CAP_LEVELS: readonly ToolOutputCapLevel[] = [
  'economic',
  'medium',
  'high',
  'extra',
  'max',
  'ultra',
] as const;

/** Multipliers for the finite, sub-ceiling levels (applied to each site's base). */
const MULTIPLIER: Record<'economic' | 'medium' | 'high' | 'extra', number> = {
  economic: 1,
  medium: 2,
  high: 4,
  extra: 6,
};

/** `ultra` = this × the site's unrestricted ceiling (≈4 MB on the main runner). */
const ULTRA_CEILING_MULT = 4;

/**
 * Resolve the effective cap for ONE site given the active level and that site's
 * own base + unrestricted-ceiling constants.
 *
 *   capFor('economic', 24_000, 1_000_000) === 24_000
 *   capFor('medium',   24_000, 1_000_000) === 48_000
 *   capFor('extra',    24_000, 1_000_000) === 144_000
 *   capFor('max',      24_000, 1_000_000) === 1_000_000   (ceiling)
 *   capFor('ultra',    24_000, 1_000_000) === 4_000_000   (4× ceiling)
 *   // monotonic clamp — a tiny base never lets a high mult exceed ceiling:
 *   capFor('extra',    200_000, 1_000_000) === 1_000_000  (6×=1.2M clamped)
 */
export function capFor(level: ToolOutputCapLevel, base: number, ceiling: number): number {
  if (level === 'ultra') return ceiling * ULTRA_CEILING_MULT;
  if (level === 'max') return ceiling;
  return Math.min(base * MULTIPLIER[level], ceiling);
}

/** Narrowing parser for the DB column / HTTP body. Unknown → null (caller defaults). */
export function parseToolOutputCapLevel(v: unknown): ToolOutputCapLevel | null {
  return typeof v === 'string' && (TOOL_OUTPUT_CAP_LEVELS as readonly string[]).includes(v)
    ? (v as ToolOutputCapLevel)
    : null;
}

/**
 * Legacy bridge: derive a level from the old boolean column when the new
 * `tool_output_cap_level` column is NULL. `1 → 'max'` reproduces the old
 * "unrestricted" behavior exactly; everything else → `'economic'`.
 */
export function levelFromLegacyBoolean(unrestricted: boolean | null | undefined): ToolOutputCapLevel {
  return unrestricted ? 'max' : 'economic';
}
