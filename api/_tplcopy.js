'use strict';
// Text-slot engine for the 100 templates (api/_templates).
// The small "backup" AIs cannot write a whole page, so they only rewrite TEXT: this file cuts every visible text of a template
// (and the safe text strings inside its JavaScript) into small numbered groups, and puts the rewritten texts back.
// Layout, CSS classes and scripts are never touched, so the result looks exactly like the template.

const INLINE = new Set(['b', 'strong', 'i', 'em', 'span', 'small', 'sup', 'sub', 'mark', 'u', 'br', 'code', 'abbr', 'time', 'wbr', 's', 'del', 'ins', 'kbd']);
const ENT = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'", '&nbsp;': '\u00a0' };
const decode = (s) => s.replace(/&(amp|lt|gt|quot|apos|nbsp|#39);|&#(\d+);|&#x([0-9a-f]+);/gi, (m, a, d, h) => {
  if (a) return ENT['&' + a.toLowerCase() + ';'];
  const cp = d ? Number(d) : parseInt(h, 16);
  return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
});
const escText = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = (s) => escText(s).replace(/"/g, '&quot;');
const hasText = (s) => /[\p{L}\p{N}]/u.test(s);

function tokenize(html) {
  const re = /<!--[\s\S]*?-->|<(svg|style|script|textarea)\b[\s\S]*?<\/\1>|<\/?[a-zA-Z][^>"']*(?:(?:"[^"]*"|'[^']*')[^>"']*)*>|[^<]+|</g;
  const out = [];
  let m;
  while ((m = re.exec(html))) {
    const s = m[0];
    out.push({ type: s.startsWith('<!--') || m[1] ? 'raw' : s.length > 1 && s[0] === '<' ? 'tag' : 'text', s });
  }
  return out;
}

