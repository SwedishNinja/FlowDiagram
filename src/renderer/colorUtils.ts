/**
 * Named color -> hex mapping. Small set of common names; anything else
 * falls through to the canvas context, which accepts CSS color strings.
 */
const NAMED_COLORS: Record<string, string> = {
  red: '#ef4444',
  blue: '#3b82f6',
  green: '#10b981',
  yellow: '#eab308',
  amber: '#f59e0b',
  orange: '#f97316',
  purple: '#a855f7',
  violet: '#8b5cf6',
  pink: '#ec4899',
  cyan: '#06b6d4',
  teal: '#14b8a6',
  lime: '#84cc16',
  gray: '#6b7280',
  grey: '#6b7280',
  black: '#000000',
  white: '#ffffff',
};

/**
 * Normalize a color to a 6-digit hex string (without alpha).
 * Accepts: "#RRGGBB", "#RGB", "RRGGBB", "RGB", or a named color.
 */
export function normalizeColor(input: string): string {
  const trimmed = input.trim();

  // Named color lookup (case-insensitive)
  const named = NAMED_COLORS[trimmed.toLowerCase()];
  if (named) return named;

  // Strip leading #
  const hex = trimmed.startsWith('#') ? trimmed.slice(1) : trimmed;

  if (/^[0-9a-fA-F]{6}$/.test(hex)) {
    return '#' + hex.toLowerCase();
  }
  if (/^[0-9a-fA-F]{3}$/.test(hex)) {
    // Expand 3-digit to 6-digit
    return '#' + hex.split('').map(c => c + c).join('').toLowerCase();
  }

  // Fallback: return as-is (canvas will handle CSS names it knows)
  return trimmed;
}

/** Append an alpha value (00-FF) to a color, converting to 6-digit hex if needed */
export function withAlpha(color: string, alphaHex: string): string {
  const normalized = normalizeColor(color);
  if (normalized.startsWith('#') && normalized.length === 7) {
    return normalized + alphaHex;
  }
  // Fallback: return without alpha
  return normalized;
}
