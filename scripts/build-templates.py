#!/usr/bin/env python3
"""Converts 100-free-html-templates (single-file HTML) into Site Pilot page JSON.

Usage: python3 scripts/build-templates.py /path/to/100-free-html-templates-main
Output: api/_templates/<id>.json  ({id,name,category,html,css,javascript})
        api/_templates/catalog.json  (small list the AI uses to pick a template)
Template source: MIT licence, (c) mmrahmanbappi (see api/_templates/LICENSE).
"""
import re, sys, json, glob, os, html as H

src = sys.argv[1] if len(sys.argv) > 1 else '100-free-html-templates-main'
out = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'api', '_templates')
os.makedirs(out, exist_ok=True)
for f in glob.glob(out + '/*.json'): os.remove(f)

catalog = []
for path in sorted(glob.glob(src + '/*/*/index.html')):
    cat, slug = path.split(os.sep)[-3:-1]
    raw = open(path, encoding='utf-8').read()
    head, body = raw.split('<body>', 1) if '<body>' in raw else raw.split('<body', 1)
    body = body.rsplit('</body>', 1)[0]

    title = (re.search(r'<title>(.*?)</title>', head, re.S) or [0, slug])[1]
    desc = (re.search(r'<meta name="description" content="(.*?)"', head, re.S) or [0, ''])[1]
    kw = (re.search(r'<meta name="keywords" content="(.*?)"', head, re.S) or [0, ''])[1]
    brand = title.split('|')[-1].strip() if '|' in title else slug

    # css: google fonts -> @import (the builder's page wrapper has no <link> support), then the <style> block
    css = ''.join('@import url("%s");\n' % H.unescape(u) for u in re.findall(r'<link href="(https://fonts\.googleapis\.com/css2[^"]*)"', head))
    css += '\n'.join(re.findall(r'<style[^>]*>(.*?)</style>', head, re.S)).strip()

    # strip template-only parts
    body = re.sub(r'<!--\s*Template notice bar.*?-->\s*', '', body, flags=re.S)
    body = re.sub(r'<div id="template-bar".*?</div>\s*', '', body, flags=re.S)
    body = re.sub(r'\s*[·|•]\s*<a [^>]*100-free-html-templates[^>]*>[^<]*</a>', '', body)
    body = re.sub(r'<a [^>]*100-free-html-templates[^>]*>[^<]*</a>', '', body)
    body = re.sub(r'<script type="application/ld\+json">.*?</script>\s*', '', body, flags=re.S)
    js = '\n'.join(s.strip() for s in re.findall(r'<script(?![^>]*\bsrc=)[^>]*>(.*?)</script>', body, re.S))
    body = re.sub(r'<script(?![^>]*\bsrc=)[^>]*>.*?</script>\s*', '', body, flags=re.S).strip()

    assert 'mmrahmanbappi' not in body and '<body' not in body.lower(), path
    tid = '%s--%s' % (cat, slug)
    name = slug.replace('-', ' ').title()
    json.dump({'id': tid, 'name': name, 'category': cat, 'brand': brand, 'html': body, 'css': css, 'javascript': js},
              open('%s/%s.json' % (out, tid), 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
    # short search tags: keyword meta without the filler words every template shares
    tags = []
    for k in kw.split(','):
        k = re.sub(r'\b(free|html|template|templates|website|websites|one page|single|page|css|bootstrap|responsive|download|simple|modern)\b', ' ', k, flags=re.I)
        k = re.sub(r'\s+', ' ', k).strip().lower()
        if len(k) > 2 and k not in tags: tags.append(k)
    catalog.append({'id': tid, 'name': name, 'tags': tags[:4]})

json.dump(catalog, open(out + '/catalog.json', 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
print(len(catalog), 'templates written to', os.path.abspath(out))
