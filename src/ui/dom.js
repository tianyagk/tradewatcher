/** DOM 小工具：元素创建、toast、模态、事件。 */

export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export const qs = (sel, root = document) => root.querySelector(sel);
export const qsa = (sel, root = document) => [...root.querySelectorAll(sel)];

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

export function mount(el, ...children) {
  clear(el);
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}

/** SVG 元素创建（命名空间） */
export function s(tag, attrs = {}, ...children) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === null || v === undefined || v === false) continue;
    el.setAttribute(k, String(v));
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

/* ── Toast ───────────────────────────────────────────────────────────── */

let toastBox = null;
export function toast(message, ms = 2000) {
  if (!toastBox) {
    toastBox = h('div', { class: 'tw-toasts' });
    document.body.append(toastBox);
  }
  const node = h('div', { class: 'tw-toast', text: String(message) });
  toastBox.append(node);
  setTimeout(() => {
    node.style.transition = 'opacity .2s';
    node.style.opacity = '0';
    setTimeout(() => node.remove(), 220);
  }, ms);
}

/* ── 模态 ────────────────────────────────────────────────────────────── */

/**
 * 通用模态。fields: [{key,label,type,value,options,placeholder,required}]
 * 返回 Promise<Record|null>
 */
export function promptModal({ title, fields = [], okText = '确定', cancelText = '取消', width = 360 }) {
  return new Promise((resolve) => {
    const inputs = {};
    const body = h('div', { class: 'tw-col tw-gap10' });
    for (const f of fields) {
      const id = `f_${f.key}`;
      let input;
      if (f.type === 'select') {
        input = h('select', { class: 'tw-select', id });
        for (const o of f.options ?? []) input.append(h('option', { value: o.value, selected: String(o.value) === String(f.value ?? '') }, o.label));
      } else if (f.type === 'textarea') {
        input = h('textarea', { class: 'tw-input', id, rows: f.rows ?? 3, placeholder: f.placeholder ?? '' });
        input.value = f.value ?? '';
      } else {
        input = h('input', { class: 'tw-input', id, type: f.type ?? 'text', placeholder: f.placeholder ?? '', min: f.min, step: f.step, max: f.max });
        input.value = f.value ?? '';
      }
      inputs[f.key] = input;
      body.append(h('div', { class: 'tw-field' }, h('label', { for: id, text: f.label }), input, f.hint ? h('div', { class: 'tw-hint', text: f.hint }) : null));
    }
    const close = (val) => {
      mask.remove();
      document.removeEventListener('keydown', onKey);
      resolve(val);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') close(null);
      if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA') submit();
    };
    const submit = () => {
      const out = {};
      for (const f of fields) {
        const raw = inputs[f.key].value;
        if (f.type === 'number') {
          const n = Number(raw);
          if (raw === '' || !Number.isFinite(n)) {
            if (f.required) {
              inputs[f.key].focus();
              return;
            }
            out[f.key] = null;
          } else out[f.key] = n;
        } else if (f.type === 'checkbox') {
          out[f.key] = inputs[f.key].checked;
        } else {
          out[f.key] = raw.trim();
        }
      }
      close(out);
    };
    const mask = h(
      'div',
      { class: 'tw-modal-mask', onclick: (e) => e.target === mask && close(null) },
      h(
        'div',
        { class: 'tw-modal', style: { width: `${width}px` } },
        h('div', { class: 'tw-modal-h', text: title }),
        h('div', { class: 'tw-modal-b' }, body),
        h(
          'div',
          { class: 'tw-modal-f' },
          h('button', { class: 'tw-btn', onclick: () => close(null) }, cancelText),
          h('button', { class: 'tw-btn primary', onclick: submit }, okText),
        ),
      ),
    );
    document.body.append(mask);
    document.addEventListener('keydown', onKey);
    const first = Object.values(inputs)[0];
    if (first) setTimeout(() => first.focus(), 20);
  });
}

export function confirmModal(title, message) {
  return new Promise((resolve) => {
    const done = (v) => {
      mask.remove();
      resolve(v);
    };
    const mask = h(
      'div',
      { class: 'tw-modal-mask', onclick: (e) => e.target === mask && done(false) },
      h(
        'div',
        { class: 'tw-modal', style: { width: '340px' } },
        h('div', { class: 'tw-modal-h', text: title }),
        h('div', { class: 'tw-modal-b', text: message }),
        h(
          'div',
          { class: 'tw-modal-f' },
          h('button', { class: 'tw-btn', onclick: () => done(false) }, '取消'),
          h('button', { class: 'tw-btn primary', onclick: () => done(true) }, '确定'),
        ),
      ),
    );
    document.body.append(mask);
  });
}

export function debounce(fn, wait = 220) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

/** 应用偏好到 <html>（主题 / 极简 / 透明度 / 虚化） */
export function applyPrefs(prefs) {
  const root = document.documentElement;
  const theme = prefs.theme === 'auto' ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : prefs.theme;
  root.dataset.theme = theme;
  root.dataset.mask = prefs.maskMode ? '1' : '0';
  root.style.setProperty('--tw-opacity', String(Math.min(100, Math.max(40, prefs.opacity ?? 100)) / 100));
  root.style.setProperty('--tw-blur', `${prefs.blur ?? 0}px`);
  root.dataset.opacity = String(prefs.opacity ?? 100);
  root.dataset.blurOn = (prefs.blur ?? 0) > 0 ? '1' : '0';
}

export function watchSystemTheme(cb) {
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  const handler = () => cb();
  mq.addEventListener('change', handler);
  return () => mq.removeEventListener('change', handler);
}
