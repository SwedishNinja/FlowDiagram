/**
 * Smallest single-span change turning `oldText` into `newText`, as a
 * CodeMirror-style change spec. Used when syncing store text (canvas-driven
 * mutations) into the editor: replacing only the changed span keeps the
 * user's cursor/scroll in place and makes each visual edit a clean, granular
 * undo step — a whole-document replace would yank both.
 *
 * Returns null when the texts are identical.
 */
export function minimalChange(
  oldText: string,
  newText: string,
): { from: number; to: number; insert: string } | null {
  if (oldText === newText) return null;
  let start = 0;
  const minLen = Math.min(oldText.length, newText.length);
  while (start < minLen && oldText[start] === newText[start]) start++;
  let endOld = oldText.length;
  let endNew = newText.length;
  while (endOld > start && endNew > start && oldText[endOld - 1] === newText[endNew - 1]) {
    endOld--;
    endNew--;
  }
  return { from: start, to: endOld, insert: newText.slice(start, endNew) };
}
