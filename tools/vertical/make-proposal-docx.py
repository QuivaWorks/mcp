import zipfile, re, sys

OUT = '/Users/aseempareek/Documents/Evari/mcp/verticals/crm/document_templates/proposal.docx'

def p(text, bold=False, size=None, align=None):
    rpr = '<w:rPr>'
    if bold: rpr += '<w:b/>'
    if size: rpr += f'<w:sz w:val="{size}"/>'
    rpr += '</w:rPr>'
    ppr = f'<w:pPr><w:jc w:val="{align}"/></w:pPr>' if align else ''
    return f'<w:p>{ppr}<w:r>{rpr}<w:t xml:space="preserve">{text}</w:t></w:r></w:p>'

body = ''.join([
    p('Proposal', bold=True, size='48', align='center'),
    p('{deal_name}', bold=True, size='32', align='center'),
    p(''),
    p('Prepared for'),
    p('{company_name}', bold=True),
    p('Attention: {contact_name}'),
    p(''),
    p('Prepared by {deal_owner_name} on {today}'),
    p(''),
    p('Summary', bold=True, size='28'),
    p('This proposal sets out our recommendation for {company_name}, following our '
      'discussions with {contact_name}. It covers the scope of work, the commercial '
      'terms, and the next steps required to proceed.'),
    p(''),
    p('Commercial terms', bold=True, size='28'),
    p('Total value: {deal_value} {currency}'),
    p('Expected completion: {close_date}'),
    p(''),
    p('Next steps', bold=True, size='28'),
    p('Please review the terms above. To proceed, return a signed copy to '
      '{deal_owner_name}. This proposal is valid until {close_date}.'),
    p(''),
    p('{company_name} — {deal_name} — prepared {today}'),
])

document = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
    f'<w:body>{body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body>'
    '</w:document>'
)

content_types = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    '<Default Extension="xml" ContentType="application/xml"/>'
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
    '</Types>'
)

rels = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
    '</Relationships>'
)

with zipfile.ZipFile(OUT, 'w', zipfile.ZIP_DEFLATED) as z:
    z.writestr('[Content_Types].xml', content_types)
    z.writestr('_rels/.rels', rels)
    z.writestr('word/document.xml', document)

# Read it back and extract the placeholders the renderer will actually look for.
xml = zipfile.ZipFile(OUT).read('word/document.xml').decode()
found = sorted(set(re.findall(r'\{[^{}]{1,60}\}', xml)))
print(f'wrote {OUT}')
print(f'placeholders in the DOCX ({len(found)}):')
for f in found:
    print('  ' + f)
