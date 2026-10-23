import { describe, expect, it } from 'vitest';
import { isPageData } from './page';
import sample from '../mock/sample-page.json';

describe('page schema guard', () => {
  it('accepts the sample page contract', () => {
    expect(isPageData(sample)).toBe(true);
  });
  it('rejects unknown component types', () => {
    const bad = structuredClone(sample) as any;
    bad.components[0].type = 'rawHtml';
    expect(isPageData(bad)).toBe(false);
  });
  it('rejects duplicate component IDs', () => {
    const bad = structuredClone(sample) as any;
    bad.components[1].id = bad.components[0].id;
    expect(isPageData(bad)).toBe(false);
  });
});
