export type ThemeName = 'professional' | 'minimalist' | 'colorful';
export type ComponentType = 'navbar' | 'hero' | 'textSection' | 'imagePlaceholder' | 'button' | 'cardGrid' | 'footer';
export type StyleValues = {
  fontFamily?: string;
  fontSize?: number;
  color?: string;
  backgroundColor?: string;
  accentColor?: string;
  borderColor?: string;
};
export type PageComponent = { id: string; type: ComponentType; props: Record<string, unknown> };
export type DetectedElement = { label: string; componentId: string | null };
export type PageData = {
  schemaVersion: '1.0';
  pageTitle: string;
  themeHint: ThemeName;
  components: PageComponent[];
  detectedElements: DetectedElement[];
  uncertainties: string[];
};
export type EditorDocument = { page: PageData; styles: Record<string, StyleValues> };
export const SUPPORTED_TYPES: ComponentType[] = ['navbar','hero','textSection','imagePlaceholder','button','cardGrid','footer'];
export const FONTS = ['Arial','Inter','Roboto','Georgia','Verdana','Poppins'] as const;
export const COMPONENT_LABELS: Record<ComponentType, string> = { navbar: 'Navigation bar', hero: 'Hero', textSection: 'Text section', imagePlaceholder: 'Image', button: 'Button', cardGrid: 'Card grid', footer: 'Footer' };
export const THEMES: Record<ThemeName, { label: string; background: string; surface: string; text: string; muted: string; accent: string; border: string; font: string }> = {
  professional: { label: 'Professional', background: '#F5F7FB', surface: '#FFFFFF', text: '#172033', muted: '#687386', accent: '#4F46E5', border: '#E1E6EF', font: 'Inter' },
  minimalist: { label: 'Minimalist', background: '#FAF9F6', surface: '#FFFFFF', text: '#202020', muted: '#77736D', accent: '#252525', border: '#E7E4DE', font: 'Georgia' },
  colorful: { label: 'Colorful', background: '#FFF6E8', surface: '#FFFFFF', text: '#25164A', muted: '#6C5D83', accent: '#F15B46', border: '#F6D9B7', font: 'Poppins' }
};
export function isPageData(value: unknown): value is PageData {
  if (!value || typeof value !== 'object') return false;
  const p = value as Record<string, unknown>;
  if (p.schemaVersion !== '1.0' || typeof p.pageTitle !== 'string' ||
      !['professional','minimalist','colorful'].includes(String(p.themeHint)) ||
      !Array.isArray(p.components) || !Array.isArray(p.detectedElements) || !Array.isArray(p.uncertainties)) return false;
  const ids = new Set<string>();
  return p.components.every((c: any) => c && typeof c.id === 'string' && c.id.length > 0 &&
    !ids.has(c.id) && (ids.add(c.id), SUPPORTED_TYPES.includes(c.type)) &&
    c.props && typeof c.props === 'object' && !Array.isArray(c.props));
}
export function uniqueId(base: string, used: Set<string>) {
  let id = base || 'component';
  let i = 2;
  while (used.has(id)) id = `${base}-${i++}`;
  used.add(id);
  return id;
}
export function fontStack(name: string | undefined): string | undefined {
  if (!name) return undefined;
  const serif = name === 'Georgia';
  return `${name}, ${serif ? "'Times New Roman', serif" : "system-ui, -apple-system, 'Segoe UI', Arial, sans-serif"}`;
}
