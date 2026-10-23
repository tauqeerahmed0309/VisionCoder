import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  Check,
  Download,
  Eye,
  ImagePlus,
  LoaderCircle,
  MousePointer2,
  RotateCcw,
  Sparkles,
  WandSparkles,
  Wind,
  X,
} from 'lucide-react';
import InteractiveCursor from './components/InteractiveCursor';
import PageRenderer, { aspectRatioValue } from './components/PageRenderer';
import PropertyPanel from './components/PropertyPanel';
import { generatePage, MAX_PROMPT_CHARS, validateImage } from './api/generate';
import samplePage from './mock/sample-page.json';
import {
  COMPONENT_LABELS,
  type EditorDocument,
  fontStack,
  isPageData,
  type PageComponent,
  type PageData,
  type StyleValues,
  THEMES,
  type ThemeName,
  uniqueId,
} from './schemas/page';
import { handleMagneticLeave, handleMagneticMove } from './utils/motion';

type Mode = 'edit' | 'preview';
const initialPage = samplePage as PageData;

function clone<T>(v: T): T {
  return structuredClone(v);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function safeColor(value: string | undefined, fallback: string) {
  return value && /^#[0-9a-fA-F]{6}$/.test(value) ? value : fallback;
}

function safeFont(value: string | undefined, fallback: string) {
  return value && ['Arial', 'Inter', 'Roboto', 'Georgia', 'Verdana', 'Poppins'].includes(value)
    ? value
    : fallback;
}

function safeSize(value: number | undefined) {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(8, Math.min(96, value))
    : undefined;
}

function buildExport(doc: EditorDocument, theme: ThemeName): string {
  const t = THEMES[theme];
  const styles = doc.styles;
  const sketchLayout =
    doc.page.components.length === 4 &&
    doc.page.components.filter((c) => c.type === 'button').length === 2 &&
    doc.page.components.filter((c) => c.type === 'textSection').length === 2;

  const inline = (id: string, extra = '') => {
    const s = styles[id] || {};
    const bits = [
      `color:${safeColor(s.color, t.text)}`,
      `font-family:${fontStack(safeFont(s.fontFamily, t.font))}`,
      `font-size:${safeSize(s.fontSize) || 16}px`,
    ];
    if (s.backgroundColor && /^#[0-9a-fA-F]{6}$/.test(s.backgroundColor)) {
      bits.push(`background-color:${s.backgroundColor}`);
    }
    if (s.borderColor && /^#[0-9a-fA-F]{6}$/.test(s.borderColor)) {
      bits.push(`border-color:${s.borderColor}`);
    }
    if (s.accentColor && /^#[0-9a-fA-F]{6}$/.test(s.accentColor)) {
      bits.push(`--element-accent:${s.accentColor}`);
    }
    return [...bits, extra].filter(Boolean).join(';');
  };

  const linksMarkup = (x: unknown) =>
    Array.isArray(x)
      ? x.map((v) => `<a href="#" class="nav-link magnetic">${escapeHtml(String(v))}</a>`).join('')
      : '';

  const render = (c: PageComponent): string => {
    const p = c.props as Record<string, unknown>;
    const id = escapeHtml(c.id);
    switch (c.type) {
      case 'navbar':
        return `<nav id="${id}" class="reveal" style="${inline(c.id)}"><strong class="brand"><span class="brand-dot"></span>${escapeHtml(String(p.brand || 'brand'))}</strong><div class="links">${linksMarkup(p.links)}</div>${p.ctaLabel ? `<a href="#" class="pill magnetic">${escapeHtml(String(p.ctaLabel))}</a>` : ''}</nav>`;
      case 'hero':
        return `<section id="${id}" class="hero tilt-card reveal" style="${inline(c.id, `text-align:${['left', 'center', 'right'].includes(String(p.alignment)) ? String(p.alignment) : 'left'}`)}"><div class="hero-orbs" aria-hidden="true"><span class="orb orb-a"></span><span class="orb orb-b"></span></div><div class="hero-inner">${p.eyebrow ? `<small class="eyebrow"><span class="pulse-dot"></span>${escapeHtml(String(p.eyebrow))}</small>` : ''}<h1>${escapeHtml(String(p.heading || ''))}</h1>${p.body ? `<p>${escapeHtml(String(p.body))}</p>` : ''}${p.buttonLabel ? `<a href="#" class="button magnetic">${escapeHtml(String(p.buttonLabel))} &rarr;</a>` : ''}</div></section>`;
      case 'textSection':
        return `<section id="${id}" class="reveal ${sketchLayout ? 'wireframe-panel' : ''}" style="${inline(c.id, sketchLayout ? `grid-row:2;grid-column:${doc.page.components.filter((x) => x.type === 'textSection').findIndex((x) => x.id === c.id) + 1};min-width:0;max-width:none` : '')}"><h2>${escapeHtml(String(p.heading || ''))}</h2><p>${escapeHtml(String(p.body || ''))}</p></section>`;
      case 'imagePlaceholder':
        return `<div id="${id}" class="placeholder tilt-card reveal" style="${inline(c.id, `aspect-ratio:${aspectRatioValue(p.aspectRatio)}`)}">${escapeHtml(String(p.label || 'Image'))}</div>`;
      case 'button':
        return `<section id="${id}" class="reveal ${sketchLayout ? 'wireframe-button' : ''}" style="${inline(c.id, sketchLayout ? `grid-row:1;grid-column:${doc.page.components.filter((x) => x.type === 'button').findIndex((x) => x.id === c.id) + 1};justify-self:end;align-self:start` : '')}"><a href="#" class="button magnetic">${escapeHtml(String(p.label || 'Button'))} &rarr;</a></section>`;
      case 'cardGrid':
        return `<section id="${id}" class="reveal" style="${inline(c.id)}">${p.heading ? `<h2>${escapeHtml(String(p.heading))}</h2>` : ''}<div class="grid">${(Array.isArray(p.cards) ? p.cards : []).map((raw, i) => { const card = raw as Record<string, unknown>; const cid = String(card.id || `${c.id}-card-${i + 1}`); return `<article class="tilt-card reveal" style="${inline(cid, `transition-delay:${i * 80}ms;background:${safeColor(styles[cid]?.backgroundColor, t.surface)};border:1px solid ${safeColor(styles[cid]?.borderColor, t.border)}`)}"><h3>${escapeHtml(String(card.title || ''))}</h3><p>${escapeHtml(String(card.body || ''))}</p></article>`; }).join('')}</div></section>`;
      case 'footer':
        return `<footer id="${id}" class="reveal" style="${inline(c.id)}"><span>${escapeHtml(String(p.text || ''))}</span><div class="links">${linksMarkup(p.links)}</div></footer>`;
    }
  };

  const bg = styles['page-background'] || {};
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(doc.page.pageTitle)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Poppins:wght@400;500;600;700&family=Roboto:wght@400;500;700&display=swap" rel="stylesheet">
<style>
:root{--bg:${safeColor(bg.backgroundColor, t.background)};--surface:${t.surface};--text:${safeColor(bg.color, t.text)};--muted:${t.muted};--accent:${t.accent};--border:${t.border};--cx:0;--cy:0}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font-family:${fontStack(safeFont(bg.fontFamily, t.font))};line-height:1.65;overflow-x:hidden}
main{max-width:1120px;margin:auto;padding:28px 24px 64px;position:relative;z-index:1}
main${sketchLayout ? '.wireframe-layout' : ''}{${sketchLayout ? 'display:grid;grid-template-columns:repeat(2,minmax(0,1fr));column-gap:18px;row-gap:12px;padding-top:24px;' : ''}}
.wireframe-panel{padding:22px 18px!important;border:1px solid var(--border);background:var(--surface);min-height:220px;border-radius:16px}
.wireframe-button{padding:8px 0 14px!important}
nav,footer{display:flex;justify-content:space-between;align-items:center;gap:20px;padding:22px 0;border-bottom:1px solid var(--border)}
footer{border-bottom:0;border-top:1px solid var(--border);margin-top:40px}
.brand{display:inline-flex;align-items:center;gap:8px;font-size:1.15rem}
.brand-dot{width:8px;height:8px;border-radius:50%;background:var(--accent)}
.links{display:flex;gap:24px;flex-wrap:wrap}
.nav-link{color:var(--muted);text-decoration:none;position:relative;padding:4px 0;transition:color .25s ease,transform .25s cubic-bezier(.22,1,.36,1)}
.nav-link::after{content:'';position:absolute;left:0;bottom:0;width:100%;height:1.5px;background:var(--accent);transform:scaleX(0);transform-origin:right;transition:transform .3s cubic-bezier(.22,1,.36,1)}
.nav-link:hover{color:var(--text)}
.nav-link:hover::after{transform:scaleX(1);transform-origin:left}
.hero{position:relative;overflow:hidden;padding:96px 5%;background:var(--surface);border:1px solid var(--border);border-radius:24px;margin:28px 0;box-shadow:0 20px 50px -20px rgba(15,23,42,.07)}
.hero-inner{position:relative;z-index:2}
.hero-orbs{position:absolute;inset:0;pointer-events:none;overflow:hidden}
.orb{position:absolute;border-radius:50%;filter:blur(48px);opacity:.18;transition:transform .2s ease-out}
.orb-a{width:280px;height:280px;background:var(--accent);top:-80px;right:-40px;transform:translate3d(calc(var(--cx)*-28px),calc(var(--cy)*-28px),0)}
.orb-b{width:220px;height:220px;background:var(--accent);bottom:-70px;left:10%;transform:translate3d(calc(var(--cx)*22px),calc(var(--cy)*22px),0)}
.hero h1{font-size:clamp(36px,5.5vw,60px);line-height:1.08;letter-spacing:-.03em;max-width:20ch;margin:16px 0}
.hero p,section>p{max-width:62ch;color:var(--muted);font-size:1.08rem}
section{padding:36px 0}
.eyebrow{display:inline-flex;align-items:center;gap:8px;color:var(--element-accent,var(--accent));font-weight:600;font-size:.9rem;padding:6px 14px;border-radius:999px;background:color-mix(in srgb,var(--element-accent,var(--accent)) 10%,transparent)}
.pulse-dot{width:6px;height:6px;border-radius:50%;background:currentColor}
.button,.pill{display:inline-flex;align-items:center;gap:8px;background:var(--element-accent,var(--accent));color:#fff;text-decoration:none;font-weight:600;padding:12px 24px;border-radius:999px;margin-top:16px;box-shadow:0 10px 24px -8px color-mix(in srgb,var(--element-accent,var(--accent)) 55%,transparent);transition:transform .25s cubic-bezier(.22,1,.36,1),box-shadow .25s ease}
.pill{margin-top:0;padding:9px 18px;font-size:.92rem}
.button:hover,.pill:hover{box-shadow:0 14px 28px -6px color-mix(in srgb,var(--element-accent,var(--accent)) 70%,transparent)}
.placeholder{margin:24px 0;min-height:180px;display:flex;align-items:center;justify-content:center;color:var(--muted);border:1px dashed var(--border);border-radius:20px;background:var(--surface)}
.grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:20px;margin-top:24px}
.grid article{padding:28px;border:1px solid var(--border);border-radius:20px;background:var(--surface);box-shadow:0 10px 30px -15px rgba(15,23,42,.05)}
.grid h3{margin:0 0 10px;font-size:1.2rem}
.grid p{margin:0;color:var(--muted)}
.tilt-card{transform:perspective(1000px) rotateX(var(--tx,0deg)) rotateY(var(--ty,0deg)) translateY(var(--lift,0px));transition:transform .35s cubic-bezier(.22,1,.36,1),box-shadow .35s ease,border-color .35s ease;will-change:transform}
.tilt-card:hover{--lift:-4px;border-color:color-mix(in srgb,var(--accent) 40%,var(--border))!important;box-shadow:0 22px 44px -16px rgba(15,23,42,.1)}
.reveal{opacity:0;transform:translateY(18px);transition:opacity .65s cubic-bezier(.22,1,.36,1),transform .65s cubic-bezier(.22,1,.36,1)}
.reveal.visible{opacity:1;transform:translateY(0)}
.cursor-dot,.cursor-ring{position:fixed;top:0;left:0;pointer-events:none;z-index:9999;border-radius:50%;opacity:0;transition:opacity .25s ease}
.cursor-dot{width:7px;height:7px;background:var(--accent)}
.cursor-ring{width:34px;height:34px;border:1.5px solid color-mix(in srgb,var(--accent) 45%,transparent);background:color-mix(in srgb,var(--accent) 4%,transparent)}
h2{font-size:clamp(26px,3.5vw,34px);letter-spacing:-.025em;margin:0 0 12px}
@media(max-width:768px){main{padding:16px}main.wireframe-layout{grid-template-columns:1fr}.wireframe-panel{grid-row:auto!important;min-height:unset}.hero{padding:56px 24px}.grid{grid-template-columns:1fr}nav{flex-wrap:wrap}.links{order:3;width:100%}.cursor-dot,.cursor-ring{display:none}}
@media(prefers-reduced-motion:reduce){.reveal{opacity:1;transform:none;transition:none}.tilt-card{transform:none!important}.cursor-dot,.cursor-ring{display:none}}
</style></head><body>
<div class="cursor-dot" id="cdot"></div><div class="cursor-ring" id="cring"></div>
<main${sketchLayout ? ' class="wireframe-layout"' : ''}>${doc.page.components.map(render).join('\n')}</main>
<script>
(function(){
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches || window.matchMedia('(pointer: coarse)').matches;
  const reveals = document.querySelectorAll('.reveal');
  if ('IntersectionObserver' in window && !reduced) {
    const io = new IntersectionObserver(entries => entries.forEach(e => { if (e.isIntersecting) e.target.classList.add('visible'); }), { threshold: 0.1 });
    reveals.forEach(el => io.observe(el));
  } else { reveals.forEach(el => el.classList.add('visible')); }
  if (reduced) return;
  const dot = document.getElementById('cdot'), ring = document.getElementById('cring');
  let tx = innerWidth / 2, ty = innerHeight / 2, rx = tx, ry = ty;
  window.addEventListener('mousemove', e => {
    tx = e.clientX; ty = e.clientY;
    dot.style.opacity = '1'; ring.style.opacity = '1';
    dot.style.transform = 'translate3d(' + tx + 'px,' + ty + 'px,0) translate(-50%,-50%)';
    document.documentElement.style.setProperty('--cx', ((tx / innerWidth - 0.5) * 2).toFixed(3));
    document.documentElement.style.setProperty('--cy', ((ty / innerHeight - 0.5) * 2).toFixed(3));
  }, { passive: true });
  (function loop(){
    rx += (tx - rx) * 0.15; ry += (ty - ry) * 0.15;
    ring.style.transform = 'translate3d(' + rx.toFixed(2) + 'px,' + ry.toFixed(2) + 'px,0) translate(-50%,-50%)';
    requestAnimationFrame(loop);
  })();
  document.querySelectorAll('.magnetic').forEach(el => {
    el.addEventListener('mousemove', e => {
      const r = el.getBoundingClientRect();
      el.style.transform = 'translate3d(' + ((e.clientX - (r.left + r.width / 2)) * 0.24).toFixed(2) + 'px,' + ((e.clientY - (r.top + r.height / 2)) * 0.24).toFixed(2) + 'px,0)';
    });
    el.addEventListener('mouseleave', () => { el.style.transform = ''; });
  });
  document.querySelectorAll('.tilt-card').forEach(el => {
    el.addEventListener('mousemove', e => {
      const r = el.getBoundingClientRect();
      const px = (e.clientX - r.left) / r.width - 0.5, py = (e.clientY - r.top) / r.height - 0.5;
      el.style.setProperty('--tx', (-py * 6).toFixed(2) + 'deg');
      el.style.setProperty('--ty', (px * 6).toFixed(2) + 'deg');
    });
    el.addEventListener('mouseleave', () => { el.style.setProperty('--tx', '0deg'); el.style.setProperty('--ty', '0deg'); });
  });
})();
</script></body></html>`;
}

export default function App() {
  const [doc, setDoc] = useState<EditorDocument>(() => ({ page: clone(initialPage), styles: {} }));
  const [theme, setTheme] = useState<ThemeName>(initialPage.themeHint);
  const [selectedId, setSelectedId] = useState('hero-main');
  const [mode, setMode] = useState<Mode>('edit');
  const [isPreviewFullscreen, setIsPreviewFullscreen] = useState(false);
  const [motionEnabled, setMotionEnabled] = useState(true);
  const [image, setImage] = useState<File | null>(null);
  const [imageUrl, setImageUrl] = useState('');
  const [prompt, setPrompt] = useState('');
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [isSample, setIsSample] = useState(true);
  const [dragging, setDragging] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const cardSelection = useMemo(() => {
    for (const c of doc.page.components) {
      if (c.type === 'cardGrid' && Array.isArray(c.props.cards)) {
        const cards = c.props.cards as Array<Record<string, unknown>>;
        const card = cards.find((x, i) => String(x.id || `${c.id}-card-${i + 1}`) === selectedId);
        if (card) return { component: c, card };
      }
    }
    return null;
  }, [doc.page.components, selectedId]);

  const selectedComponent =
    cardSelection?.component || doc.page.components.find((c) => c.id === selectedId);
  const selectedForPanel = cardSelection
    ? ({
        id: selectedId,
        type: 'cardGrid',
        props: { title: cardSelection.card.title, body: cardSelection.card.body },
      } as PageComponent)
    : selectedComponent;

  const componentsWithIds = useMemo(() => {
    const used = new Set<string>();
    return doc.page.components.map((c) => {
      const id = uniqueId(c.id, used);
      const props = { ...c.props };
      if (c.type === 'cardGrid' && Array.isArray(props.cards)) {
        props.cards = (props.cards as Array<Record<string, unknown>>).map((card, i) => ({
          ...card,
          id: uniqueId(typeof card.id === 'string' ? card.id : `${id}-card-${i + 1}`, used),
        }));
      }
      return { ...c, id, props };
    });
  }, [doc.page.components]);

  const styleKeys = useMemo(
    () => [
      'page-background',
      ...componentsWithIds.flatMap((c) => [
        c.id,
        ...(c.type === 'cardGrid' && Array.isArray(c.props.cards)
          ? (c.props.cards as Array<Record<string, unknown>>).map((x) => String(x.id))
          : []),
      ]),
    ],
    [componentsWithIds]
  );

  useEffect(() => {
    if (!isPreviewFullscreen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsPreviewFullscreen(false);
        setMode('edit');
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isPreviewFullscreen]);

  useEffect(() => {
    if (!image) {
      setImageUrl('');
      return;
    }
    const url = URL.createObjectURL(image);
    setImageUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [image]);

  useEffect(() => {
    if (!styleKeys.includes(selectedId)) setSelectedId('page-background');
  }, [styleKeys, selectedId]);

  function updateImage(file?: File) {
    if (!file) return;
    const message = validateImage(file);
    if (message) {
      setError(message);
      return;
    }
    setImage(file);
    setError('');
    setNotice('');
  }

  async function generate() {
    if (!image) {
      setError('Upload a sketch first.');
      return;
    }
    setGenerating(true);
    setError('');
    setNotice('');
    try {
      const page = await generatePage(image, prompt);
      if (!isPageData(page)) {
        throw new Error('The generated page does not match schema version 1.0.');
      }
      setDoc({ page: clone(page), styles: {} });
      setTheme(page.themeHint);
      setSelectedId(page.components[0]?.id || 'page-background');
      setMode('edit');
      setIsSample(false);
      setNotice('Page generated. Select an element to edit it.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong. Please try again.');
    } finally {
      setGenerating(false);
    }
  }

  function patchStyle(id: string, patch: StyleValues) {
    setDoc((prev) => ({
      ...prev,
      styles: { ...prev.styles, [id]: { ...prev.styles[id], ...patch } },
    }));
  }

  function patchContent(id: string, path: string, value: string) {
    setDoc((prev) => {
      const page = clone(prev.page);
      const cardKey = (c: PageComponent, x: Record<string, unknown>, i: number) =>
        String(x.id || `${c.id}-card-${i + 1}`);
      const cardHost = page.components.find(
        (c) =>
          c.type === 'cardGrid' &&
          Array.isArray(c.props.cards) &&
          (c.props.cards as Array<Record<string, unknown>>).some((x, i) => cardKey(c, x, i) === id)
      );
      if (cardHost) {
        const cards = cardHost.props.cards as Array<Record<string, unknown>>;
        const index = cards.findIndex((x, i) => cardKey(cardHost, x, i) === id);
        if (index >= 0) {
          cards[index] = { ...cards[index], [path === 'title' ? 'title' : 'body']: value };
        }
      } else {
        const c = page.components.find((x) => x.id === id);
        if (c) {
          if (path === 'links') {
            c.props.links = value
              .split(',')
              .map((x) => x.trim())
              .filter(Boolean);
          } else {
            c.props[path] = value;
          }
        }
      }
      return { ...prev, page };
    });
  }

  function switchTheme(next: ThemeName) {
    setTheme(next);
    setNotice(`${THEMES[next].label} theme applied. Your edits are kept.`);
  }

  function exportHtml() {
    const html = buildExport(doc, theme);
    const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${
      doc.page.pageTitle
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '') || 'visioncoder-page'
    }.html`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    setNotice('HTML exported.');
  }

  function resetStyles() {
    setDoc((prev) => ({ ...prev, styles: {} }));
    setTheme(doc.page.themeHint);
    setNotice('Style edits reset.');
  }

  const selectedLabel =
    selectedId === 'page-background'
      ? 'Page'
      : cardSelection
        ? String(cardSelection.card.title || 'Card')
        : selectedComponent
          ? COMPONENT_LABELS[selectedComponent.type]
          : 'Element';
  const notes = doc.page.uncertainties.slice(0, 3);

  return (
    <div className={`app${!motionEnabled ? ' app-reduced-motion' : ''}${isPreviewFullscreen ? ' app-preview-fullscreen' : ''}`}>
      <style>{`
        .app-preview-fullscreen .topbar,
        .app-preview-fullscreen .sidebar,
        .app-preview-fullscreen .inspector { display: none !important; }
        .app-preview-fullscreen .workspace { display: block !important; height: 100vh; min-height: 100vh; }
        .app-preview-fullscreen .stage {
          position: fixed; inset: 0; z-index: 10000; width: 100vw; height: 100vh;
          max-width: none; min-width: 0; margin: 0; padding: 12px 18px 18px;
          box-sizing: border-box; display: flex; flex-direction: column; gap: 10px;
          background: var(--app-bg, #f5f7fb);
        }
        .app-preview-fullscreen .stage-bar { flex: 0 0 auto; margin: 0; }
        .app-preview-fullscreen .stage-title p,
        .app-preview-fullscreen .stage-controls > .btn:not(.preview-exit),
        .app-preview-fullscreen .stage-controls .segmented,
        .app-preview-fullscreen .stage-hint { display: none !important; }
        .app-preview-fullscreen .stage-controls .preview-exit { display: inline-flex !important; }
        .app-preview-fullscreen .canvas-frame {
          flex: 1 1 auto; min-height: 0; height: auto; margin: 0; overflow: hidden;
        }
        .app-preview-fullscreen .canvas-scroll {
          width: 100%; height: 100%; max-height: none; min-height: 0; overflow: auto;
        }
        .app-preview-fullscreen .canvas-scroll > .site-canvas { min-height: 100%; }
        @media (max-width: 700px) {
          .app-preview-fullscreen .stage { padding: 8px; }
          .app-preview-fullscreen .stage-title h1 { font-size: 1rem; }
        }
      `}</style>
      <InteractiveCursor motionEnabled={motionEnabled} />

      <header className="topbar">
        <div className="app-brand">
          <span className="brand-icon-wrap">
            <WandSparkles size={17} aria-hidden />
          </span>
          <span>Visioncoder</span>
        </div>

        <div className="topbar-actions">
          <button
            type="button"
            className={`btn btn-quiet motion-toggle${motionEnabled ? ' is-active' : ''}`}
            aria-pressed={motionEnabled}
            onClick={() => setMotionEnabled((v) => !v)}
            onMouseMove={(e) => handleMagneticMove(e, 0.2, !motionEnabled)}
            onMouseLeave={handleMagneticLeave}
            title="Toggle interactive cursor and floating physics"
          >
            <Wind size={15} aria-hidden />
            <span>{motionEnabled ? 'Motion: On' : 'Motion: Reduced'}</span>
          </button>

          <button
            className="btn btn-primary"
            onClick={exportHtml}
            onMouseMove={(e) => handleMagneticMove(e, 0.24, !motionEnabled)}
            onMouseLeave={handleMagneticLeave}
          >
            <Download size={16} aria-hidden /> Export HTML
          </button>
        </div>
      </header>

      <div className={`workspace${isPreviewFullscreen ? ' workspace-preview-fullscreen' : ''}`}>
        <aside className="sidebar" aria-label="Create">
          <section className="side-section">
            <h2>Sketch</h2>
            <input
              ref={fileRef}
              type="file"
              accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp"
              hidden
              onChange={(e) => {
                updateImage(e.target.files?.[0]);
                e.target.value = '';
              }}
            />
            {image ? (
              <div className="sketch-card">
                <img src={imageUrl} alt="Uploaded sketch" />
                <div className="sketch-meta">
                  <strong title={image.name}>{image.name}</strong>
                  <span>
                    {image.size < 1024 * 1024
                      ? `${Math.max(1, Math.round(image.size / 1024))} KB`
                      : `${(image.size / 1024 / 1024).toFixed(1)} MB`}
                  </span>
                </div>
                <div className="sketch-actions">
                  <button className="btn btn-quiet" onClick={() => fileRef.current?.click()}>
                    Replace
                  </button>
                  <button
                    className="btn btn-quiet"
                    onClick={() => {
                      setImage(null);
                      setError('');
                    }}
                  >
                    Remove
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                className={`dropzone${dragging ? ' dragging' : ''}`}
                onClick={() => fileRef.current?.click()}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragging(true);
                }}
                onDragLeave={() => setDragging(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragging(false);
                  updateImage(e.dataTransfer.files[0]);
                }}
              >
                <div className="dropzone-icon">
                  <ImagePlus size={22} aria-hidden />
                </div>
                <strong>Upload a sketch</strong>
                <span>Drop an image here or browse. JPG, PNG or WebP, up to 8 MB.</span>
              </button>
            )}

            <label className="field">
              <span>
                Instructions <em>(optional)</em>
              </span>
              <textarea
                rows={3}
                maxLength={MAX_PROMPT_CHARS}
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="For example: calm colors, spacious layout"
              />
              <small className="counter">
                {prompt.length} / {MAX_PROMPT_CHARS}
              </small>
            </label>
            <button
              className="btn btn-primary btn-block"
              disabled={generating || !image}
              onClick={generate}
              onMouseMove={(e) => handleMagneticMove(e, 0.2, !motionEnabled || generating || !image)}
              onMouseLeave={handleMagneticLeave}
            >
              {generating ? (
                <>
                  <LoaderCircle className="spin" size={16} aria-hidden /> Generating…
                </>
              ) : (
                <>
                  <Sparkles size={16} aria-hidden /> Generate website
                </>
              )}
            </button>
            {error && (
              <div className="message message-error" role="alert">
                <AlertCircle size={16} aria-hidden />
                <span>{error}</span>
              </div>
            )}
            {notice && (
              <div className="message message-ok" role="status">
                <Check size={16} aria-hidden />
                <span>{notice}</span>
                <button aria-label="Dismiss" onClick={() => setNotice('')}>
                  <X size={14} />
                </button>
              </div>
            )}
          </section>

          <section className="side-section">
            <h2>Theme</h2>
            <div className="theme-options" role="group" aria-label="Theme">
              {(Object.keys(THEMES) as ThemeName[]).map((key) => (
                <button
                  key={key}
                  aria-pressed={theme === key}
                  className={`theme-option${theme === key ? ' active' : ''}`}
                  onClick={() => switchTheme(key)}
                  onMouseMove={(e) => handleMagneticMove(e, 0.16, !motionEnabled)}
                  onMouseLeave={handleMagneticLeave}
                >
                  <span
                    className="swatch"
                    style={{ background: THEMES[key].background, borderColor: THEMES[key].border }}
                  >
                    <i style={{ background: THEMES[key].accent }} />
                    <i style={{ background: THEMES[key].text }} />
                  </span>
                  {THEMES[key].label}
                </button>
              ))}
            </div>
          </section>

          {doc.page.detectedElements.length > 0 && (
            <section className="side-section">
              <h2>Detected in sketch</h2>
              <ul className="detected-list">
                {doc.page.detectedElements.map((item, i) => (
                  <li key={`${item.componentId}-${i}`}>
                    <button
                      disabled={!item.componentId}
                      className={item.componentId === selectedId ? 'active' : ''}
                      onClick={() => item.componentId && setSelectedId(item.componentId)}
                    >
                      <span className="detected-dot" aria-hidden="true" />
                      {item.label}
                    </button>
                  </li>
                ))}
              </ul>
              {notes.length > 0 && (
                <div className="notes">
                  {notes.map((n, i) => (
                    <p key={i}>{n}</p>
                  ))}
                </div>
              )}
            </section>
          )}
        </aside>

        <main className="stage">
          <div className="stage-bar">
            <div className="stage-title">
              <h1>{doc.page.pageTitle}</h1>
              {isSample && <p>Example page. Upload a sketch to generate your own.</p>}
            </div>
            <div className="stage-controls">
              {isPreviewFullscreen && (
                <button
                  type="button"
                  className="btn btn-primary preview-exit"
                  onClick={() => {
                    setIsPreviewFullscreen(false);
                    setMode('edit');
                  }}
                  title="Exit fullscreen preview (Esc)"
                >
                  <X size={15} aria-hidden /> Exit Preview
                </button>
              )}
              <button
                className="btn btn-quiet"
                onClick={resetStyles}
                title="Remove all style edits"
                onMouseMove={(e) => handleMagneticMove(e, 0.18, !motionEnabled)}
                onMouseLeave={handleMagneticLeave}
              >
                <RotateCcw size={15} aria-hidden /> Reset styles
              </button>
              <div className="segmented" role="group" aria-label="View">
                <button
                  aria-pressed={mode === 'edit'}
                  className={mode === 'edit' ? 'active' : ''}
                  onClick={() => setMode('edit')}
                >
                  <MousePointer2 size={14} aria-hidden /> Edit
                </button>
                <button
                  aria-pressed={mode === 'preview'}
                  className={mode === 'preview' ? 'active' : ''}
                  onClick={() => {
                    setMode('preview');
                    setIsPreviewFullscreen(true);
                  }}
                >
                  <Eye size={14} aria-hidden /> Preview
                </button>
              </div>
            </div>
          </div>

          <div className="canvas-frame">
            <div className="canvas-scroll">
              <PageRenderer
                components={componentsWithIds}
                styles={doc.styles}
                theme={theme}
                selectedId={selectedId}
                mode={mode}
                onSelect={setSelectedId}
                motionEnabled={motionEnabled}
              />
            </div>
          </div>
          <p className="stage-hint">
            {mode === 'edit'
              ? `Click an element to edit it. Selected: ${selectedLabel}.`
              : 'Preview mode. Move your cursor across the hero, cards, and buttons to experience the live interaction.'}
          </p>
        </main>

        <aside className="inspector" aria-label="Properties">
          <PropertyPanel
            selectedId={selectedId}
            component={selectedForPanel}
            isCard={Boolean(cardSelection)}
            styles={doc.styles}
            theme={theme}
            onStyle={patchStyle}
            onContent={patchContent}
            pageTitle={doc.page.pageTitle}
            onPageTitle={(value) =>
              setDoc((prev) => ({ ...prev, page: { ...prev.page, pageTitle: value } }))
            }
          />
        </aside>
      </div>
    </div>
  );
}
