import { describe, it, expect } from 'vitest';
import { normalizeColor, withAlpha } from '../renderer/colorUtils';

describe('colorUtils', () => {
  describe('normalizeColor', () => {
    it('passes through a 6-digit hex with #', () => {
      expect(normalizeColor('#FF00AA')).toBe('#ff00aa');
    });

    it('adds # to a 6-digit hex without prefix', () => {
      expect(normalizeColor('3b82f6')).toBe('#3b82f6');
    });

    it('expands 3-digit hex to 6-digit', () => {
      expect(normalizeColor('#f0a')).toBe('#ff00aa');
    });

    it('converts named colors to hex', () => {
      expect(normalizeColor('red')).toBe('#ef4444');
      expect(normalizeColor('BLUE')).toBe('#3b82f6');
    });

    it('returns unknown CSS names as-is', () => {
      expect(normalizeColor('rebeccapurple')).toBe('rebeccapurple');
    });
  });

  describe('withAlpha', () => {
    it('appends alpha to a normalized hex', () => {
      expect(withAlpha('red', '30')).toBe('#ef444430');
      expect(withAlpha('#abc', 'DD')).toBe('#aabbccDD');
    });
  });
});
