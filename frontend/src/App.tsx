import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, Check, Download, Eye, ImagePlus, LoaderCircle, MousePointer2, RotateCcw, Sparkles, WandSparkles, X } from 'lucide-react';
import PageRenderer, { aspectRatioValue } from './components/PageRenderer';
import PropertyPanel from './components/PropertyPanel';
import { generatePage, validateImage, MAX_PROMPT_CHARS } from './api/generate';
import { COMPONENT_LABELS, fontStack, isPageData, THEMES, type EditorDocument, type PageComponent, type PageData, type StyleValues, type ThemeName, uniqueId } from './schemas/page';
import samplePage from './mock/sample-page.json';

type Mode = 'edit' | 'preview';
const initialPage = samplePage as PageData;
function clone<T>(v: T): T { return structuredClone(v); }
function escapeHtml(s: string): string { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
function safeColor(value: string | undefined, fallback: string) { return value && /^#[0-9a-fA-F]{6}$/.test(value) ? value : fallback; }
function safeFont(value: string | undefined, fallback: string) { return value && ['Arial','Inter','Roboto','Georgia','Verdana','Poppins'].includes(value) ? value : fallback; }
function safeSize(value: number | undefined) { return typeof value === 'number' && Number.isFinite(value) ? Math.max(8,Math.min(96,value)) : undefined; }

function buildExport(doc: EditorDocument, theme: ThemeName): string {
  const t = THEMES[theme];
  const styles = doc.styles;
  const sketchLayout = doc.page.components.length === 4 && doc.page.components.filter(c => c.type === 'button').length === 2 && doc.page.components.filter(c => c.type === 'textSection').length === 2;
  const inline = (id: string, extra = '') => {
    const s = styles[id] || {};
    const bits = [`color:${safeColor(s.color,t.text)}`,`font-family:${fontStack(safeFont(s.fontFamily,t.font))}`,`font-size:${safeSize(s.fontSize) || 16}px`];
    if (s.backgroundColor && /^#[0-9a-fA-F]{6}$/.test(s.backgroundColor)) bits.push(`background-color:${s.backgroundColor}`);
    if (s.borderColor && /^#[0-9a-fA-F]{6}$/.test(s.borderColor)) bits.push(`border-color:${s.borderColor}`);
    if (s.accentColor && /^#[0-9a-fA-F]{6}$/.test(s.accentColor)) bits.push(`--element-accent:${s.accentColor}`);
    return [...bits,extra].filter(Boolean).join(';');
  };
  const a = (x: unknown) => Array.isArray(x) ? x.map(v=>escapeHtml(String(v))).join(', ') : '';
  const render = (c: PageComponent): string => {
    const p = c.props as Record<string, unknown>;
    const id = escapeHtml(c.id);
    switch(c.type) {
      case 'navbar': return `<nav id="${id}" style="${inline(c.id)}"><strong>${escapeHtml(String(p.brand||'brand'))}</strong><div>${a(p.links)}</div>${p.ctaLabel?`<span class="pill">${escapeHtml(String(p.ctaLabel))}</span>`:''}</nav>`;
      case 'hero': return `<section id="${id}" class="hero" style="${inline(c.id,`text-align:${['left','center','right'].includes(String(p.alignment))?String(p.alignment):'left'}`)}">${p.eyebrow?`<small>${escapeHtml(String(p.eyebrow))}</small>`:''}<h1>${escapeHtml(String(p.heading||''))}</h1>${p.body?`<p>${escapeHtml(String(p.body))}</p>`:''}${p.buttonLabel?`<span class="button">${escapeHtml(String(p.buttonLabel))}</span>`:''}</section>`;
      case 'textSection': return `<section id="${id}" class="${sketchLayout?'wireframe-panel':''}" style="${inline(c.id,sketchLayout?`grid-row:2;grid-column:${doc.page.components.filter(x=>x.type==='textSection').findIndex(x=>x.id===c.id)+1};min-width:0;max-width:none`:'')}"><h2>${escapeHtml(String(p.heading||''))}</h2><p>${escapeHtml(String(p.body||''))}</p></section>`;
      case 'imagePlaceholder': return `<div id="${id}" class="placeholder" style="${inline(c.id,`aspect-ratio:${aspectRatioValue(p.aspectRatio)}`)}">${escapeHtml(String(p.label||'Image'))}</div>`;
      case 'button': return `<section id="${id}" class="${sketchLayout?'wireframe-button':''}" style="${inline(c.id,sketchLayout?`grid-row:1;grid-column:${doc.page.components.filter(x=>x.type==='button').findIndex(x=>x.id===c.id)+1};justify-self:end;align-self:start`:'')}"><span class="button">${escapeHtml(String(p.label||'Button'))}</span></section>`;
      case 'cardGrid': return `<section id="${id}" style="${inline(c.id)}">${p.heading?`<h2>${escapeHtml(String(p.heading))}</h2>`:''}<div class="grid">${(Array.isArray(p.cards)?p.cards:[]).map((raw,i)=>{const card=raw as Record<string,unknown>;const cid=String(card.id||`${c.id}-card-${i+1}`);return `<article style="${inline(cid,`background:${safeColor(styles[cid]?.backgroundColor,t.surface)};border:1px solid ${safeColor(styles[cid]?.borderColor,t.border)}`)}"><h3>${escapeHtml(String(card.title||''))}</h3><p>${escapeHtml(String(card.body||''))}</p></article>`}).join('')}</div></section>`;
      case 'footer': return `<footer id="${id}" style="${inline(c.id)}"><span>${escapeHtml(String(p.text||''))}</span><div>${a(p.links)}</div></footer>`;
    }
  };
  const bg = styles['page-background'] || {};
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(doc.page.pageTitle)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Poppins:wght@400;500;600;700&family=Roboto:wght@400;500;700&display=swap" rel="stylesheet">
<style>
:root{--bg:${safeColor(bg.backgroundColor,t.background)};--surface:${t.surface};--text:${safeColor(bg.color,t.text)};--muted:${t.muted};--accent:${t.accent};--border:${t.border}}
*{box-sizing:border-box}main${sketchLayout?'.wireframe-layout':''}{${sketchLayout?'display:grid;grid-template-columns:repeat(2,minmax(0,1fr));column-gap:18px;row-gap:12px;padding-top:24px;':''}}.wireframe-panel{padding:22px 18px!important;border:1px solid var(--border);background:var(--surface);min-height:220px}.wireframe-button{padding:8px 0 14px!important}body{margin:0;background:var(--bg);color:var(--text);font-family:${fontStack(safeFont(bg.fontFamily,t.font))};line-height:1.6}main{max-width:1100px;margin:auto;padding:24px}nav,footer{display:flex;justify-content:space-between;align-items:center;gap:20px;padding:24px 0;border-bottom:1px solid var(--border)}footer{border-bottom:0;border-top:1px solid var(--border);margin-top:30px}nav div,footer div{display:flex;gap:16px;flex-wrap:wrap}.hero{padding:100px 4%;background:var(--surface);border-radius:24px;margin:20px 0}.hero h1{font-size:clamp(36px,6vw,64px);line-height:1.08;max-width:850px;margin:18px 0}.hero p,section>p{max-width:680px;color:var(--muted)}section{padding:32px 0}.hero small{color:var(--accent);font-weight:700}.button,.pill{display:inline-block;background:var(--accent);color:white;padding:12px 20px;border-radius:999px;margin-top:14px}.placeholder{margin:25px 0;min-height:160px;display:flex;align-items:center;justify-content:center;color:var(--muted);border:1px dashed var(--border);border-radius:18px;background:var(--surface)}.grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px}.grid article{padding:24px;border:1px solid var(--border);border-radius:18px;background:var(--surface)}.grid p{color:var(--muted)}h2{font-size:32px;letter-spacing:-.03em}@media(max-width:700px){main{padding:14px}main.wireframe-layout{grid-template-columns:1fr}.wireframe-panel{grid-row:auto!important;min-height:unset}.hero{padding:54px 24px}.grid{grid-template-columns:1fr}nav{flex-wrap:wrap}nav div{order:3;width:100%}}
</style></head><body><main${sketchLayout?' class="wireframe-layout"':''}>${doc.page.components.map(render).join('\n')}</main></body></html>`;
}

export default function App() {
  const [doc, setDoc] = useState<EditorDocument>(() => ({ page: clone(initialPage), styles: {} }));
  const [theme, setTheme] = useState<ThemeName>(initialPage.themeHint);
  const [selectedId, setSelectedId] = useState('hero-main');
  const [mode, setMode] = useState<Mode>('edit');
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
    for (const c of doc.page.components) if (c.type === 'cardGrid' && Array.isArray(c.props.cards)) {
      const cards = c.props.cards as Array<Record<string, unknown>>;
      const card = cards.find((x, i) => String(x.id || `${c.id}-card-${i + 1}`) === selectedId);
      if (card) return { component: c, card };
    }
    return null;
  }, [doc.page.components, selectedId]);
  const selectedComponent = cardSelection?.component || doc.page.components.find(c => c.id === selectedId);
  const selectedForPanel = cardSelection ? ({ id: selectedId, type: 'cardGrid', props: { title: cardSelection.card.title, body: cardSelection.card.body } } as PageComponent) : selectedComponent;
  const componentsWithIds = useMemo(() => {
    const used = new Set<string>();
    return doc.page.components.map(c => {
      const id = uniqueId(c.id, used);
      const props = { ...c.props };
      if (c.type === 'cardGrid' && Array.isArray(props.cards)) props.cards = (props.cards as Array<Record<string, unknown>>).map((card, i) => ({ ...card, id: uniqueId(typeof card.id === 'string' ? card.id : `${id}-card-${i + 1}`, used) }));
      return { ...c, id, props };
    });
  }, [doc.page.components]);
  const styleKeys = useMemo(() => ['page-background', ...componentsWithIds.flatMap(c => [c.id, ...(c.type === 'cardGrid' && Array.isArray(c.props.cards) ? (c.props.cards as Array<Record<string, unknown>>).map(x => String(x.id)) : [])])], [componentsWithIds]);

  useEffect(() => { if (!image) { setImageUrl(''); return; } const url = URL.createObjectURL(image); setImageUrl(url); return () => URL.revokeObjectURL(url); }, [image]);
  useEffect(() => { if (!styleKeys.includes(selectedId)) setSelectedId('page-background'); }, [styleKeys, selectedId]);

  function updateImage(file?: File) {
    if (!file) return;
    const message = validateImage(file);
    if (message) { setError(message); return; }
    setImage(file); setError(''); setNotice('');
  }
  async function generate() {
    if (!image) { setError('Upload a sketch first.'); return; }
    setGenerating(true); setError(''); setNotice('');
    try {
      const page = await generatePage(image, prompt);
      if (!isPageData(page)) throw new Error('The generated page does not match schema version 1.0.');
      setDoc({ page: clone(page), styles: {} }); setTheme(page.themeHint); setSelectedId(page.components[0]?.id || 'page-background');
      setMode('edit'); setIsSample(false); setNotice('Page generated. Select an element to edit it.');
    } catch (e) { setError(e instanceof Error ? e.message : 'Something went wrong. Please try again.'); }
    finally { setGenerating(false); }
  }
  function patchStyle(id: string, patch: StyleValues) {
    setDoc(prev => ({ ...prev, styles: { ...prev.styles, [id]: { ...prev.styles[id], ...patch } } }));
  }
  function patchContent(id: string, path: string, value: string) {
    setDoc(prev => {
      const page = clone(prev.page);
      const cardKey = (c: PageComponent, x: Record<string, unknown>, i: number) => String(x.id || `${c.id}-card-${i + 1}`);
      const cardHost = page.components.find(c => c.type === 'cardGrid' && Array.isArray(c.props.cards) && (c.props.cards as Array<Record<string, unknown>>).some((x, i) => cardKey(c, x, i) === id));
      if (cardHost) {
        const cards = cardHost.props.cards as Array<Record<string, unknown>>;
        const index = cards.findIndex((x, i) => cardKey(cardHost, x, i) === id);
        if (index >= 0) cards[index] = { ...cards[index], [path === 'title' ? 'title' : 'body']: value };
      } else {
        const c = page.components.find(x => x.id === id);
        if (c) {
          if (path === 'links') c.props.links = value.split(',').map(x => x.trim()).filter(Boolean);
          else c.props[path] = value;
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
    const link = document.createElement('a'); link.href = url; link.download = `${doc.page.pageTitle.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'visioncoder-page'}.html`;
    document.body.appendChild(link); link.click(); link.remove(); URL.revokeObjectURL(url);
    setNotice('HTML exported.');
  }
  function resetStyles() { setDoc(prev => ({ ...prev, styles: {} })); setTheme(doc.page.themeHint); setNotice('Style edits reset.'); }

  const selectedLabel = selectedId === 'page-background' ? 'Page' : cardSelection ? String(cardSelection.card.title || 'Card') : selectedComponent ? COMPONENT_LABELS[selectedComponent.type] : 'Element';
  const notes = doc.page.uncertainties.slice(0, 3);

  return <div className="app">
    <header className="topbar">
      <div className="app-brand"><WandSparkles size={18} aria-hidden /> Visioncoder</div>
      <button className="btn btn-primary" onClick={exportHtml}><Download size={16} aria-hidden /> Export HTML</button>
    </header>

    <div className="workspace">
      <aside className="sidebar" aria-label="Create">
        <section className="side-section">
          <h2>Sketch</h2>
          <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp" hidden onChange={e => { updateImage(e.target.files?.[0]); e.target.value = ''; }} />
          {image ? <div className="sketch-card">
            <img src={imageUrl} alt="Uploaded sketch" />
            <div className="sketch-meta"><strong title={image.name}>{image.name}</strong><span>{image.size < 1024 * 1024 ? `${Math.max(1, Math.round(image.size / 1024))} KB` : `${(image.size / 1024 / 1024).toFixed(1)} MB`}</span></div>
            <div className="sketch-actions">
              <button className="btn btn-quiet" onClick={() => fileRef.current?.click()}>Replace</button>
              <button className="btn btn-quiet" onClick={() => { setImage(null); setError(''); }}>Remove</button>
            </div>
          </div> : <button type="button" className={`dropzone${dragging ? ' dragging' : ''}`} onClick={() => fileRef.current?.click()}
            onDragOver={e => { e.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)}
            onDrop={e => { e.preventDefault(); setDragging(false); updateImage(e.dataTransfer.files[0]); }}>
            <ImagePlus size={22} aria-hidden />
            <strong>Upload a sketch</strong>
            <span>Drop an image here or browse. JPG, PNG or WebP, up to 8 MB.</span>
          </button>}

          <label className="field">
            <span>Instructions <em>(optional)</em></span>
            <textarea rows={3} maxLength={MAX_PROMPT_CHARS} value={prompt} onChange={e => setPrompt(e.target.value)} placeholder="For example: calm colors, spacious layout" />
            <small className="counter">{prompt.length} / {MAX_PROMPT_CHARS}</small>
          </label>
          <button className="btn btn-primary btn-block" disabled={generating || !image} onClick={generate}>
            {generating ? <><LoaderCircle className="spin" size={16} aria-hidden /> Generating…</> : <><Sparkles size={16} aria-hidden /> Generate website</>}
          </button>
          {error && <div className="message message-error" role="alert"><AlertCircle size={16} aria-hidden /><span>{error}</span></div>}
          {notice && <div className="message message-ok" role="status"><Check size={16} aria-hidden /><span>{notice}</span><button aria-label="Dismiss" onClick={() => setNotice('')}><X size={14} /></button></div>}
        </section>

        <section className="side-section">
          <h2>Theme</h2>
          <div className="theme-options" role="group" aria-label="Theme">
            {(Object.keys(THEMES) as ThemeName[]).map(key => <button key={key} aria-pressed={theme === key} className={`theme-option${theme === key ? ' active' : ''}`} onClick={() => switchTheme(key)}>
              <span className="swatch" style={{ background: THEMES[key].background, borderColor: THEMES[key].border }}><i style={{ background: THEMES[key].accent }} /><i style={{ background: THEMES[key].text }} /></span>
              {THEMES[key].label}
            </button>)}
          </div>
        </section>

        {doc.page.detectedElements.length > 0 && <section className="side-section">
          <h2>Detected in sketch</h2>
          <ul className="detected-list">{doc.page.detectedElements.map((item, i) => <li key={`${item.componentId}-${i}`}>
            <button disabled={!item.componentId} onClick={() => item.componentId && setSelectedId(item.componentId)}>{item.label}</button>
          </li>)}</ul>
          {notes.length > 0 && <div className="notes">{notes.map((n, i) => <p key={i}>{n}</p>)}</div>}
        </section>}
      </aside>

      <main className="stage">
        <div className="stage-bar">
          <div className="stage-title">
            <h1>{doc.page.pageTitle}</h1>
            {isSample && <p>Example page. Upload a sketch to generate your own.</p>}
          </div>
          <div className="stage-controls">
            <button className="btn btn-quiet" onClick={resetStyles} title="Remove all style edits"><RotateCcw size={15} aria-hidden /> Reset styles</button>
            <div className="segmented" role="group" aria-label="View">
              <button aria-pressed={mode === 'edit'} className={mode === 'edit' ? 'active' : ''} onClick={() => setMode('edit')}><MousePointer2 size={14} aria-hidden /> Edit</button>
              <button aria-pressed={mode === 'preview'} className={mode === 'preview' ? 'active' : ''} onClick={() => setMode('preview')}><Eye size={14} aria-hidden /> Preview</button>
            </div>
          </div>
        </div>
        <div className="canvas-frame">
          <div className="canvas-scroll"><PageRenderer components={componentsWithIds} styles={doc.styles} theme={theme} selectedId={selectedId} mode={mode} onSelect={setSelectedId} /></div>
        </div>
        <p className="stage-hint">{mode === 'edit' ? `Click an element to edit it. Selected: ${selectedLabel}.` : 'Preview mode. Switch to Edit to change the page.'}</p>
      </main>

      <aside className="inspector" aria-label="Properties">
        <PropertyPanel selectedId={selectedId} component={selectedForPanel} isCard={Boolean(cardSelection)} styles={doc.styles} theme={theme} onStyle={patchStyle} onContent={patchContent} pageTitle={doc.page.pageTitle} onPageTitle={value => setDoc(prev => ({ ...prev, page: { ...prev.page, pageTitle: value } }))} />
      </aside>
    </div>
  </div>;
}
