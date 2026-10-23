import { useEffect, useRef, type CSSProperties, type MouseEvent } from 'react';
import { ArrowRight, Compass, Cpu, Image as ImageIcon, Layers, Sparkles } from 'lucide-react';
import type { PageComponent, StyleValues, ThemeName } from '../schemas/page';
import { THEMES, fontStack } from '../schemas/page';
import {
  handleMagneticLeave,
  handleMagneticMove,
  handleTiltLeave,
  handleTiltMove,
} from '../utils/motion';

type Props = {
  components: PageComponent[];
  styles: Record<string, StyleValues>;
  theme: ThemeName;
  selectedId: string;
  mode: 'edit' | 'preview';
  onSelect: (id: string) => void;
  motionEnabled?: boolean;
};

const str = (v: unknown, fallback = '') => (typeof v === 'string' ? v : fallback);
const arr = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

const CARD_ICONS = [Compass, Layers, Cpu, Sparkles];

export function aspectRatioValue(value: unknown): string {
  const v = typeof value === 'string' ? value.replace(/\s+/g, '').toLowerCase() : '';
  if (v === 'square') return '1 / 1';
  const m = v.match(/^(\d+)[:/](\d+)$/);
  return m ? `${m[1]} / ${m[2]}` : '16 / 9';
}

export function getNodeStyle(
  id: string,
  styles: Record<string, StyleValues>,
  theme: ThemeName,
  base: CSSProperties = {}
): CSSProperties {
  const t = THEMES[theme];
  const s = styles[id] || {};
  return {
    color: s.color || t.text,
    backgroundColor: s.backgroundColor || undefined,
    fontFamily: fontStack(s.fontFamily || t.font),
    fontSize: s.fontSize ? `${s.fontSize}px` : undefined,
    borderColor: s.borderColor || t.border,
    '--element-accent': s.accentColor || t.accent,
    ...base,
  } as CSSProperties;
}

