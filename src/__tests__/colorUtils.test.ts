import { describe, it, expect } from 'vitest';
import { normalizeColor, withAlpha, mixColors } from '../renderer/colorUtils';

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

  describe('mixColors', () => {
    it('returns the endpoints at t=0 and t=1', () => {
      expect(mixColors('#3b82f6', '#ef4444', 0)).toBe('#3b82f6');
      expect(mixColors('#3b82f6', '#ef4444', 1)).toBe('#ef4444');
    });

    it('blends channel-wise at the midpoint', () => {
      expect(mixColors('#000000', '#ffffff', 0.5)).toBe('#808080');
    });

    it('accepts named colors', () => {
      expect(mixColors('blue', 'red', 1)).toBe('#ef4444');
    });

    it('snaps to the nearer end for non-hex CSS names', () => {
      expect(mixColors('rebeccapurple', '#ef4444', 0.2)).toBe('rebeccapurple');
      expect(mixColors('rebeccapurple', '#ef4444', 0.8)).toBe('#ef4444');
    });
  });

  describe('withAlpha', () => {
    it('appends alpha to a normalized hex', () => {
      expect(withAlpha('red', '30')).toBe('#ef444430');
      expect(withAlpha('#abc', 'DD')).toBe('#aabbccDD');
    });
  });
});