// ---- JavaScript text strings: only strings that clearly are human text, never ids, selectors, events or keys ----
const JS_LIT = /(?<![\w$.])(?:'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)")/g;
const JS_KEYS = new Set(['Escape', 'Enter', 'Tab', 'Space', 'Home', 'End', 'Backspace', 'Delete', 'Shift', 'Control', 'Alt', 'Meta', 'Esc', 'Click', 'Submit', 'None', 'True', 'False', 'Null', 'Undefined', 'Infinity', 'GET', 'POST']);
const CTX_BAD = /(querySelector(All)?|getElementById|getElementsBy\w+|classList\.\w+|addEventListener|removeEventListener|matches|closest|getAttribute|setAttribute|removeAttribute|hasAttribute|createElement|dispatchEvent|CustomEvent|localStorage\.\w+|sessionStorage\.\w+|matchMedia|dataset|style\.\w+|require|import)\s*\([^()]*$|\b(case|typeof)\s*$|(===?|!==?)\s*$|\.(key|code|type|tagName)\s*(===?|!==?)\s*$/;
function jsTexty(s) {
  if (s.length < 2 || s.length > 140 || /[\\<>{}=\[\]();`]|https?:|^[.#/@]/.test(s) || JS_KEYS.has(s) || /^[A-Z][a-z]+[A-Z]/.test(s)) return false;
  if (/\s/.test(s)) return /\p{L}{3}/u.test(s);
  return /^[A-Z\u00C0-\u024F][a-z\u00C0-\u024F]{2,}$/.test(s);
}
const jsOk = (s, src, off) => jsTexty(s) && !CTX_BAD.test(src.slice(Math.max(0, off - 80), off));

const cache = new Map();
function buildSlots(tpl) {
  if (cache.has(tpl.id)) return cache.get(tpl.id);
  const tokens = tokenize(tpl.html), groups = [];
  let cur = null, blockTag = 'body';
  const close = () => { if (cur && cur.items.length) groups.push(cur); cur = null; };
  tokens.forEach((t, i) => {
    if (t.type === 'raw') { close(); return; }
    if (t.type === 'tag') {
      const tm = t.s.match(/^<(\/?)([a-zA-Z][a-zA-Z0-9-]*)/);
      const name = tm[2].toLowerCase(), closing = !!tm[1];
      if (INLINE.has(name)) return;
      close();
      if (closing) return;
      blockTag = name;
      for (const am of t.s.matchAll(/\s(alt|placeholder|title)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
        const v = decode(am[2] !== undefined ? am[2] : am[3]).replace(/\s+/g, ' ').trim();
        if (hasText(v)) groups.push({ tag: name + '.' + am[1].toLowerCase(), items: [{ i, attr: am[1].toLowerCase(), text: v }] });
      }
      return;
    }
    const lead = t.s.match(/^\s*/)[0], trail = t.s.slice(lead.length).match(/\s*$/)[0];
    const core = decode(t.s.slice(lead.length, t.s.length - trail.length)).replace(/\s+/g, ' ');
    if (!core || !hasText(core)) return;
    if (!cur) cur = { tag: blockTag, items: [] };
    cur.items.push({ i, text: core, lead, trail });
  });
  close();
  const attrVals = new Set(); // values of data-*, value, id ... attributes: scripts look these up, so equal JS strings stay unchanged
  tokens.forEach((x) => { if (x.type === 'tag') for (const am of x.s.matchAll(/\s([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) if (!/^(alt|placeholder|title)$/i.test(am[1])) attrVals.add(decode(am[2] !== undefined ? am[2] : am[3]).trim()); });
  const lits = [], seen = new Set();
  const js = tpl.javascript || '';
  const idents = new Set(); // words the script also uses as bare keys or properties ({Spanish:[...]}, obj.Spanish): never rename their quoted twins
  for (const m of js.matchAll(/[{,]\s*([A-Za-z_$][\w$]*)\s*:|\.([A-Za-z_$][\w$]*)/g)) idents.add(m[1] || m[2]);
  js.replace(JS_LIT, (m, a, b, off) => {
    const s = a !== undefined ? a : b;
    if (!seen.has(s) && jsOk(s, js, off) && !attrVals.has(s.trim()) && !idents.has(s.trim())) { seen.add(s); lits.push(s); }
    return m;
  });
  lits.forEach((s) => { if (hasText(s)) groups.push({ tag: 'js', items: [{ js: true, orig: s, text: s.trim().replace(/\s+/g, ' ') }] }); });
  const res = { tokens, groups };
  cache.set(tpl.id, res);
  return res;
}

function slotInfo(tpl) {
  const { groups } = buildSlots(tpl);
  const batches = [];
  let cur = [], chars = 0;
  groups.forEach((g, id) => {
    const n = g.items.reduce((a, x) => a + x.text.length, 0) + 12;
    if (cur.length && (chars + n > 2400 || cur.length >= 40)) { batches.push(cur); cur = []; chars = 0; }
    cur.push(id); chars += n;
  });
  if (cur.length) batches.push(cur);
  return { n: groups.length, groups, batches };
}

// CSS colour variables of the template (name -> current value), so the AI can recolour it when the user asks for it
function rootVars(tpl) {
  const out = {};
  for (const m of (tpl.css || '').matchAll(/:root\s*\{([^}]*)\}/g)) for (const x of m[1].matchAll(/(--[\w-]+)\s*:\s*(#[0-9a-fA-F]{3}|#[0-9a-fA-F]{6})\s*(?:;|$)/g)) out[x[1]] = x[2];
  return out;
}
// images and shared libraries (Bootstrap ...) of the added templates live in api/_tplres.js and are put back when the site is built
let tplRes = null;
function expandRes(s) {
  if (!/__SP(IMG|LIB)_/.test(s)) return s;
  if (!tplRes) { try { tplRes = require('./_tplres.js'); } catch (e) { tplRes = { img: {}, lib: {} }; } }
  for (let i = 0; i < 3 && /__SPLIB_/.test(s); i++) s = s.replace(/\/\*__SPLIB_([0-9a-f]{10})__\*\//g, (m, k) => tplRes.lib[k] || '');
  return s.replace(/__SPIMG_([0-9a-f]{10})__/g, (m, k) => tplRes.img[k] || 'data:,');
}
function cleanVars(tpl, vars) {
  const allowed = rootVars(tpl), out = {};
  if (vars && typeof vars === 'object') for (const [k, v] of Object.entries(vars)) if (allowed[k] && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(String(v))) out[k] = String(v);
  return guardVars(tpl, out);
}
function themeOf(tpl, vars) {
  const v = { ...rootVars(tpl), ...cleanVars(tpl, vars) }, names = Object.keys(v);
  const pick = (re, d) => { const n = names.find((x) => re.test(x)); return n ? v[n] : d; };
  return { primaryColor: pick(/^--(pr|primary|ac|accent|br|brand)/i, v[names[0]] || '#2563eb'), backgroundColor: pick(/^--(bg|background|paper|white|surface)/i, '#ffffff'), textColor: pick(/^--(tx|text|ink|fg)/i, '#111111'), fontFamily: 'system-ui, sans-serif' };
}

// ---- Look variety: every site gets its own palette and font pair on top of the template ----
const FONT_PAIRS = [
  { id: 'elegant', mood: 'elegant, premium', h: ['Playfair Display', 'wght@500;700'], b: ['Inter', 'wght@400;600'], hf: 'serif', bf: 'sans-serif' },
  { id: 'modern', mood: 'modern, friendly', h: ['Poppins', 'wght@600;700'], b: ['Poppins', 'wght@400;500'], hf: 'sans-serif', bf: 'sans-serif' },
  { id: 'tech', mood: 'techy, sharp', h: ['Space Grotesk', 'wght@500;700'], b: ['Inter', 'wght@400;600'], hf: 'sans-serif', bf: 'sans-serif' },
  { id: 'editorial', mood: 'editorial, stylish', h: ['DM Serif Display', ''], b: ['DM Sans', 'wght@400;500;700'], hf: 'serif', bf: 'sans-serif' },
  { id: 'clean', mood: 'clean, corporate', h: ['Montserrat', 'wght@600;800'], b: ['Open Sans', 'wght@400;600'], hf: 'sans-serif', bf: 'sans-serif' },
  { id: 'sporty', mood: 'bold, sporty, energetic', h: ['Bebas Neue', ''], b: ['Roboto', 'wght@400;500;700'], hf: 'sans-serif', bf: 'sans-serif' },
  { id: 'warm', mood: 'warm, homely', h: ['Lora', 'wght@500;700'], b: ['Nunito Sans', 'wght@400;700'], hf: 'serif', bf: 'sans-serif' },
  { id: 'soft', mood: 'soft, calm, wellness', h: ['Fraunces', 'wght@500;700'], b: ['Manrope', 'wght@400;600'], hf: 'serif', bf: 'sans-serif' },
  { id: 'minimal', mood: 'minimal, light', h: ['Outfit', 'wght@500;700'], b: ['Outfit', 'wght@300;400;500'], hf: 'sans-serif', bf: 'sans-serif' },
  { id: 'luxury', mood: 'luxury, fashion', h: ['Cormorant Garamond', 'wght@500;700'], b: ['Jost', 'wght@400;500'], hf: 'serif', bf: 'sans-serif' },
  { id: 'playful', mood: 'playful, kids, fun', h: ['Rubik', 'wght@500;700'], b: ['Rubik', 'wght@400;500'], hf: 'sans-serif', bf: 'sans-serif' },
  { id: 'startup', mood: 'startup, product', h: ['Sora', 'wght@600;700'], b: ['Inter', 'wght@400;600'], hf: 'sans-serif', bf: 'sans-serif' },
  { id: 'street', mood: 'streetwear, loud', h: ['Archivo Black', ''], b: ['Archivo', 'wght@400;600'], hf: 'sans-serif', bf: 'sans-serif' },
  { id: 'trust', mood: 'trustworthy, professional', h: ['Merriweather', 'wght@700'], b: ['Source Sans 3', 'wght@400;600'], hf: 'serif', bf: 'sans-serif' },
];
const fontById = (id) => FONT_PAIRS.find((f) => f.id === id) || null;
function fontCss(id) {
  const f = fontById(id);
  if (!f) return { imports: '', rules: '' };
  const fam = (x) => 'family=' + x[0].replace(/ /g, '+') + (x[1] ? ':' + x[1] : '');
  const fams = f.h[0] === f.b[0] ? [fam([f.h[0], f.b[1] || f.h[1]])] : [fam(f.h), fam(f.b)];
  return {
    imports: '@import url("https://fonts.googleapis.com/css2?' + fams.join('&') + '&display=swap");\n',
    rules: '\n/* font pair */\nbody,input,button,select,textarea{font-family:"' + f.b[0] + '",' + f.bf + '!important}\nh1,h2,h3,h4,h5,h6{font-family:"' + f.h[0] + '",' + f.hf + '!important}',
  };
}
const lum = (hex) => {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const v = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)));
  return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
};
const contrast = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
const toHex = (r, g, b) => '#' + [r, g, b].map((x) => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, '0')).join('');
const rgb = (hex) => { let h = hex.replace('#', ''); if (h.length === 3) h = h.split('').map((c) => c + c).join(''); return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)); };
const shade = (hex, f) => toHex(...rgb(hex).map((x) => x * f));                 // f < 1 darkens
const tint = (hex, f) => toHex(...rgb(hex).map((x) => x + (255 - x) * f));      // f > 0 lightens
// A new palette must stay readable. 1) background and text variables must keep strong contrast, otherwise both are reverted.
// 2) Every other colour keeps its role: a colour that carries white text (buttons, hero) stays dark enough for it, a light tint or surface stays light.
function guardVars(tpl, vars) {
  const orig = rootVars(tpl), all = { ...orig, ...vars }, names = Object.keys(all);
  const isBg = (n) => /^--(bg|background|paper|bone|canvas)(?![\w-])/i.test(n), isTx = (n) => /^--(tx|text|fg|foreground)(?![\w-])/i.test(n);
  const bg = names.find(isBg), tx = names.find(isTx);
  if (bg && tx && contrast(all[bg], all[tx]) < 4.5) { delete vars[bg]; delete vars[tx]; }
  for (const [n, v] of Object.entries(vars)) {
    if (isBg(n) || isTx(n) || !orig[n]) continue;
    const co = contrast(orig[n], '#ffffff');
    let nv = v, guard = 0;
    if (co >= 3) while (contrast(nv, '#ffffff') < 3.5 && guard++ < 14) nv = shade(nv, 0.88);
    else if (co < 1.6) while (contrast(nv, '#ffffff') >= 3 && guard++ < 14) nv = tint(nv, 0.25);
    vars[n] = nv;
  }
  return vars;
}

// texts: { "<group id>": ["new text for item 0", "new text for item 1", ...] } -> { html, css, javascript }
function applyTexts(tpl, texts, opt = {}) {
  const { tokens, groups } = buildSlots(tpl);
  const parts = tokens.map((t) => t.s), jsMap = new Map();
  const clean = (s) => decode(String(s).replace(/<[^>]*>/g, ' ').replace(/```[a-z]*|`|\*\*|__/g, '')).replace(/\s+/g, ' ').trim().slice(0, 500); // plain text only: tags, markdown and entities from the AI never show up as code
  const same = new Map(); // original text -> first new text
  groups.forEach((g, id) => {
    const arr = texts && texts[id];
    if (!Array.isArray(arr)) return;
    g.items.forEach((it, k) => {
      if (typeof arr[k] !== 'string') return;
      let nv = clean(arr[k]);
      if (same.has(it.text)) nv = same.get(it.text); else same.set(it.text, nv);
      if (it.js) { if (nv) jsMap.set(it.orig, (it.orig.match(/^\s*/)[0] + nv.replace(/[<>]/g, '') + it.orig.match(/\s*$/)[0])); }
      else if (it.attr) parts[it.i] = parts[it.i].replace(new RegExp('(\\s' + it.attr + '\\s*=\\s*)(?:"[^"]*"|\'[^\']*\')', 'i'), (m, p) => p + '"' + escAttr(nv) + '"');
      else parts[it.i] = it.lead + escText(nv) + it.trail;
    });
  });
  let html = parts.join('');
  const assets = (Array.isArray(opt.assets) ? opt.assets : []).filter((a) => /^assets\/[a-z0-9._-]{1,70}$/.test(a));
  if (assets.length) { // the visitor's own photos replace the first stock photos of the template
    const urls = [...new Set([...html.matchAll(/<img\b[^>]*?\ssrc="(https:\/\/images\.unsplash\.com\/[^"]+|__SPIMG_[0-9a-f]{10}__)"/g)].map((m) => m[1]))];
    urls.slice(0, assets.length).forEach((u, i) => { html = html.split(u).join(assets[i]); });
  }
  let js = tpl.javascript || '';
  if (jsMap.size) {
    const orig = js;
    js = js.replace(JS_LIT, (m, a, b, off) => {
      const s = a !== undefined ? a : b;
      if (!jsMap.has(s) || !jsOk(s, orig, off)) return m;
      const q = m[0];
      return q + jsMap.get(s).replace(/\\/g, '\\\\').replace(q === "'" ? /'/g : /"/g, '\\' + q).replace(/[\u2028\u2029]/g, ' ') + q;
    });
    try { new Function(js); } catch (e) { js = orig; } // syntax check only; if something went wrong keep the template script
  }
  const vars = cleanVars(tpl, opt.vars);
  const fc = fontCss(opt.font || (opt.vars && opt.vars['--font']));
  const css = fc.imports + tpl.css + (Object.keys(vars).length ? '\n/* customised colours */\n:root{' + Object.entries(vars).map(([k, v]) => k + ':' + v).join(';') + '}' : '') + fc.rules;
  return { html: expandRes(html), css: expandRes(css), javascript: expandRes(js) };
}

module.exports = { slotInfo, applyTexts, rootVars, cleanVars, themeOf, buildSlots, FONT_PAIRS, fontById };
