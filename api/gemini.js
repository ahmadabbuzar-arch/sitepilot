// Vercel serverless route (CommonJS so it works without package.json settings).
// Env: GEMINI_API_KEY (required), GEMINI_MODEL; optional backups (see PROVIDERS): GROQ_API_KEY, MISTRAL_API_KEY, OPENROUTER_API_KEY, XKIRO_API_KEY, REQUESTY_API_KEY (+ REQUESTY_MODEL)
let groqCache = { t: 0, ids: null };
// Remember which Gemini model worked last and pause models that just failed, so a busy model (503) is not retried on every request.
let geminiCache = { t: 0, ids: null };
// Newest Gemini flash models from the live catalogue (full flash first, then the lighter "lite" ones, which often still work when flash is overloaded).
async function geminiModelList(k) {
  if (!geminiCache.ids || Date.now() - geminiCache.t > 600000) {
    try {
      const l = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', { headers: { 'x-goog-api-key': k }, signal: AbortSignal.timeout(6000) });
      if (l.ok) geminiCache = { t: Date.now(), ids: ((await l.json()).models || []).filter((m) => (m.supportedGenerationMethods || []).includes('generateContent')).map((m) => String(m.name).replace('models/', '')) };
    } catch (e) {}
  }
  const parse = (id) => { const m = id.match(/^gemini-(\d+(?:\.\d+)?)-flash(-lite)?$/); return m ? { id, v: parseFloat(m[1]), lite: !!m[2] } : null; };
  const found = (geminiCache.ids || []).map(parse).filter(Boolean);
  const byNew = (a, b) => b.v - a.v;
  const full = found.filter((x) => !x.lite).sort(byNew).slice(0, 4).map((x) => x.id);
  const lite = found.filter((x) => x.lite).sort(byNew).slice(0, 2).map((x) => x.id);
  const list = found.length ? [...full, 'gemini-flash-latest', ...lite, 'gemini-flash-lite-latest'] : ['gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.5-flash', 'gemini-flash-latest', 'gemini-3.1-flash-lite', 'gemini-flash-lite-latest'];
  return [...new Set([process.env.GEMINI_MODEL, ...list].filter(Boolean))];
}
const modelCool = new Map();
let goodModel = null;
// Gemini 3.x: low thinking (faster, leaves room for the JSON); older 2.5 models: thinking off. Temperature left at the default for 3.x.
const genConfig = (model, schema, lowThink) => ({ responseMimeType: 'application/json', responseSchema: schema, maxOutputTokens: 32000, ...(/2\.5/.test(model) ? { temperature: 0.7, thinkingConfig: { thinkingBudget: 0 } } : lowThink ? { thinkingConfig: { thinkingLevel: 'low' } } : {}) });
// Gemini keys in order of use: GEMINI_API_KEY, then GEMINI_API_KEY_2 (also accepts _2 variants, _BACKUP, or a comma list in GEMINI_API_KEYS)
const geminiKeys = () => [...new Set(['GEMINI_API_KEY', 'GEMINI_API_KEY_2', 'GEMINI_API_KEY2', 'GEMINI_API_KEY_BACKUP', 'GEMINI_API_KEY_B'].map((n) => process.env[n]).concat((process.env.GEMINI_API_KEYS || '').split(',')).map((x) => (x || '').trim()).filter(Boolean))];
const kit = require('./_kit.js');
const tc = require('./_tplcopy.js'); // text-slot engine: backup AIs customise the 100 templates by rewriting their text only

// ---------- Ready-made templates (api/_templates.js, built by scripts/build-templates.py) ----------
// generate mode: the AI first picks the closest of the 100 templates, then rewrites its content for the user's request
// (the template's layout, CSS and JavaScript are kept). If anything here fails, the normal from-scratch generation runs.
let tplData = null; // loaded on first use: one file with all 100 templates (api/_templates.js)
const tplAll = () => {
  if (!tplData) {
    const a = { catalog: [], templates: {} };
    // literal require() paths on purpose: Vercel only bundles files it can see in the code
    try { const m = require('./_templates.js'); a.catalog.push(...m.catalog); Object.assign(a.templates, m.templates); } catch (e) { /* missing: that set is simply not offered */ }
    try { const m = require('./_templates2.js'); a.catalog.push(...m.catalog); Object.assign(a.templates, m.templates); } catch (e) { /* missing: that set is simply not offered */ }
    tplData = a;
  }
  return tplData;
};
const templateCatalog = () => tplAll().catalog;
const loadTemplate = (id) => (typeof id === 'string' && Object.prototype.hasOwnProperty.call(tplAll().templates, id) ? tplAll().templates[id] : null);
// Fallback when the AI pick fails (or for English prompts it is enough): count template names/tags found in the request.
function pickByKeywords(prompt) {
  const q = String(prompt).toLowerCase(), wantsDash = /dashboard|admin|panel|crm|erp|management (system|software)/.test(q);
  let best = null, bestScore = 0;
  for (const t of templateCatalog()) {
    if (t.category === 'admin-dashboard' && !wantsDash) continue;
    let sc = 0;
    for (const w of [t.name.toLowerCase(), ...t.tags]) {
      if (w.length > 2 && q.includes(w)) sc += 3;
      else for (const part of w.split(' ')) if (part.length > 2 && q.includes(part)) sc += 1;
    }
    if (sc > bestScore) { bestScore = sc; best = t.id; }
  }
  return bestScore >= 3 ? best : 'business--startup-company'; // a weak match is worse than a neutral business template
}
const PICK_SCHEMA = { type: 'OBJECT', properties: { ids: { type: 'ARRAY', items: { type: 'STRING' } } }, required: ['ids'] };
async function chooseTemplate(prompt, keys) {
  const cat = templateCatalog();
  if (!cat.length) return null;
  const ids = new Set(cat.map((t) => t.id));
  let id = null;
  try { // one quick AI call (any language, also Hindi/Hinglish); on any problem the keyword match below is used
    const models = await geminiModelList(keys[0]);
    const model = models.find((m) => /lite/.test(m)) || models[0];
    const list = cat.map((t) => t.id + ' | ' + t.tags.join(', ')).join('\n');
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': keys[0] }, signal: AbortSignal.timeout(6000),
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: 'You pick the best ready-made website template for a user request. The request can be in any language (Hindi, Hinglish, English...). Answer with JSON {"ids":["..."]}: up to 3 ids from the list that are genuinely good fits, best first (only one id if only one really fits). Match the business or purpose first. Use admin-dashboard templates only if the user asks for a dashboard, admin panel or management software. If nothing fits well, choose the closest generic one (for example a business--, landing-pages-- or portfolio-- template).' }] },
        contents: [{ role: 'user', parts: [{ text: 'Templates (id | tags):\n' + list + '\n\nUser request: ' + prompt.slice(0, 600) }] }],
        generationConfig: { responseMimeType: 'application/json', responseSchema: PICK_SCHEMA, maxOutputTokens: 200, ...(/2\.5/.test(model) ? { thinkingConfig: { thinkingBudget: 0 } } : { thinkingConfig: { thinkingLevel: 'low' } }) },
      }),
    });
    if (r.ok) {
      const j = await r.json();
      const txt = (((j.candidates || [])[0] || {}).content || {}).parts || [];
      const got = JSON.parse(txt.filter((x) => !x.thought).map((x) => x.text || '').join('').replace(/^```json|```$/g, '').trim());
      const good = (Array.isArray(got && got.ids) ? got.ids : []).filter((x) => ids.has(x)).slice(0, 3);
      if (good.length) id = randOf(good); // several good fits: a random one, so users with the same idea do not all get the same site
    }
  } catch (e) { /* fall through to keywords */ }
  return loadTemplate(id || pickByKeywords(prompt));
}
// Every site gets its own look: a random creative direction, a fresh palette and a font pair, so two users asking for the same business do not get the same site.
const MOODS = ['bold and high-contrast', 'soft and pastel', 'dark and premium', 'fresh and bright', 'earthy and natural', 'playful and colourful', 'minimal black and white with one strong accent', 'warm and cozy', 'sporty and energetic', 'elegant and luxurious', 'retro and vintage', 'techy with neon accents', 'calm and trustworthy', 'trendy gradient-like pink, purple and blue'];
const randOf = (a) => a[Math.floor(Math.random() * a.length)];
const fontList = () => tc.FONT_PAIRS.map((f) => `${f.id} (${f.mood})`).join(', ');
const PALETTE_RULE = 'ALWAYS give this site its own fresh palette. Unless the user named colours, invent one that suits the brand and the creative direction and clearly differs from the template\'s current colours (a different main hue, not a small tweak). Return new hex values for the accent/brand colours and, when it suits the direction, for background, surface and text colours too, as one matching palette (not a single colour). Text must stay easy to read: strong contrast between text and its background, and accent colours that carry white text (buttons, hero) must be deep or saturated enough for white text.';

