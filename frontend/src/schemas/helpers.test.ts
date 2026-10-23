import { describe, expect, it } from 'vitest';
import { fontStack } from './page';
import { aspectRatioValue } from '../components/PageRenderer';

describe('aspectRatioValue', () => {
  it('maps backend values to valid CSS', () => {
    expect(aspectRatioValue('wide')).toBe('16 / 9');
    expect(aspectRatioValue('square')).toBe('1 / 1');
    expect(aspectRatioValue('4:3')).toBe('4 / 3');
    expect(aspectRatioValue(undefined)).toBe('16 / 9');
  });
});

describe('fontStack', () => {
  it('always includes a fallback so text never drops to the browser default serif', () => {
    expect(fontStack('Inter')).toContain('sans-serif');
    expect(fontStack('Georgia')).toContain('serif');
    expect(fontStack(undefined)).toBeUndefined();
  });
});
