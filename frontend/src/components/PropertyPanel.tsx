import {
  COMPONENT_LABELS,
  FONTS,
  THEMES,
  type PageComponent,
  type StyleValues,
  type ThemeName,
} from '../schemas/page';

type Props = {
  selectedId: string;
  component?: PageComponent;
  isCard: boolean;
  styles: Record<string, StyleValues>;
  theme: ThemeName;
  onStyle: (id: string, patch: StyleValues) => void;
  onContent: (id: string, path: string, value: string) => void;
  onPageTitle: (value: string) => void;
  pageTitle: string;
};

const getPath = (object: Record<string, unknown>, path: string): string => {
  let current: unknown = object;
  for (const part of path.split('.')) {
    current =
      current && typeof current === 'object'
        ? (current as Record<string, unknown>)[part]
        : undefined;
  }
  return typeof current === 'string' ? current : '';
};

function Field({
  label,
  value,
  onChange,
  multiline = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  multiline?: boolean;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      {multiline ? (
        <textarea value={value} onChange={(e) => onChange(e.target.value)} rows={3} />
      ) : (
        <input value={value} onChange={(e) => onChange(e.target.value)} />
      )}
    </label>
  );
}

function ColorField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const valid = /^#[0-9a-fA-F]{6}$/.test(value);
  const changed = (v: string) => onChange(v.toUpperCase());
  return (
    <div className="field color-field">
      <span>{label}</span>
      <div className="color-row">
        <input
          aria-label={`${label} picker`}
          type="color"
          value={valid ? value : '#FFFFFF'}
          onChange={(e) => changed(e.target.value)}
        />
        <input
          aria-label={`${label} hex value`}
          className={valid ? '' : 'invalid'}
          value={value}
          maxLength={7}
          onChange={(e) => changed(e.target.value)}
          placeholder="#1A2B3C"
        />
      </div>
      {!valid && (
        <small className="field-error">Enter a six-digit hex color, such as #1A2B3C.</small>
      )}
    </div>
  );
}

export default function PropertyPanel({
  selectedId,
  component,
  isCard,
  styles,
  theme,
  onStyle,
  onContent,
  onPageTitle,
  pageTitle,
}: Props) {
  const s = styles[selectedId] || {};
  const set = (patch: StyleValues) => onStyle(selectedId, patch);
  const props = component?.props || {};
  const type = component?.type;
  const isPage = selectedId === 'page-background';
  const change = (path: string, value: string) => onContent(selectedId, path, value);
  const links = (key: string) =>
    Array.isArray(props[key]) ? (props[key] as string[]).join(', ') : '';
  const heading = isPage ? 'Page' : isCard ? 'Card' : type ? COMPONENT_LABELS[type] : 'Element';

  const contentFields = () => {
    if (isCard) {
      return (
        <>
          <Field label="Title" value={getPath(props, 'title')} onChange={(v) => change('title', v)} />
          <Field
            label="Description"
            value={getPath(props, 'body')}
            onChange={(v) => change('body', v)}
            multiline
          />
        </>
      );
    }
    if (!component) {
      return <p className="helper">Select an element in the preview to edit its content.</p>;
    }
    switch (type) {
      case 'navbar':
        return (
          <>
            <Field label="Brand" value={getPath(props, 'brand')} onChange={(v) => change('brand', v)} />
            <Field
              label="Links (comma separated)"
              value={links('links')}
              onChange={(v) => change('links', v)}
            />
            <Field
              label="Button label"
              value={getPath(props, 'ctaLabel')}
              onChange={(v) => change('ctaLabel', v)}
            />
          </>
        );
      case 'hero':
        return (
          <>
            <Field
              label="Eyebrow"
              value={getPath(props, 'eyebrow')}
              onChange={(v) => change('eyebrow', v)}
            />
            <Field
              label="Heading"
              value={getPath(props, 'heading')}
              onChange={(v) => change('heading', v)}
            />
            <Field
              label="Paragraph"
              value={getPath(props, 'body')}
              onChange={(v) => change('body', v)}
              multiline
            />
            <Field
              label="Button label"
              value={getPath(props, 'buttonLabel')}
              onChange={(v) => change('buttonLabel', v)}
            />
            <label className="field">
              <span>Alignment</span>
              <select
                value={getPath(props, 'alignment') || 'left'}
                onChange={(e) => change('alignment', e.target.value)}
              >
                <option value="left">Left</option>
                <option value="center">Center</option>
                <option value="right">Right</option>
              </select>
            </label>
          </>
        );
      case 'textSection':
        return (
          <>
            <Field
              label="Heading"
              value={getPath(props, 'heading')}
              onChange={(v) => change('heading', v)}
            />
            <Field
              label="Paragraph"
              value={getPath(props, 'body')}
              onChange={(v) => change('body', v)}
              multiline
            />
          </>
        );
      case 'imagePlaceholder':
        return (
          <Field label="Label" value={getPath(props, 'label')} onChange={(v) => change('label', v)} />
        );
      case 'button':
        return (
          <Field label="Label" value={getPath(props, 'label')} onChange={(v) => change('label', v)} />
        );
      case 'cardGrid':
        return (
          <>
            <Field
              label="Section heading"
              value={getPath(props, 'heading')}
              onChange={(v) => change('heading', v)}
            />
            <p className="helper">Select a card in the preview to edit its text.</p>
          </>
        );
      case 'footer':
        return (
          <>
            <Field label="Text" value={getPath(props, 'text')} onChange={(v) => change('text', v)} />
            <Field
              label="Links (comma separated)"
              value={links('links')}
              onChange={(v) => change('links', v)}
            />
          </>
        );
    }
  };

  return (
    <div className="property-panel" key={selectedId}>
      <div className="panel-header">
        <span className="panel-badge">{isPage ? 'Canvas' : isCard ? 'Card Item' : 'Component'}</span>
        <h2 className="panel-title">{heading}</h2>
      </div>
      <section className="property-section">
        <h3>Content</h3>
        {isPage ? (
          <Field label="Page title" value={pageTitle} onChange={onPageTitle} />
        ) : (
          contentFields()
        )}
      </section>
      <section className="property-section">
        <h3>Typography</h3>
        <label className="field">
          <span>Font</span>
          <select
            value={s.fontFamily || THEMES[theme].font}
            onChange={(e) => set({ fontFamily: e.target.value })}
          >
            {FONTS.map((f) => (
              <option key={f}>{f}</option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>
            Size <b>{s.fontSize || 16} px</b>
          </span>
          <input
            type="range"
            min="8"
            max="96"
            value={s.fontSize || 16}
            onChange={(e) => set({ fontSize: Number(e.target.value) })}
          />
        </label>
      </section>
      <section className="property-section">
        <h3>Color</h3>
        <ColorField
          label="Text"
          value={s.color || THEMES[theme].text}
          onChange={(v) => set({ color: v })}
        />
        <ColorField
          label="Background"
          value={s.backgroundColor || (isPage ? THEMES[theme].background : '#FFFFFF')}
          onChange={(v) => set({ backgroundColor: v })}
        />
        {type === 'cardGrid' || isCard ? (
          <ColorField
            label="Border"
            value={s.borderColor || THEMES[theme].border}
            onChange={(v) => set({ borderColor: v })}
          />
        ) : null}
        {['navbar', 'hero', 'button', 'cardGrid'].includes(type || '') && !isCard ? (
          <ColorField
            label="Accent"
            value={s.accentColor || THEMES[theme].accent}
            onChange={(v) => set({ accentColor: v })}
          />
        ) : null}
      </section>
    </div>
  );
}