const SYSTEM_SLOTS = `You rewrite the text of a ready-made website template for a NEW business. The template's design, HTML, CSS and scripts are fixed and are never shown to you: you only rewrite texts. You get a list of items. Each item has an "id", "where" (the HTML element or attribute the text sits in, or "js" for text shown by the page scripts) and "t": an array of text fragments of ONE element. Fragments are split by inline tags such as <b>, so read them together as one sentence.
Return JSON: name (business or brand name), tagline (max 8 words), description (one sentence), font (one font id from the list below), vars (list of {name,value}: the new colour palette, see below) and items: for EVERY input item {id, t} with EXACTLY the same number of strings in t.
Rules: write plain text only, no HTML tags, no markdown, no code. Same role and similar length as the original text (never much longer). Specific and natural, no lorem ipsum, nothing of the template's original business may remain. Keep very generic labels (Home, Menu, Close, Add, Next) and pure symbols or emoji icons unchanged, but change emoji that show the old business. Prices and numbers stay realistic (use rupee signs if the request sounds Indian). Never invent real phone numbers, emails or street addresses: use placeholders such as +91 00000 00000, hello@example.com, Your street, Your city. Write in the language the user asked for, otherwise in English.`;
const SLOT_SCHEMA = {
  type: 'OBJECT',
  properties: {
    name: { type: 'STRING' }, tagline: { type: 'STRING' }, description: { type: 'STRING' }, font: { type: 'STRING' },
    vars: { type: 'ARRAY', items: { type: 'OBJECT', properties: { name: { type: 'STRING' }, value: { type: 'STRING' } }, required: ['name', 'value'] } },
    items: { type: 'ARRAY', items: { type: 'OBJECT', properties: { id: { type: 'INTEGER' }, t: { type: 'ARRAY', items: { type: 'STRING' } } }, required: ['id', 't'] } },
  },
  required: ['name', 'items'],
};
function slotPrompt(tpl, prompt) {
  const info = tc.slotInfo(tpl), rv = tc.rootVars(tpl);
  const items = info.groups.map((g, id) => ({ id, where: g.tag, t: g.items.map((x) => x.text) }));
  return `Customise the text of the template "${tpl.name}" (originally for: ${tpl.brand}; category ${tpl.category}) for this request.\nRequest: ${prompt}\n\n`
    + `Creative direction for this site (follow it unless the user asked for something else): ${randOf(MOODS)}.\n`
    + `Colours: ${PALETTE_RULE} Colour variables of this template and their current values: ${JSON.stringify(rv)}\n`
    + `Font: choose ONE id that fits the brand and direction: ${fontList()}.\n\nItems:\n${JSON.stringify(items)}`;
}
// Gemini's answer -> finished site. Only texts come from the AI; HTML, CSS and scripts are the template's own.
function slotsToSite(parsed, tpl, assets) {
  const info = tc.slotInfo(tpl), texts = {};
  let ok = 0;
  for (const it of Array.isArray(parsed && parsed.items) ? parsed.items : []) {
    const g = it && Number.isInteger(it.id) ? info.groups[it.id] : null;
    if (!g || !Array.isArray(it.t) || !it.t.every((x) => typeof x === 'string')) continue;
    const n = g.items.length;
    let v = it.t.slice();
    if (v.length > n) v = [...v.slice(0, n - 1), v.slice(n - 1).join(' ')];
    while (v.length < n) v.push('');
    if (!texts[it.id]) ok++;
    texts[it.id] = v;
  }
  if (ok < info.n * 0.6) return null; // too much missing: the caller tries the next model
  const vars = tc.cleanVars(tpl, Object.fromEntries((Array.isArray(parsed.vars) ? parsed.vars : []).filter((x) => x && typeof x.name === 'string').map((x) => [x.name, x.value])));
  const font = tc.fontById(String(parsed.font || '').trim()) ? String(parsed.font).trim() : tc.FONT_PAIRS[Math.floor(Math.random() * tc.FONT_PAIRS.length)].id;
  const out = tc.applyTexts(tpl, texts, { assets, vars, font });
  return { name: String(parsed.name || tpl.brand || 'My website').slice(0, 60), description: String(parsed.description || '').slice(0, 200), theme: tc.themeOf(tpl, vars), pages: [{ name: 'Home', slug: '/', html: out.html, css: out.css, javascript: out.javascript }], template: tpl.id };
}
const hits = new Map(); // in-memory per-IP counter (resets on cold start); use Upstash/Firebase for strict limits
// Env: GENERATE_LIMIT = abuse backstop per IP per day (default 100; the per-user limit of 5 is in index.html), EDIT_LIMIT = AI edits per IP per day (default 30)

const SYSTEM = `You are a professional web developer. Generate clean, responsive, accessible HTML/CSS/JavaScript. Maintain the existing design system when editing. Do not remove existing functionality unless explicitly requested. Return valid structured JSON. Never include markdown code fences inside code fields.
Rules: each page "html" is BODY INNER HTML only (no html/head/body tags). Use semantic HTML, alt text, labels, one h1, visible focus, readable contrast. CSS must be mobile-first, use relative units and media queries, support 320px+, no horizontal overflow. Navigation links must use hrefs like index.html, about.html (slug "/" = index.html) and be identical on every page. All pages share the same CSS design system (put shared CSS in the first page; others may add only page-specific CSS). No external scripts, no remote images (use CSS shapes/gradients or inline SVG). Original content only, no copyrighted brands.`;

