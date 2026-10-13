# Templates in Site Pilot

100 ready-made templates live in `api/_templates/` (one JSON per template + `catalog.json`).
When someone generates a website, `api/gemini.js` does this:

1. `chooseTemplate()` - a quick Gemini call picks the closest template (any language, Hindi/Hinglish too). If it fails, a keyword match is used.
2. Gemini rewrites the template content (text, prices, brand, colours via CSS overrides) for the user's request. Layout, CSS and JavaScript of the template are kept.
3. `applyTemplate()` merges the result: template CSS + overrides, template JS unless the AI returned valid JS.
4. If this fails on all Gemini models, the old flow (backup AI / error screen) runs as before. Edit mode, reference-image mode and backup AIs are unchanged.

Add or update templates: `python3 scripts/build-templates.py /path/to/100-free-html-templates-main`
(this rewrites `api/_templates/`). `vercel.json` makes sure the folder is shipped with the function.

Templates: MIT licence, (c) mmrahmanbappi - see `api/_templates/LICENSE` (keep this file).
