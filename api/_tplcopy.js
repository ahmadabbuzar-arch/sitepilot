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
  const m = (tpl.css || '').match(/:root\s*\{([^}]*)\}/);
  const out = {};
  if (m) for (const x of m[1].matchAll(/(--[\w-]+)\s*:\s*(#[0-9a-fA-F]{3,8})\s*(?:;|$)/g)) out[x[1]] = x[2];
  return out;
}
function cleanVars(tpl, vars) {
  const allowed = rootVars(tpl), out = {};
  if (vars && typeof vars === 'object') for (const [k, v] of Object.entries(vars)) if (allowed[k] && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(String(v))) out[k] = String(v);
  return out;
}
function themeOf(tpl, vars) {
  const v = { ...rootVars(tpl), ...cleanVars(tpl, vars) }, names = Object.keys(v);
  const pick = (re, d) => { const n = names.find((x) => re.test(x)); return n ? v[n] : d; };
  return { primaryColor: pick(/^--(pr|primary|ac|accent|br|brand)/i, v[names[0]] || '#2563eb'), backgroundColor: pick(/^--(bg|background|paper|white|surface)/i, '#ffffff'), textColor: pick(/^--(tx|text|ink|fg)/i, '#111111'), fontFamily: 'system-ui, sans-serif' };
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
    const urls = [...new Set(html.match(/https:\/\/images\.unsplash\.com\/[^"'\s)]+/g) || [])];
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
  const css = tpl.css + (Object.keys(vars).length ? '\n/* customised colours */\n:root{' + Object.entries(vars).map(([k, v]) => k + ':' + v).join(';') + '}' : '');
  return { html, css, javascript: js };
}

module.exports = { slotInfo, applyTexts, rootVars, cleanVars, themeOf, buildSlots };