const PAGE = { type: 'OBJECT', properties: { name: { type: 'STRING' }, slug: { type: 'STRING' }, html: { type: 'STRING' }, css: { type: 'STRING' }, javascript: { type: 'STRING' } }, required: ['name', 'slug', 'html', 'css', 'javascript'] };
const SCHEMA = {
  generate: { type: 'OBJECT', properties: { name: { type: 'STRING' }, description: { type: 'STRING' }, theme: { type: 'OBJECT', properties: { primaryColor: { type: 'STRING' }, backgroundColor: { type: 'STRING' }, textColor: { type: 'STRING' }, fontFamily: { type: 'STRING' } } }, pages: { type: 'ARRAY', items: PAGE } }, required: ['name', 'description', 'theme', 'pages'] },
  edit: { type: 'OBJECT', properties: { summary: { type: 'STRING' }, pages: { type: 'ARRAY', items: PAGE } }, required: ['summary', 'pages'] },
};

const config = { maxDuration: 60 }; // full-site generation takes >10s (Vercel default)

// ---------- Backup AIs: several providers working together ----------
const DESIGN = 'Design rules: modern premium look, generous whitespace, 8px spacing scale, fluid type with clamp(), one primary accent colour from the theme used sparingly, soft borders, subtle shadows, rounded cards, clear visual hierarchy, a strong hero, consistent buttons, hover and focus states, smooth subtle transitions, mobile-first with breakpoints, no horizontal overflow, readable contrast, no lorem ipsum, no external fonts or images.';
let mistralCache = { t: 0, ids: null };
const catCache = {};
// All of these speak the OpenAI chat format. Key names accepted in Vercel: see "keys". Optional: <NAME>_MODEL (comma list ok), <NAME>_MAX_TOKENS.
const PROVIDERS = {
  groq: { url: 'https://api.groq.com/openai/v1', keys: ['GROQ_API_KEY'], model: 'GROQ_MODEL', timeout: 25000 },
  mistral: { url: 'https://api.mistral.ai/v1', keys: ['MISTRAL_API_KEY'], model: 'MISTRAL_MODEL', timeout: 38000 },
  openrouter: { url: 'https://openrouter.ai/api/v1', keys: ['OPENROUTER_API_KEY', 'OPENROUTER_KEY'], model: 'OPENROUTER_MODEL', timeout: 38000 }, // $0 models only unless you set OPENROUTER_MODEL
  xkiro: { url: process.env.XKIRO_BASE_URL || 'https://api.xkiro.com/v1', keys: ['XKIRO_API_KEY', 'XKIRO_KEY'], model: 'XKIRO_MODEL', timeout: 38000 }, // free-looking models only unless you set XKIRO_MODEL
  requesty: { url: process.env.REQUESTY_BASE_URL || 'https://router.requesty.ai/v1', keys: ['REQUESTY_API_KEY', 'REQUESTY_KEY'], model: 'REQUESTY_MODEL', timeout: 38000 }, // free plan: $0 models only, 200 requests/day shared (set REQUESTY_MODEL to use a paid one)
};
const provKey = (p) => PROVIDERS[p].keys.map((n) => process.env[n]).find(Boolean);
const activeProviders = () => Object.keys(PROVIDERS).filter(provKey);
const haveBackup = () => activeProviders().length > 0;
// Who does what, strongest first. Pages rotate through this list so different AIs write different pages of the same site.
const ORDER = {
  plan: ['groq', 'mistral', 'openrouter', 'xkiro', 'requesty'],
  css: ['mistral', 'openrouter', 'requesty', 'xkiro', 'groq'],
  html: ['mistral', 'openrouter', 'requesty', 'xkiro', 'groq'],
  page: ['mistral', 'openrouter', 'requesty', 'xkiro', 'groq'],
  polish: ['openrouter', 'requesty', 'mistral', 'xkiro', 'groq'],
  oneshot: ['mistral', 'openrouter', 'requesty', 'xkiro', 'groq'],
};
async function groqModelList(gk) { // newest production model first, then newest preview, then the small one (checked against Groq's live catalogue, cached 10 min)
  if (!groqCache.ids || Date.now() - groqCache.t > 600000) {
    try {
      const l = await fetch('https://api.groq.com/openai/v1/models', { headers: { Authorization: 'Bearer ' + gk } });
      if (l.ok) groqCache = { t: Date.now(), ids: ((await l.json()).data || []).map((x) => x.id) };
    } catch (e) {}
  }
  const avail = groqCache.ids;
  const pref = [process.env.GROQ_MODEL, 'openai/gpt-oss-120b', 'qwen/qwen3.8-27b', 'openai/gpt-oss-20b'].filter(Boolean);
  let list = avail ? pref.filter((m) => avail.includes(m)) : pref;
  if (avail && list.length < 2) list = [...list, ...avail.filter((m) => !/whisper|guard|tts|compound|embed|orpheus|vision/i.test(m) && !list.includes(m)).slice(0, 2)];
  return list;
}
async function mistralModelList(mk) { // strongest first; the *-latest names are aliases that Mistral keeps pointing at the newest version
  if (!mistralCache.ids || Date.now() - mistralCache.t > 600000) {
    try {
      const l = await fetch('https://api.mistral.ai/v1/models', { headers: { Authorization: 'Bearer ' + mk } });
      if (l.ok) mistralCache = { t: Date.now(), ids: ((await l.json()).data || []).map((x) => x.id) };
    } catch (e) {}
  }
  const avail = mistralCache.ids;
  const pref = [process.env.MISTRAL_MODEL, 'mistral-large-latest', 'mistral-medium-latest', 'codestral-latest'].filter(Boolean);
  const list = avail ? pref.filter((m) => avail.includes(m)) : pref;
  return list.length ? list : pref;
}

