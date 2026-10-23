import type { CSSProperties, MouseEvent } from 'react';
import { Image as ImageIcon } from 'lucide-react';
import type { PageComponent, StyleValues, ThemeName } from '../schemas/page';
import { THEMES, fontStack } from '../schemas/page';

type Props = {
  components: PageComponent[];
  styles: Record<string, StyleValues>;
  theme: ThemeName;
  selectedId: string;
  mode: 'edit' | 'preview';
  onSelect: (id: string) => void;
};
const str = (v: unknown, fallback = '') => typeof v === 'string' ? v : fallback;
const arr = (v: unknown): string[] => Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

export function aspectRatioValue(value: unknown): string {
  const v = typeof value === 'string' ? value.replace(/\s+/g, '').toLowerCase() : '';
  if (v === 'square') return '1 / 1';
  const m = v.match(/^(\d+)[:/](\d+)$/);
  return m ? `${m[1]} / ${m[2]}` : '16 / 9';
}

export function getNodeStyle(id: string, styles: Record<string, StyleValues>, theme: ThemeName, base: CSSProperties = {}): CSSProperties {
  const t = THEMES[theme];
  const s = styles[id] || {};
  return { color: s.color || t.text, backgroundColor: s.backgroundColor || undefined,
    fontFamily: fontStack(s.fontFamily || t.font), fontSize: s.fontSize ? `${s.fontSize}px` : undefined,
    borderColor: s.borderColor || t.border, '--element-accent': s.accentColor || t.accent, ...base } as CSSProperties;
}

export default function PageRenderer({ components, styles, theme, selectedId, mode, onSelect }: Props) {
  const t = THEMES[theme];
  const sketchLayout = components.length === 4 && components.filter(c => c.type === 'button').length === 2 && components.filter(c => c.type === 'textSection').length === 2;
  const select = (id: string) => (event: MouseEvent<HTMLElement>) => {
    if (mode === 'edit') { event.preventDefault(); event.stopPropagation(); onSelect(id); }
  };
  const shellStyle: CSSProperties = { '--page-bg': t.background, '--page-surface': t.surface, '--page-text': t.text,
    '--page-muted': t.muted, '--page-accent': t.accent, '--page-border': t.border,
    fontFamily: fontStack(styles['page-background']?.fontFamily || t.font),
    color: styles['page-background']?.color || t.text,
    backgroundColor: styles['page-background']?.backgroundColor || t.background,
    fontSize: styles['page-background']?.fontSize ? `${styles['page-background'].fontSize}px` : undefined
  } as CSSProperties;
  return <div className={`site-canvas theme-${theme}${sketchLayout ? ' inferred-sketch-layout' : ''}`} style={shellStyle} onClick={mode === 'edit' ? (e) => { if (e.target === e.currentTarget) onSelect('page-background'); } : undefined}>
    {components.map((component) => {
      const p = component.props || {};
      const selected = mode === 'edit' && selectedId === component.id;
      const baseLayoutStyle: CSSProperties = sketchLayout ? (component.type === 'button' ? { gridRow: 1, gridColumn: components.filter(c => c.type === 'button').findIndex(c => c.id === component.id) + 1, justifySelf: 'end', alignSelf: 'start' } : component.type === 'textSection' ? { gridRow: 2, gridColumn: components.filter(c => c.type === 'textSection').findIndex(c => c.id === component.id) + 1, minWidth: 0, maxWidth: 'none' } : {}) : {};
      const style = getNodeStyle(component.id, styles, theme, baseLayoutStyle);
      const className = `site-block block-${component.type}${mode === 'edit' ? ' is-editable' : ''}${selected ? ' is-selected' : ''}`;
      const data = { key: component.id, className, style, onClick: select(component.id), 'data-component-id': component.id };
      switch (component.type) {
        case 'navbar':
          return <nav {...data} key={component.id} className={`${className} site-nav`}><span className="brand">{str(p.brand, 'brand')}</span><div className="nav-links">{arr(p.links).map((link, i) => <a href="#" key={`${component.id}-link-${i}`} onClick={mode === 'edit' ? e => e.preventDefault() : undefined}>{link}</a>)}</div>{p.ctaLabel ? <button className="small-cta" onClick={e => { if (mode === 'edit') { e.preventDefault(); e.stopPropagation(); onSelect(component.id); } }}>{str(p.ctaLabel)}</button> : null}</nav>;
        case 'hero':
          return <section {...data} key={component.id} className={`${className} site-hero align-${['left','center','right'].includes(str(p.alignment)) ? str(p.alignment) : 'left'}`}>{str(p.eyebrow) ? <div className="eyebrow">{str(p.eyebrow)}</div> : null}<h1>{str(p.heading, 'Your headline goes here')}</h1>{str(p.body) ? <p>{str(p.body)}</p> : null}{p.buttonLabel ? <button className="primary-cta" onClick={e => { if (mode === 'edit') { e.preventDefault(); e.stopPropagation(); onSelect(component.id); } }}>{str(p.buttonLabel)}</button> : null}</section>;
        case 'textSection':
          return <section {...data} key={component.id} className={`${className} site-text-section`}><h2>{str(p.heading, 'Section heading')}</h2><p>{str(p.body, 'Write a paragraph here.')}</p></section>;
        case 'imagePlaceholder':
          return <div {...data} key={component.id} className={`${className} image-placeholder`} style={{ ...style, aspectRatio: aspectRatioValue(p.aspectRatio) }}><div className="image-placeholder-inner"><ImageIcon size={28} strokeWidth={1.5} aria-hidden /><span>{str(p.label, 'Image')}</span></div></div>;
        case 'button':
          return <div {...data} key={component.id} className={`${className} standalone-button`}><button className="primary-cta" onClick={e => { if (mode === 'edit') { e.preventDefault(); e.stopPropagation(); onSelect(component.id); } else { e.preventDefault(); } }}>{str(p.label, 'Button label')}</button></div>;
        case 'cardGrid': {
          const cards = Array.isArray(p.cards) ? p.cards as Array<Record<string, unknown>> : [];
          return <section {...data} key={component.id} className={`${className} site-card-section`}>{str(p.heading) ? <h2>{str(p.heading)}</h2> : null}<div className="service-grid">{cards.map((card, i) => {
            const cardId = str(card.id, `${component.id}-card-${i + 1}`);
            const cardSelected = mode === 'edit' && selectedId === cardId;
            const cardStyle = getNodeStyle(cardId, styles, theme, { backgroundColor: styles[cardId]?.backgroundColor || t.surface });
            return <article key={cardId} data-component-id={cardId} onClick={select(cardId)} className={`service-card${mode === 'edit' ? ' is-editable' : ''}${cardSelected ? ' is-selected' : ''}`} style={cardStyle}><h3>{str(card.title, 'Card title')}</h3>{str(card.body) ? <p>{str(card.body)}</p> : null}</article>;
          })}</div></section>;
        }
        case 'footer':
          return <footer {...data} key={component.id} className={`${className} site-footer`}><span>{str(p.text, 'Footer text')}</span><div>{arr(p.links).map((link, i) => <a key={`${component.id}-link-${i}`} href="#" onClick={mode === 'edit' ? e => e.preventDefault() : undefined}>{link}</a>)}</div></footer>;
        default: return null;
      }
    })}
  </div>;
}
