import { describe, it, expect } from 'vitest';
import { minimalChange } from '../editor/minimalDiff';

/** Apply a change spec the way CodeMirror would. */
function apply(text: string, c: { from: number; to: number; insert: string }): string {
  return text.slice(0, c.from) + c.insert + text.slice(c.to);
}

describe('minimalChange', () => {
  it('returns null for identical texts', () => {
    expect(minimalChange('abc', 'abc')).toBeNull();
  });

  it('round-trips arbitrary edits', () => {
    const cases: Array<[string, string]> = [
      ['hello world', 'hello brave world'],   // insertion
      ['hello brave world', 'hello world'],   // deletion
      ['a: 100, 200', 'a: 150, 250'],         // replacement
      ['', 'fresh'],                           // from empty
      ['gone', ''],                            // to empty
      ['aaaa', 'aaa'],                         // ambiguous repeats (delete)
      ['aaa', 'aaaa'],                         // ambiguous repeats (insert)
      ['x\ny\nz', 'x\nY\nz'],                  // mid-document line change
    ];
    for (const [oldText, newText] of cases) {
      const c = minimalChange(oldText, newText)!;
      expect(c).not.toBeNull();
      expect(apply(oldText, c)).toBe(newText);
    }
  });

  it('keeps the changed span tight so the cursor elsewhere is unaffected', () => {
    // A drag rewrites one @positions line; the change must not span the doc.
    const oldText = '@startuml\ncomponent "A" as a\n@positions\n  a: 100, 200\n@enduml\n';
    const newText = '@startuml\ncomponent "A" as a\n@positions\n  a: 300, 400\n@enduml\n';
    const c = minimalChange(oldText, newText)!;
    expect(c.from).toBeGreaterThan(oldText.indexOf('@positions'));
    expect(c.to).toBeLessThan(oldText.indexOf('@enduml'));
  });
});