const RANK = [/qwen.*coder/i, /deepseek/i, /gpt-oss-120b/i, /glm/i, /kimi/i, /nemotron-3-(ultra|super)/i, /mistral|mixtral/i, /llama.*70b/i, /qwen/i, /gemma/i, /gpt-oss/i];
const NOT_CHAT = /embed|tts|whisper|vision|image|ocr|moderation|guard|safety|audio|leanstral|prover|\bvl\b/i; // not useful for writing websites
const REQUESTY_FREE = ['nvidia/nemotron-3-super-120b-a12b', 'nvidia/nemotron-3-ultra-550b-a55b']; // ids Requesty documents as $0 (used only if its catalogue has no price info)
const priceOf = (e) => { const v = [e.pricing && e.pricing.prompt, e.pricing && e.pricing.completion, e.pricing && e.pricing.input, e.pricing && e.pricing.output, e.input_price, e.output_price, e.prompt_price, e.completion_price].filter((x) => x !== undefined && x !== null && x !== ''); return v.length ? v.map(Number) : null; };
const looksFree = (e) => /free/i.test(e.id) || (() => { const v = priceOf(e); return !!v && v.every((n) => n === 0); })();
async function modelList(p) {
  const explicit = String(process.env[PROVIDERS[p].model] || '').split(',').map((x) => x.trim()).filter(Boolean);
  const key = provKey(p);
  if (p === 'groq') return [...new Set([...explicit, ...(await groqModelList(key))])];
  if (p === 'mistral') return [...new Set([...explicit, ...(await mistralModelList(key))])];
  // OpenRouter / Xkiro / Requesty: read their live catalogue and use only models priced at $0 (best coders first). Set <NAME>_MODEL to choose another one yourself.
  if (!catCache[p] || Date.now() - catCache[p].t > 600000) {
    try {
      const l = await fetch(PROVIDERS[p].url + '/models', { headers: { Authorization: 'Bearer ' + key }, signal: AbortSignal.timeout(7000) });
      if (l.ok) catCache[p] = { t: Date.now(), data: (await l.json()).data || [] };
    } catch (e) {}
  }
  const data = ((catCache[p] && catCache[p].data) || []).filter((e) => e && typeof e.id === 'string' && !NOT_CHAT.test(e.id));
  let free = data.filter((e) => looksFree(e) && (!e.context_length || e.context_length >= 32000));
  if (p === 'requesty' && !free.length && !data.some(priceOf)) free = data.length ? data.filter((e) => REQUESTY_FREE.includes(e.id)) : REQUESTY_FREE.map((id) => ({ id }));
  const rank = (id) => { const k = RANK.findIndex((rx) => rx.test(id)); return k < 0 ? 99 : k; };
  return [...new Set([...explicit, ...free.sort((a, b) => rank(a.id) - rank(b.id)).slice(0, 3).map((e) => e.id)])];
}
async function oneProvider(p, sys, user, maxTokens, deadline) {
  const cfg = PROVIDERS[p], key = provKey(p);
  if (!key) return null;
  // Groq's free plan has a small per-minute token budget; the others have more room, so they may write longer output.
  const cap = p === 'groq' ? Math.min(maxTokens, Number(process.env.GROQ_MAX_TOKENS || 6000)) : Math.min(Math.round(maxTokens * (p === 'mistral' ? 1.6 : 1.4)), Number(process.env[p.toUpperCase() + '_MAX_TOKENS'] || (p === 'mistral' ? 12000 : 10000)));
  const headers = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key, ...(p === 'openrouter' ? { 'HTTP-Referer': 'https://sitepilotog.vercel.app', 'X-Title': 'SitePilot' } : {}) };
  for (const m of await modelList(p)) {
    for (const jsonMode of [true, false]) { // some models reject JSON mode: then ask again without it
      const left = (deadline || Infinity) - Date.now();
      if (left < 4000) return null; // out of time (Vercel stops the function at 60s)
      try {
        const r = await fetch(cfg.url + '/chat/completions', {
          method: 'POST', headers, signal: AbortSignal.timeout(Math.min(cfg.timeout, left)),
          body: JSON.stringify({ model: m, messages: [{ role: 'system', content: sys }, { role: 'user', content: user }], temperature: 0.6, max_tokens: cap, ...(jsonMode ? { response_format: { type: 'json_object' } } : {}) }),
        });
        if (!r.ok) { console.error(p, 'HTTP', m, r.status, (await r.text()).slice(0, 300)); if (r.status === 400 && jsonMode) continue; break; }
        const d = await r.json();
        const t = String(d?.choices?.[0]?.message?.content || '').replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/^```json|```$/g, '').trim();
        const a = t.indexOf('{'), z = t.lastIndexOf('}');
        return JSON.parse(a >= 0 && z > a ? t.slice(a, z + 1) : t);
      } catch (e) { console.error(p, 'failed', m, e && e.message); break; }
    }
  }
  return null;
}
// Asks the best AI for this job first and the others if it fails, so any of them can cover for another.
async function aiJson(sys, user, maxTokens, opt = {}) {
  let order = (ORDER[opt.stage] || ORDER.oneshot).filter(provKey);
  if (opt.prefer && order.includes(opt.prefer)) order = [opt.prefer, ...order.filter((p) => p !== opt.prefer)];
  if (opt.slot && order.length) { const k = opt.slot % order.length; order = [...order.slice(k), ...order.slice(0, k)]; } // page 2 starts with the next AI
  if (opt.avoid) order = [...order.filter((p) => p !== opt.avoid), ...order.filter((p) => p === opt.avoid)];
  for (const p of order) {
    const data = await oneProvider(p, sys, user, maxTokens, opt.deadline);
    if (data) return { data, by: p };
  }
  return null;
}
// Two steps build a site with the SitePilot Kit (api/_kit.js): the AIs write the PLAN and the CONTENT; the kit supplies the polished design.
// plan (one AI) -> page content for every page (different AIs in parallel) -> the kit renders HTML and CSS.
async function backupStage(stage, b, opt) {
  const clip = (v, n) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);
  const assets = (Array.isArray(b.assets) ? b.assets : []).filter((a) => typeof a === 'string' && /^assets\/[a-z0-9._-]{1,70}$/.test(a)).slice(0, 12);
  // ---- Template flow for the backup AIs (replaces the old kit flow): tplplan -> tplcopy (several batches) -> tplbuild ----
  if (stage === 'tplplan') {
    const cat = templateCatalog();
    if (!cat.length) return { notemplates: true }; // templates folder missing: the app falls back to the old kit flow
    const prompt = String(b.prompt || '');
    const list = cat.map((t) => t.id + ' | ' + t.tags.join(', ')).join('\n');
    const sys = 'You are a creative director. Pick the best ready-made website template for the user request (the request can be in any language, also Hindi or Hinglish) and plan the branding. Return ONLY one JSON object: {"templates":["id"],"name":"brand or business name","tagline":"max 8 words","description":"1 sentence","tone":"2-4 words","language":"language the website text must be written in (English unless the user asked for another)"}. '
      + '"templates" lists up to 3 ids from this list (id | tags) that are genuinely good fits, best first (one id if only one really fits). Match the business type first; use admin-dashboard templates only when the user asks for a dashboard, admin panel or management software; if nothing fits, take the closest generic one.\n' + list;
    const g = await aiJson(sys, `Website request: ${clip(prompt, 1500)}`, 900, { ...opt, stage: 'plan' });
    const raw = g && g.data && typeof g.data === 'object' ? g.data : null;
    if (!raw) return null;
    const ids = new Set(cat.map((t) => t.id));
    const good = (Array.isArray(raw.templates) ? raw.templates : [raw.template]).filter((x) => ids.has(x)).slice(0, 3);
    const tpl = loadTemplate(good.length ? randOf(good) : pickByKeywords(prompt));
    if (!tpl) return null;
    let vars = {}, font = null;
    { // every site gets a fresh palette and a font pair (not only when the user names colours)
      const rv = tc.rootVars(tpl);
      const g2 = await aiJson('Return ONLY JSON {"vars":{"--name":"#rrggbb"},"font":"id"}. ' + PALETTE_RULE + ' Allowed colour variables with their current values: ' + JSON.stringify(rv) + '. "font" = ONE id that fits the brand and direction: ' + fontList() + '.', `Website request: ${clip(prompt, 800)}\nCreative direction: ${randOf(MOODS)}.`, 700, { ...opt, stage: 'plan' });
      if (g2 && g2.data) { vars = tc.cleanVars(tpl, g2.data.vars); font = tc.fontById(String(g2.data.font || '').trim()) ? String(g2.data.font).trim() : null; }
    }
    vars['--font'] = font || randOf(tc.FONT_PAIRS).id; // travels with vars to the build step (not a CSS variable)
    const info = tc.slotInfo(tpl);
    return { template: tpl.id, name: clip(raw.name, 60) || tpl.brand || 'My website', tagline: clip(raw.tagline, 80), description: clip(raw.description, 200), tone: clip(raw.tone, 40), language: clip(raw.language, 30) || 'English', vars, theme: tc.themeOf(tpl, vars), groups: info.n, batches: info.batches.length, by: g.by };
  }
  if (stage === 'tplcopy') {
    const tpl = loadTemplate(b.template);
    if (!tpl) return null;
    const info = tc.slotInfo(tpl), k = Number.isInteger(b.batch) ? b.batch : -1;
    if (k < 0 || k >= info.batches.length) return null;
    const br = b.brief && typeof b.brief === 'object' ? b.brief : {};
    const ids = info.batches[k], payload = {};
    ids.forEach((id) => { payload[id + '|' + info.groups[id].tag] = info.groups[id].items.map((x) => x.text); });
    const sys = 'You rewrite the text of a ready-made website template for a NEW business. You get a JSON object. Each key is "id|where" (where = the HTML element or attribute, or "js" for text that the page scripts show) and each value is an array of text fragments that belong to ONE element; fragments are split by inline tags such as <b>, so read them together as one sentence. '
      + 'Return ONLY a JSON object with EXACTLY the same keys, each value an array with EXACTLY the same number of strings. '
      + `The template was originally made for: ${tpl.name} (${tpl.brand}). Rewrite every string for the new business below: same role and similar length (never much longer), specific and natural, no lorem ipsum, nothing of the original business may remain. `
      + 'Keep very generic labels (Home, Menu, Close, Add, Next) and pure symbols or emoji icons as they are, but change emoji that show the old business. Prices and numbers stay realistic (use rupee signs if the request sounds Indian). Never invent real phone numbers, emails or street addresses: use placeholders such as +91 00000 00000, hello@example.com, Your street, Your city. '
      + `Write in ${clip(br.language, 30) || 'English'}.`;
    const user = `Business: ${clip(br.name, 60)}. Tagline: ${clip(br.tagline, 80)}. About: ${clip(br.description, 200)}. Tone: ${clip(br.tone, 40) || 'confident and friendly'}. Original request: ${clip(b.prompt, 800)}\n\nTexts to rewrite:\n${JSON.stringify(payload)}`;
    const g = await aiJson(sys, user, 3800, { ...opt, stage: 'page' });
    const raw = g && g.data;
    if (!raw || typeof raw !== 'object') return null;
    const texts = {};
    let ok = 0;
    ids.forEach((id) => {
      const n = info.groups[id].items.length;
      const key = Object.keys(raw).find((x) => x === id + '|' + info.groups[id].tag) || Object.keys(raw).find((x) => x.split('|')[0] === String(id));
      let v = key ? raw[key] : undefined;
      if (typeof v === 'string') v = [v];
      if (!Array.isArray(v) || !v.length || !v.every((x) => typeof x === 'string')) return;
      if (v.length > n) v = [...v.slice(0, n - 1), v.slice(n - 1).join(' ')];
      while (v.length < n) v.push('');
      texts[id] = v.map((x) => clip(x, 500));
      ok++;
    });
    if (ok < ids.length * 0.7) return null; // too much missing: let the app try this batch again
    return { texts, by: g.by };
  }
  if (stage === 'tplbuild') { // no AI here: puts the rewritten texts into the template
    const tpl = loadTemplate(b.template);
    if (!tpl || !b.texts || typeof b.texts !== 'object' || JSON.stringify(b.texts).length > 300000) return null;
    return { ...tc.applyTexts(tpl, b.texts, { assets, vars: b.vars }), by: 'template' };
  }
  if (stage === 'plan') {
    const short = kit.shortlist(String(b.prompt || ''));
    const sys = 'You are a senior creative director and information architect at a top web agency. Plan a premium website for the request. Return ONLY one JSON object: {"name":"","tagline":"max 8 words","description":"1 sentence","preset":"id","brandColor":"#hex or empty","contactEmail":"only if the user wrote one, else empty","tone":"2-4 words","navCta":{"label":"max 3 words","target":"contact"},"pages":[{"name":"Home","slug":"/","sections":[{"type":"hero","label":"Home"}]}]}.\n'
      + `preset: choose exactly one of these looks: ${kit.presetMenu(short)}. Pick the best fit for this business.\n`
      + `Pages: one page for simple businesses; up to 4 pages only when the request clearly needs them (for example About, Services, Contact). Every page has 4 to 8 sections. Section types: ${kit.TYPES.join(', ')}. Home starts with a hero (hero only once, only on Home). Choose sections that suit THIS business and vary the order; do not repeat one fixed sequence. Exactly one page holds a contact section. End Home with cta unless Home holds the contact section. label = the menu text, max 14 characters. Use the business name the user gave, or invent a short brand name. brandColor only if the user named a colour, else "".`
      + (assets.length ? ' The visitor uploaded their own photos; the site places them automatically (hero and sections).' : '');
    const g = await aiJson(sys, `Website request: ${clip(b.prompt, 1500)}`, 1700, { ...opt, stage: 'plan' });
    if (!g || !g.data || typeof g.data !== 'object') return null;
    const plan = kit.normalizePlan(g.data, String(b.prompt || ''));
    return { ...plan, theme: kit.themeSummary(plan), css: kit.kitCss(plan), by: g.by };
  }
  if (stage === 'page') {
    if (!b.brief || typeof b.brief !== 'object') return null;
    const plan = kit.normalizePlan(b.brief, '');
    const idx = Number.isInteger(b.pageIndex) ? b.pageIndex : -1;
    if (idx < 0 || idx >= plan.pages.length) return null;
    const page = plan.pages[idx], types = [...new Set(page.sections.map((x) => x.type))];
    const sys = 'You are a senior conversion copywriter. Write the content for ONE page of a website. Return ONLY JSON: {"sections":[...]} containing exactly these sections in this order: ' + page.sections.map((x) => `${x.type} ("${x.label}")`).join(', ') + '.\n'
      + 'Shape of each section:\n' + types.map((t) => kit.DOCS[t]).join('\n') + '\n'
      + 'Rules: specific, persuasive, benefit-led copy for this exact business; short sentences; no lorem ipsum; never invent phone numbers, emails, street addresses, awards or claims about real companies; testimonials are generic (first name + role); figures stay modest and plausible; any prices are sample placeholders. cta/button target is "contact", a page slug, or a section type on this page. Icons must be one of: star, bolt, shield, heart, chart, users, clock, globe, camera, code, leaf, play, mail, pin, gift.'
      + (assets.length ? ' The visitor uploaded their own photos; the site places them automatically, so do not mention image files.' : '');
    const user = `Brand: ${plan.name}. Tagline: ${plan.tagline}. About: ${plan.description}. Tone: ${plan.tone || 'confident and friendly'}. This page: ${page.name}. Other pages: ${plan.pages.filter((p, i) => i !== idx).map((p) => p.name).join(', ') || 'none'}. Original request: ${clip(b.prompt, 800)}`;
    const g = await aiJson(sys, user, 3600, { ...opt, stage: 'page' });
    const raw = g && g.data;
    if (!raw || !Array.isArray(raw.sections)) return null;
    const sections = kit.cleanPageContent(plan, idx, raw);
    return { html: kit.renderPage(plan, idx, sections, assets), javascript: idx === 0 ? kit.pageJs : '', by: g.by };
  }
  return null;
}

