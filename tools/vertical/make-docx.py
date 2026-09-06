#!/usr/bin/env python3
"""Build a minimal, valid .docx from a JSON plan, then extract the placeholders
back out of the file that was written.

That last step is the point of this script. This repo exists because a document
template passed every mechanical check — published, triggered, generated, byte
sizes differing between runs — and produced blank PDFs, because the payload keys
were snake_case and the DOCX placeholders were camelCase. Zero overlap, no error.

An unmatched placeholder renders as an EMPTY STRING, silently. So the list this
script prints is the payload contract: those exact names, no others. Never write
the payload from the plan you intended — write it from what came out of the file.

usage: python3 tools/vertical/make-docx.py <plan.json> [--json]

A plan is:
  { "out": "<path>.docx",
    "blocks": [ {"text": "...", "bold": true, "size": 48, "align": "center"}, ... ] }
`size` is half-points (48 = 24pt). An empty text gives a blank line.
"""
import json, re, sys, zipfile

XML_ESCAPES = (('&', '&amp;'), ('<', '&lt;'), ('>', '&gt;'))


def esc(s):
    for a, b in XML_ESCAPES:
        s = s.replace(a, b)
    return s


def para(text='', bold=False, size=None, align=None):
    rpr = '<w:rPr>'
    if bold:
        rpr += '<w:b/>'
    if size:
        rpr += f'<w:sz w:val="{size}"/>'
    rpr += '</w:rPr>'
    ppr = f'<w:pPr><w:jc w:val="{align}"/></w:pPr>' if align else ''
    return f'<w:p>{ppr}<w:r>{rpr}<w:t xml:space="preserve">{esc(text)}</w:t></w:r></w:p>'


CONTENT_TYPES = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    '<Default Extension="xml" ContentType="application/xml"/>'
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
    '</Types>'
)

RELS = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
    '</Relationships>'
)


def build(plan):
    body = ''.join(
        para(b.get('text', ''), b.get('bold', False), b.get('size'), b.get('align'))
        for b in plan['blocks']
    )
    document = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
        f'<w:body>{body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body>'
        '</w:document>'
    )
    out = plan['out']
    with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
        z.writestr('[Content_Types].xml', CONTENT_TYPES)
        z.writestr('_rels/.rels', RELS)
        z.writestr('word/document.xml', document)

    # Re-open the written file. Not the plan — the artefact.
    xml = zipfile.ZipFile(out).read('word/document.xml').decode()
    found = sorted(set(re.findall(r'\{[^{}]{1,60}\}', xml)))
    return out, found


if __name__ == '__main__':
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    as_json = '--json' in sys.argv
    if len(args) != 1:
        print(__doc__)
        sys.exit(1)
    plan = json.load(open(args[0]))
    out, found = build(plan)
    if as_json:
        print(json.dumps({'out': out, 'placeholders': found}, indent=2))
    else:
        print(f'wrote {out}')
        print(f'placeholders extracted FROM THE FILE ({len(found)}):')
        for f in found:
            print('  ' + f)