export default function PageRenderer({
  components,
  styles,
  theme,
  selectedId,
  mode,
  onSelect,
  motionEnabled = true,
}: Props) {
  const canvasRef = useRef<HTMLDivElement>(null);
  const t = THEMES[theme];
  const sketchLayout =
    components.length === 4 &&
    components.filter((c) => c.type === 'button').length === 2 &&
    components.filter((c) => c.type === 'textSection').length === 2;

  // Scroll-reveal observer for smooth staggered entrance inside the canvas
  useEffect(() => {
    const root = canvasRef.current;
    if (!root) return;
    const targets = root.querySelectorAll<HTMLElement>('.reveal-on-scroll');
    if (!motionEnabled || typeof IntersectionObserver === 'undefined') {
      targets.forEach((el) => el.classList.add('is-visible'));
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add('is-visible');
          }
        });
      },
      { threshold: 0.08, rootMargin: '0px 0px -24px 0px' }
    );

    targets.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, [components, motionEnabled, theme]);

  const select = (id: string) => (event: MouseEvent<HTMLElement>) => {
    if (mode === 'edit') {
      event.preventDefault();
      event.stopPropagation();
      onSelect(id);
    }
  };

  const shellStyle: CSSProperties = {
    '--page-bg': t.background,
    '--page-surface': t.surface,
    '--page-text': t.text,
    '--page-muted': t.muted,
    '--page-accent': t.accent,
    '--page-border': t.border,
    fontFamily: fontStack(styles['page-background']?.fontFamily || t.font),
    color: styles['page-background']?.color || t.text,
    backgroundColor: styles['page-background']?.backgroundColor || t.background,
    fontSize: styles['page-background']?.fontSize
      ? `${styles['page-background'].fontSize}px`
      : undefined,
  } as CSSProperties;

  return (
    <div
      ref={canvasRef}
      className={`site-canvas theme-${theme}${sketchLayout ? ' inferred-sketch-layout' : ''}${
        !motionEnabled ? ' motion-reduced' : ''
      }`}
      style={shellStyle}
      onClick={
        mode === 'edit'
          ? (e) => {
              if (e.target === e.currentTarget) onSelect('page-background');
            }
          : undefined
      }
    >
      {/* Subtle anti-gravity background parallax layer */}
      <div className="canvas-ambient" aria-hidden="true">
        <div className="ambient-orb orb-1" />
        <div className="ambient-orb orb-2" />
      </div>

      {components.map((component, idx) => {
        const p = component.props || {};
        const selected = mode === 'edit' && selectedId === component.id;
        const baseLayoutStyle: CSSProperties = sketchLayout
          ? component.type === 'button'
            ? {
                gridRow: 1,
                gridColumn:
                  components.filter((c) => c.type === 'button').findIndex((c) => c.id === component.id) +
                  1,
                justifySelf: 'end',
                alignSelf: 'start',
              }
            : component.type === 'textSection'
              ? {
                  gridRow: 2,
                  gridColumn:
                    components
                      .filter((c) => c.type === 'textSection')
                      .findIndex((c) => c.id === component.id) + 1,
                  minWidth: 0,
                  maxWidth: 'none',
                }
              : {}
          : {};

        const style = getNodeStyle(component.id, styles, theme, {
          ...baseLayoutStyle,
          '--reveal-delay': `${Math.min(idx * 65, 320)}ms`,
        } as CSSProperties);

        const className = `site-block block-${component.type} reveal-on-scroll is-visible${
          mode === 'edit' ? ' is-editable' : ''
        }${selected ? ' is-selected' : ''}`;

        const data = {
          key: component.id,
          className,
          style,
          onClick: select(component.id),
          'data-component-id': component.id,
        };

        switch (component.type) {
          case 'navbar':
            return (
              <nav {...data} key={component.id} className={`${className} site-nav`}>
                <span className="brand">
                  <span className="brand-dot" aria-hidden="true" />
                  {str(p.brand, 'brand')}
                </span>
                <div className="nav-links">
                  {arr(p.links).map((link, i) => (
                    <a
                      href="#"
                      key={`${component.id}-link-${i}`}
                      className="interactive-link"
                      onMouseMove={(e) => handleMagneticMove(e, 0.18, !motionEnabled)}
                      onMouseLeave={handleMagneticLeave}
                      onClick={mode === 'edit' ? (e) => e.preventDefault() : undefined}
                    >
                      {link}
                    </a>
                  ))}
                </div>
                {p.ctaLabel ? (
                  <button
                    className="small-cta magnetic-btn"
                    onMouseMove={(e) => handleMagneticMove(e, 0.25, !motionEnabled)}
                    onMouseLeave={handleMagneticLeave}
                    onClick={(e) => {
                      if (mode === 'edit') {
                        e.preventDefault();
                        e.stopPropagation();
                        onSelect(component.id);
                      }
                    }}
                  >
                    <span>{str(p.ctaLabel)}</span>
                  </button>
                ) : null}
              </nav>
            );

          case 'hero': {
            const align = ['left', 'center', 'right'].includes(str(p.alignment))
              ? str(p.alignment)
              : 'left';
            return (
              <section
                {...data}
                key={component.id}
                className={`${className} site-hero align-${align} tilt-surface`}
                onMouseMove={(e) => handleTiltMove(e, 2.2, !motionEnabled)}
                onMouseLeave={handleTiltLeave}
              >
                {/* Floating anti-gravity decorative layers reactive to cursor position */}
                <div className="hero-parallax-layer" aria-hidden="true">
                  <span className="hero-orb hero-orb-a" />
                  <span className="hero-orb hero-orb-b" />
                  <span className="hero-ring" />
                </div>

                <div className="hero-content">
                  {str(p.eyebrow) ? (
                    <div className="eyebrow">
                      <span className="eyebrow-pulse" aria-hidden="true" />
                      {str(p.eyebrow)}
                    </div>
                  ) : null}
                  <h1>{str(p.heading, 'Your headline goes here')}</h1>
                  {str(p.body) ? <p>{str(p.body)}</p> : null}
                  {p.buttonLabel ? (
                    <button
                      className="primary-cta magnetic-btn"
                      onMouseMove={(e) => handleMagneticMove(e, 0.28, !motionEnabled)}
                      onMouseLeave={handleMagneticLeave}
                      onClick={(e) => {
                        if (mode === 'edit') {
                          e.preventDefault();
                          e.stopPropagation();
                          onSelect(component.id);
                        }
                      }}
                    >
                      <span>{str(p.buttonLabel)}</span>
                      <ArrowRight size={16} className="cta-arrow" aria-hidden="true" />
                    </button>
                  ) : null}
                </div>
              </section>
            );
          }

          case 'textSection':
            return (
              <section {...data} key={component.id} className={`${className} site-text-section`}>
                <h2>{str(p.heading, 'Section heading')}</h2>
                <p>{str(p.body, 'Write a paragraph here.')}</p>
              </section>
            );

          case 'imagePlaceholder':
            return (
              <div
                {...data}
                key={component.id}
                className={`${className} image-placeholder tilt-surface`}
                style={{ ...style, aspectRatio: aspectRatioValue(p.aspectRatio) }}
                onMouseMove={(e) => handleTiltMove(e, 2.5, !motionEnabled)}
                onMouseLeave={handleTiltLeave}
              >
                <div className="image-placeholder-inner">
                  <div className="placeholder-icon-badge">
                    <ImageIcon size={26} strokeWidth={1.6} aria-hidden="true" />
                  </div>
                  <span>{str(p.label, 'Image')}</span>
                </div>
              </div>
            );

          case 'button':
            return (
              <div {...data} key={component.id} className={`${className} standalone-button`}>
                <button
                  className="primary-cta magnetic-btn"
                  onMouseMove={(e) => handleMagneticMove(e, 0.28, !motionEnabled)}
                  onMouseLeave={handleMagneticLeave}
                  onClick={(e) => {
                    if (mode === 'edit') {
                      e.preventDefault();
                      e.stopPropagation();
                      onSelect(component.id);
                    } else {
                      e.preventDefault();
                    }
                  }}
                >
                  <span>{str(p.label, 'Button label')}</span>
                  <ArrowRight size={16} className="cta-arrow" aria-hidden="true" />
                </button>
              </div>
            );

          case 'cardGrid': {
            const cards = Array.isArray(p.cards) ? (p.cards as Array<Record<string, unknown>>) : [];
            return (
              <section {...data} key={component.id} className={`${className} site-card-section`}>
                {str(p.heading) ? <h2>{str(p.heading)}</h2> : null}
                <div className="service-grid">
                  {cards.map((card, i) => {
                    const cardId = str(card.id, `${component.id}-card-${i + 1}`);
                    const cardSelected = mode === 'edit' && selectedId === cardId;
                    const CardIcon = CARD_ICONS[i % CARD_ICONS.length];
                    const cardStyle = getNodeStyle(cardId, styles, theme, {
                      backgroundColor: styles[cardId]?.backgroundColor || t.surface,
                      '--card-stagger': `${i * 85}ms`,
                    } as CSSProperties);

                    return (
                      <article
                        key={cardId}
                        data-component-id={cardId}
                        onClick={select(cardId)}
                        onMouseMove={(e) => handleTiltMove(e, 4.5, !motionEnabled)}
                        onMouseLeave={handleTiltLeave}
                        className={`service-card tilt-surface reveal-on-scroll is-visible${
                          mode === 'edit' ? ' is-editable' : ''
                        }${cardSelected ? ' is-selected' : ''}`}
                        style={cardStyle}
                      >
                        <div className="card-icon-badge" aria-hidden="true">
                          <CardIcon size={18} strokeWidth={1.8} />
                        </div>
                        <h3>{str(card.title, 'Card title')}</h3>
                        {str(card.body) ? <p>{str(card.body)}</p> : null}
                      </article>
                    );
                  })}
                </div>
              </section>
            );
          }

          case 'footer':
            return (
              <footer {...data} key={component.id} className={`${className} site-footer`}>
                <span>{str(p.text, 'Footer text')}</span>
                <div>
                  {arr(p.links).map((link, i) => (
                    <a
                      key={`${component.id}-link-${i}`}
                      href="#"
                      className="interactive-link"
                      onMouseMove={(e) => handleMagneticMove(e, 0.18, !motionEnabled)}
                      onMouseLeave={handleMagneticLeave}
                      onClick={mode === 'edit' ? (e) => e.preventDefault() : undefined}
                    >
                      {link}
                    </a>
                  ))}
                </div>
              </footer>
            );

          default:
            return null;
        }
      })}
    </div>
  );
}