// ---------- Prompt helper: turns a short idea into a detailed website prompt ----------
const PROMPT_SYS = 'You write website briefs for an AI website builder. The user gives a short idea (any language, even a few words). Turn it into ONE detailed prompt in English that an AI web designer can build from. Include: the business or brand and its audience; the goal of the site; the pages (max 4) and, for each page, the key sections in order; specific content ideas (real-sounding headings, services or features, and testimonials or pricing only where they fit); the visual style (mood, a colour palette with hex codes, typography feel, imagery approach using CSS shapes or the visitor\'s own uploaded photos); useful features (contact form, WhatsApp button, booking, gallery, and so on, only if they fit); the tone of voice; mobile-first and accessibility requirements. Invent sensible details where the user gave none, but never invent real phone numbers, addresses, claims about real companies or important prices. 180-300 words, plain text paragraphs, no markdown headings, no preamble. If the user wants the website text in a specific language, say so in the prompt. Return ONLY JSON: {"prompt":"..."}';
async function promptTool(idea) {
  const user = 'Website idea from the user: ' + idea.slice(0, 600);
  const schema = { type: 'OBJECT', properties: { prompt: { type: 'STRING' } }, required: ['prompt'] };
  const keys = geminiKeys(), t0 = Date.now();
  if (keys.length) {
    const models = (await geminiModelList(keys[0])).slice(0, 3);
    for (const k of keys) {
      for (const m of models) {
        if (Date.now() - t0 > 30000) break;
        try {
          const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`, {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': k }, signal: AbortSignal.timeout(20000),
            body: JSON.stringify({ systemInstruction: { parts: [{ text: PROMPT_SYS }] }, contents: [{ role: 'user', parts: [{ text: user }] }], generationConfig: { ...genConfig(m, schema, true), maxOutputTokens: 2000 } }),
          });
          if (r.status === 401 || r.status === 403) break; // this key is blocked: next key
          if (!r.ok) continue;
          const d = await r.json();
          const txt = ((d?.candidates?.[0]?.content?.parts) || []).filter((x) => !x.thought).map((x) => x.text || '').join('');
          const p = JSON.parse(txt).prompt;
          if (typeof p === 'string' && p.length > 80) return { prompt: p.trim(), via: 'gemini' };
        } catch (e) {}
      }
    }
  }
  const g = await aiJson(PROMPT_SYS, user, 1400, { stage: 'plan', deadline: Date.now() + 25000 }); // quiet fallback to the backup AIs: this is a small helper, not a website
  const p = g && g.data && g.data.prompt;
  return typeof p === 'string' && p.length > 80 ? { prompt: p.trim(), via: g.by } : null;
}

async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*'); // lets the APK (file/localhost origin) call this API
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method === 'GET' && req.query && req.query.models) { // diagnostic: which models can this key use?
    try {
      const l = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=100', { headers: { 'x-goog-api-key': geminiKeys()[0] || '' } });
      const d = await l.json();
      return res.status(200).json({ status: l.status, models: (d.models || []).filter(m => (m.supportedGenerationMethods || []).includes('generateContent')).map(m => m.name), error: d.error && d.error.message });
    } catch (e) { return res.status(500).json({ error: 'list' }); }
  }
  if (req.method === 'GET' && req.query && req.query.providers) { // diagnostic: which backup AIs are connected and which model each will use (one tiny request each)
    const ipp = String(req.headers['x-forwarded-for'] || 'x').split(',')[0].trim(), pk = 'prov' + ipp + new Date().toISOString().slice(0, 10), pu = hits.get(pk) || 0;
    if (pu >= 10) return res.status(429).json({ error: 'limit' });
    hits.set(pk, pu + 1);
    const out = [];
    for (const p of activeProviders()) {
      const models = await modelList(p);
      if (!models.length) { out.push({ provider: p, model: null, note: 'no free model found, set ' + PROVIDERS[p].model }); continue; }
      try {
        const t = await fetch(PROVIDERS[p].url + '/chat/completions', { method: 'POST', signal: AbortSignal.timeout(20000), headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + provKey(p), ...(p === 'openrouter' ? { 'HTTP-Referer': 'https://sitepilotog.vercel.app', 'X-Title': 'SitePilot' } : {}) }, body: JSON.stringify({ model: models[0], messages: [{ role: 'user', content: 'Reply with the word ok' }], max_tokens: 8 }) });
        out.push({ provider: p, model: models[0], status: t.status, msg: t.ok ? '' : (await t.text()).slice(0, 140) });
      } catch (e) { out.push({ provider: p, model: models[0], status: 'failed or timed out' }); }
    }
    return res.status(200).json({ providers: out });
  }
  if (req.method === 'GET' && req.query && req.query.mistral) { // diagnostic: which Mistral models can this key use?
    try {
      const l = await fetch('https://api.mistral.ai/v1/models', { headers: { Authorization: 'Bearer ' + (process.env.MISTRAL_API_KEY || '') } });
      const d = await l.json();
      return res.status(200).json({ status: l.status, models: (d.data || []).map((m) => m.id), error: d.message || (d.error && d.error.message) });
    } catch (e) { return res.status(500).json({ error: 'list' }); }
  }
  if (req.method === 'GET' && req.query && req.query.groq) { // diagnostic: which Groq models can this key use?
    try {
      const l = await fetch('https://api.groq.com/openai/v1/models', { headers: { Authorization: 'Bearer ' + (process.env.GROQ_API_KEY || '') } });
      const d = await l.json();
      return res.status(200).json({ status: l.status, models: (d.data || []).map((m) => m.id), error: d.error && d.error.message });
    } catch (e) { return res.status(500).json({ error: 'list' }); }
  }
  if (req.method === 'GET' && req.query && req.query.test === 'full') { // diagnostic: one REAL website generation with the first key, shows timing, tokens and whether the JSON is usable
    const ip1 = String(req.headers['x-forwarded-for'] || 'x').split(',')[0].trim(), fk = 'full' + ip1 + new Date().toISOString().slice(0, 10), fu = hits.get(fk) || 0;
    if (fu >= 6) return res.status(429).json({ error: 'limit' });
    hits.set(fk, fu + 1);
    const keys1 = geminiKeys(), kn = Math.min(Math.max(Number(req.query.key) || 1, 1), keys1.length || 1), model1 = String(req.query.model || process.env.GEMINI_MODEL || 'gemini-3.8-flash');
    if (!/^[a-z0-9.-]{3,60}$/.test(model1) || !keys1.length) return res.status(400).json({ error: 'input' });
    const t1 = Date.now();
    try {
      const t = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model1}:generateContent`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': keys1[kn - 1] }, signal: AbortSignal.timeout(55000),
        body: JSON.stringify({ systemInstruction: { parts: [{ text: SYSTEM }] }, contents: [{ role: 'user', parts: [{ text: 'Create a complete multi-page-ready website (at least a Home page; add About/Contact etc. only if useful).\nRequest: A modern portfolio website for a video editor with showreel section, projects grid and contact.' }] }], generationConfig: genConfig(model1, SCHEMA.generate, true) }),
      });
      const j = await t.json().catch(() => ({}));
      const c = j.candidates && j.candidates[0], txt = ((c && c.content && c.content.parts) || []).filter((p) => !p.thought).map((p) => p.text || '').join('');
      let parsedOk = false; try { parsedOk = Array.isArray(JSON.parse(txt).pages); } catch (e) {}
      return res.status(200).json({ key: kn, model: model1, status: t.status, seconds: Math.round((Date.now() - t1) / 1000), finishReason: c && c.finishReason, parsedOk, outChars: txt.length, usage: j.usageMetadata, error: j.error && String(j.error.message).slice(0, 200) });
    } catch (e) { return res.status(200).json({ key: kn, model: model1, error: 'failed or timed out', seconds: Math.round((Date.now() - t1) / 1000) }); }
  }
  if (req.method === 'GET' && req.query && req.query.test) { // diagnostic: why is Gemini failing? (tiny real request per key/model)
    const ip0 = String(req.headers['x-forwarded-for'] || 'x').split(',')[0].trim(), tk = 'test' + ip0 + new Date().toISOString().slice(0, 10), tu = hits.get(tk) || 0;
    if (tu >= 10) return res.status(429).json({ error: 'limit' });
    hits.set(tk, tu + 1);
    const out = [];
    for (const [ki, k] of geminiKeys().entries()) {
      const results = [];
      for (const m of [...new Set([process.env.GEMINI_MODEL, 'gemini-3.8-flash', 'gemini-3.5-flash'].filter(Boolean))]) {
        try {
          const t = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`, {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': k },
            body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'Return summary "ok" and an empty pages array.' }] }], generationConfig: { responseMimeType: 'application/json', responseSchema: SCHEMA.edit, maxOutputTokens: 32000 } }),
          });
          let msg = ''; if (!t.ok) { try { msg = (await t.json()).error.message.slice(0, 140); } catch (e) {} }
          results.push({ model: m, status: t.status, msg });
        } catch (e) { results.push({ model: m, status: 'fetch failed' }); }
      }
      out.push({ key: ki + 1, results });
    }
    return res.status(200).json({ backups: activeProviders(), keys: out });
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'method', keySet: geminiKeys().length > 0, geminiKeys: geminiKeys().length, backups: activeProviders() });
  const keys = geminiKeys();
  if (!keys.length && !haveBackup()) return res.status(500).json({ error: 'config' });

  const { mode, prompt, site, page, image, assets, backup, stage } = req.body || {};
  if (!['generate', 'edit', 'prompt'].includes(mode) || typeof prompt !== 'string' || (prompt.trim().length < 3 && !image) || prompt.length > 4000)
    return res.status(400).json({ error: 'input' });
  if (image && (!['image/jpeg', 'image/png', 'image/webp'].includes(image.mime) || typeof image.data !== 'string' || image.data.length > 3_000_000 || !/^[A-Za-z0-9+/=]+$/.test(image.data)))
    return res.status(400).json({ error: 'image' });
  if (assets && (!Array.isArray(assets) || assets.length > 12 || assets.some((a) => !/^assets\/[a-z0-9._-]{1,70}$/.test(a)))) return res.status(400).json({ error: 'input' });
  if (JSON.stringify(site || {}).length > 400000) return res.status(413).json({ error: 'size' });

  const ip = String(req.headers['x-forwarded-for'] || 'x').split(',')[0].trim();
  const day = new Date().toISOString().slice(0, 10), k = ip + day + mode; // separate counters for generate and edit
  const limit = mode === 'generate' ? Number(process.env.GENERATE_LIMIT || 100) : mode === 'prompt' ? Number(process.env.PROMPT_LIMIT || 20) : Number(process.env.EDIT_LIMIT || 30), used = hits.get(k) || 0;
  if (used >= limit) return res.status(429).json({ error: 'limit', remaining: 0 });

  if (mode === 'prompt') {
    if (prompt.length > 600) return res.status(400).json({ error: 'input' });
    const out = await promptTool(prompt);
    if (!out) return res.status(503).json({ error: 'busy' });
    hits.set(k, used + 1);
    return res.status(200).json(out);
  }
  if (backup === true && stage && mode === 'generate' && haveBackup()) { // staged backup build (see backupStage)
    if (!['plan', 'page', 'tplplan', 'tplcopy', 'tplbuild'].includes(stage)) return res.status(400).json({ error: 'input' });
    const nm = (v) => (typeof v === 'string' && PROVIDERS[v] ? v : undefined);
    const out = await backupStage(stage, req.body, { prefer: nm(req.body.prefer), avoid: nm(req.body.avoid), slot: Number.isInteger(req.body.slot) && req.body.slot > 0 && req.body.slot < 10 ? req.body.slot : 0, deadline: Date.now() + 52000 });
    if (!out) return res.status(503).json({ error: 'busy' });
    if (stage === 'plan' || stage === 'tplplan') hits.set(k, used + 1); // one website = one count
    return res.status(200).json({ ...out, via: out.by || 'backup' });
  }
  let tpl = null, pickMs = 0; // template mode: only normal Gemini generation without a reference image (backup AIs keep their own flow)
  if (mode === 'generate' && !image && backup !== true && keys.length) { const tp = Date.now(); tpl = await chooseTemplate(prompt, keys).catch(() => null); pickMs = Date.now() - tp; }
  const text = tpl ? slotPrompt(tpl, prompt) : mode === 'generate'
    ? `Create a complete multi-page-ready website (at least a Home page; add About/Contact etc. only if useful).\nRequest: ${prompt}` + (assets && assets.length ? `\nThe user uploaded images, available at these exact paths: ${assets.join(', ')}. Use them with <img src="..." alt="..."> where they fit (for example a profile photo, hero or logo). Never redraw, recreate or replace them with illustrations or SVG, and never invent other image files. Show them in their original colors: no grayscale, sepia, blur or brightness filters, no mix-blend-mode, no color overlays or reduced opacity on them.` : '')
    : `Existing site (name, theme, pages):\n${JSON.stringify(site)}\nCurrent page slug: ${page || '/'}\nRequested change: ${prompt}\nReturn ONLY pages that changed or are new (full code for each), plus a short summary of the change. If site.assets lists uploaded images, use them only by their exact path (for example <img src="assets/logo.webp" alt="...">) when the user asks to use their image, and never invent other image files. Show uploaded images in their original colors: do not add grayscale, sepia, blur or brightness filters, blend modes, color overlays or reduced opacity to them. Keep the design system and navigation consistent; if adding a page, also return the other pages with updated navigation.`;

  const gnotes = [];
  let gfail = null;
  const viaGemini = async () => {
    if (!keys.length) return { code: 502, body: { error: 'ai', why: 'nokey' } };
  const call = (model, k, ms, lowThink) => fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': k },
    signal: AbortSignal.timeout(ms),
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: tpl ? SYSTEM_SLOTS : SYSTEM }] },
      contents: [{ role: 'user', parts: [
        { text: text + (image ? '\nAn image is attached. Analyze its layout, spacing, typography, colors, cards, buttons and sections and build a similar but ORIGINAL implementation. Do not copy logos, brand names, copyrighted assets or proprietary text.' : '') },
        ...(image ? [{ inlineData: { mimeType: image.mime, data: image.data } }] : []),
      ] }],
      generationConfig: genConfig(model, tpl ? SLOT_SCHEMA : SCHEMA[mode], lowThink),
    }),
  });
    // Newest Gemini models first (2.5 models now return 404 for new users). Duplicates removed.
    const allModels = await geminiModelList(keys[0]);
    const t0 = Date.now() - pickMs, STOP = 42000; // stop starting new Gemini calls after STOP ms (Vercel limit is 60s)
    const wait = (ms) => new Promise((x) => setTimeout(x, ms));
    let busyAny = false, sawLimit = false, last = null;
    for (let round = 0; round < 3; round++) {
      let busy = false, retryAfter = 999;
      for (const [ki, k] of keys.entries()) { // key 1 first, then key 2; Groq is only the very last resort
        const live = allModels.filter((m) => !((modelCool.get(ki + '|' + m) || 0) > Date.now())); // skip models that failed in the last 2 minutes
        let order = live.length ? live : allModels;
        if (goodModel && order.includes(goodModel)) order = [goodModel, ...order.filter((m) => m !== goodModel)];
        for (const m of order) {
          const elapsed = Date.now() - t0;
          if (elapsed > STOP) break;
          let r;
          try {
            r = await call(m, k, Math.max(5000, 55000 - elapsed), true);
            if (r.status === 400) r = await call(m, k, Math.max(5000, 55000 - (Date.now() - t0)), false); // thinkingLevel not accepted by this model? retry without it
          }
          catch (e) { gnotes.push(`${ki + 1}:${m.replace('gemini-', '')}:timeout`); continue; }
          gnotes.push(`${ki + 1}:${m.replace('gemini-', '')}:${r.status}`);
          if (r.ok) {
            const data = await r.json().catch(() => ({}));
            const cand = data?.candidates?.[0];
            const out = (cand?.content?.parts || []).filter((p) => !p.thought).map((p) => p.text || '').join('');
            if (out) {
              try { let parsed = JSON.parse(out.replace(/^```json|```$/g, '').trim()); if (tpl) { parsed = slotsToSite(parsed, tpl, assets); if (!parsed) throw new Error('unusable template output'); } goodModel = m; return { parsed, via: 'gemini' }; }
              catch (e) { console.error('JSON parse failed', m, cand?.finishReason, out.slice(-200)); gnotes.push('parse-' + (cand?.finishReason || '')); }
            } else gnotes.push('empty-' + (cand?.finishReason || data?.promptFeedback?.blockReason || 'none'));
            last = { code: 502, body: { error: 'ai', why: 'unusable output' } };
            continue; // unusable answer: try the next model
          }
          if (r.status === 500 || r.status === 503 || r.status === 429) modelCool.set(ki + '|' + m, Date.now() + 120000);
          if (r.status === 500 || r.status === 503) busy = busyAny = true;
          else if (r.status === 429) { // rate limit: Google often says how long to wait (per-minute limits clear quickly)
            sawLimit = true;
            try { const jb = await r.json(); const di = (jb.error?.details || []).find((x) => x.retryDelay); const sec = di ? parseFloat(di.retryDelay) : NaN; if (sec > 0) retryAfter = Math.min(retryAfter, sec); } catch (e) {}
          }
          else { console.error('Gemini HTTP', m, r.status, (await r.text().catch(() => '')).slice(0, 300)); last = { code: 502, body: { error: 'ai', status: r.status } }; }
          if (r.status === 401 || r.status === 403) break; // this key is rejected or blocked: go to the next key
        }
      }
      const waitMs = busy ? 3000 * (round + 1) : sawLimit && retryAfter <= 25 ? Math.ceil(retryAfter * 1000) + 500 : 0;
      if (!waitMs || Date.now() - t0 + waitMs > STOP || round === 2) break;
      await wait(waitMs);
    }
    if (busyAny) return { code: 503, body: { error: 'busy' } };
    if (sawLimit) return { code: 429, body: { error: 'limit' } };
    return last || { code: 502, body: { error: 'ai', why: 'no model' } };
  };

  // Backup AIs (only after Gemini failed): Mistral first (strong coder, more room), Groq if Mistral is unavailable. Env: MISTRAL_API_KEY, GROQ_API_KEY
  const viaBackup = async () => {
    if (image || !haveBackup()) return null; // a reference image cannot be read by the backup models
    const shape = mode === 'generate'
      ? '{"name":"","description":"","theme":{"primaryColor":"","backgroundColor":"","textColor":"","fontFamily":""},"pages":[{"name":"","slug":"","html":"","css":"","javascript":""}]}'
      : '{"summary":"","pages":[{"name":"","slug":"","html":"","css":"","javascript":""}]}';
    const sys = SYSTEM + '\n' + DESIGN + '\nReturn ONLY one JSON object, no other text, in exactly this shape: ' + shape + '\nKeep the code compact: concise CSS and short JavaScript.';
    const got = await aiJson(sys, text, 7000, { stage: 'oneshot', deadline: Date.now() + 52000 });
    const parsed = got && got.data;
    if (!parsed || !Array.isArray(parsed.pages) || !parsed.pages.length) return null;
    const pages = parsed.pages.map((p) => ({ name: String(p.name || 'Home'), slug: String(p.slug || '/'), html: String(p.html || ''), css: String(p.css || ''), javascript: String(p.javascript || '') }));
    return mode === 'generate'
      ? { parsed: { name: String(parsed.name || 'My website'), description: String(parsed.description || ''), theme: parsed.theme && typeof parsed.theme === 'object' ? parsed.theme : {}, pages }, via: got.by }
      : { parsed: { summary: String(parsed.summary || 'Updated'), pages }, via: got.by };
  };

  // Gemini first. If it fails and a backup AI exists, do NOT switch silently: tell the app (error 'fallback') so the user can choose.
  // The app then re-sends with backup:true, which goes straight to the backup AI.
  const hasBackup = haveBackup() && !image;
  let result;
  if (backup === true && hasBackup) {
    result = (await viaBackup()) || { code: 503, body: { error: 'busy' } };
  } else {
    result = await viaGemini();
    if (!result.parsed) {
      gfail = [...new Set(gnotes)].join(' ') + (result.body && result.body.why ? ' ' + result.body.why : '');
      console.error('Gemini failed:', gfail);
      if (hasBackup) result = { code: 503, body: { error: 'fallback' } };
      result = { ...result, body: { ...result.body, why: gfail.trim() } }; // short codes only; shown in the app's Code line
    }
  }
  if (!result.parsed) return res.status(result.code).json(result.body);
  hits.set(k, used + 1); // only successful results count against the limit
  return res.status(200).json({ ...result.parsed, via: result.via, ...(result.via !== 'gemini' ? { gemini: gfail } : {}), ...(mode === 'generate' ? { remaining: Math.max(0, limit - used - 1) } : {}) });
}

module.exports = handler;
module.exports.config = config;
module.exports.backupStage = backupStage;
module.exports.templates = { chooseTemplate, pickByKeywords, slotsToSite, slotPrompt, loadTemplate };
