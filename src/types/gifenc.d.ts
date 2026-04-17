declare module 'gifenc' {
  type Uint8Like = Uint8Array | Uint8ClampedArray;

  export function GIFEncoder(): {
    writeFrame(
      index: Uint8Like,
      width: number,
      height: number,
      options?: { palette?: number[][]; delay?: number; transparent?: boolean; transparentIndex?: number; repeat?: number; dispose?: number; first?: boolean },
    ): void;
    finish(): void;
    bytes(): Uint8Array;
  };

  export function quantize(
    data: Uint8Array | Uint8ClampedArray,
    maxColors: number,
    options?: { format?: 'rgb565' | 'rgb444' | 'rgba4444'; oneBitAlpha?: boolean | number; clearAlpha?: boolean; clearAlphaThreshold?: number; clearAlphaColor?: number },
  ): number[][];

  export function applyPalette(
    data: Uint8Array | Uint8ClampedArray,
    palette: number[][],
    format?: 'rgb565' | 'rgb444' | 'rgba4444',
  ): Uint8Array;
}
