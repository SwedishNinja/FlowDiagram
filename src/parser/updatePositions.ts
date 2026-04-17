/**
 * Update the @positions block in source text with new component positions.
 * If no @positions block exists, a new one is inserted before @enduml.
 * Positions use the component's CENTER coordinates.
 */
export function updatePositionsInSource(
  source: string,
  positions: Record<string, { x: number; y: number }>,
): string {
  const lines = source.split('\n');

  // Find existing @positions block bounds
  let positionsStart = -1;
  let positionsEnd = -1;
  let endumlIdx = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();
    if (positionsStart === -1 && trimmed === '@positions') {
      positionsStart = i;
      // The block extends while lines look like `alias: x, y` or are blank/comment
      let j = i + 1;
      while (j < lines.length) {
        const next = lines[j]!.trim();
        if (next === '' || next.startsWith("'") || /^[a-zA-Z_][a-zA-Z0-9_]*\s*:\s*-?\d/.test(next)) {
          j++;
          continue;
        }
        break;
      }
      positionsEnd = j; // exclusive
    }
    if (trimmed === '@enduml') {
      endumlIdx = i;
      break;
    }
  }

  // Build the new block text
  const entries = Object.entries(positions);
  const blockLines: string[] = [];
  if (entries.length > 0) {
    blockLines.push('@positions');
    for (const [id, p] of entries) {
      blockLines.push(`  ${id}: ${Math.round(p.x)}, ${Math.round(p.y)}`);
    }
  }

  if (positionsStart !== -1 && positionsEnd !== -1) {
    // Replace existing block
    const before = lines.slice(0, positionsStart);
    const after = lines.slice(positionsEnd);
    if (blockLines.length === 0) {
      // Trim one blank line if present before/after to avoid gaps
      return [...before, ...after].join('\n');
    }
    return [...before, ...blockLines, ...after].join('\n');
  }

  // Insert a new block just before @enduml
  if (endumlIdx === -1) {
    // No @enduml — just append
    return source + '\n' + blockLines.join('\n') + '\n';
  }

  const before = lines.slice(0, endumlIdx);
  const after = lines.slice(endumlIdx);
  // Ensure a blank line separates the new block from previous content
  const separator = before.length > 0 && before[before.length - 1]!.trim() !== '' ? [''] : [];
  return [...before, ...separator, ...blockLines, '', ...after].join('\n');
}
