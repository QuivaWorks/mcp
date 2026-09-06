#!/usr/bin/env python3
"""Build the 7 Antipodean DOCX templates (wave 7) from a content plan below, then
extract the placeholders back OUT of the written files, exactly as
tools/vertical/make-docx.py does for the scalar-only templates already in this
repo. This script additionally emits real <w:tbl> tables with docxtemplater
loop syntax, which make-docx.py cannot do (paragraphs only) — see
contract artefact 6 (docs/antipodean spec/contracts/06-merge-tags.json) for why
that capability had to be proven before these were authored, and
p0d-probe-loops (a throwaway wave-0 probe run by another agent this session,
its own artefacts already cleaned up) for the first confirmation.

Never hand-author the payload from this plan's tag list. The payload contract
is what THIS SCRIPT PRINTS after re-opening the written .docx, and that is what
each template's companion .json's _notes.placeholders records and what
06-merge-tags.json's two-way match is checked against
(verify_merge_tags.py in this directory).

usage: python3 build_templates.py [--json]
"""
import json, re, sys, zipfile
from pathlib import Path

OUT_DIR = Path(__file__).parent

XML_ESCAPES = (('&', '&amp;'), ('<', '&lt;'), ('>', '&gt;'))


def esc(s):
    for a, b in XML_ESCAPES:
        s = s.replace(a, b)
    return s


def para(text='', bold=False, size=None, align=None, italic=False):
    rpr = '<w:rPr>'
    if bold:
        rpr += '<w:b/>'
    if italic:
        rpr += '<w:i/>'
    if size:
        rpr += f'<w:sz w:val="{size}"/>'
    rpr += '</w:rPr>'
    ppr = f'<w:pPr><w:jc w:val="{align}"/></w:pPr>' if align else ''
    return f'<w:p>{ppr}<w:r>{rpr}<w:t xml:space="preserve">{esc(text)}</w:t></w:r></w:p>'


def cell(text, w=2500, bold=False):
    return (f'<w:tc><w:tcPr><w:tcW w:w="{w}" w:type="dxa"/></w:tcPr>'
            f'{para(text, bold=bold)}</w:tc>')


def row(cells, w=2500):
    return '<w:tr>' + ''.join(cell(c, w) if not isinstance(c, tuple) else cell(c[0], w, bold=c[1]) for c in cells) + '</w:tr>'


BORDERS = ('<w:tblBorders>' + ''.join(
    f'<w:{s} w:val="single" w:sz="4" w:space="0" w:color="auto"/>'
    for s in ('top', 'left', 'bottom', 'right', 'insideH', 'insideV')) + '</w:tblBorders>')


def table(rows, ncols, w=2500):
    grid = '<w:tblGrid>' + ''.join(f'<w:gridCol w:w="{w}"/>' for _ in range(ncols)) + '</w:tblGrid>'
    return ('<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/>' + BORDERS + '</w:tblPr>'
            + grid + ''.join(rows) + '</w:tbl>')


def doc(blocks):
    body = ''.join(blocks)
    return ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
            f'<w:body>{body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body>'
            '</w:document>')


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


def write_docx(path, blocks):
    document = doc(blocks)
    with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED) as z:
        z.writestr('[Content_Types].xml', CONTENT_TYPES)
        z.writestr('_rels/.rels', RELS)
        z.writestr('word/document.xml', document)
    # Re-open the WRITTEN file, never the plan. This is the only list that matters.
    xml = zipfile.ZipFile(path).read('word/document.xml').decode()
    return sorted(set(re.findall(r'\{[^{}]{1,80}\}', xml)))


def header(title, subtitle=None):
    b = [para('ANTIPODEAN', bold=True, size=20, align='center'),
         para(title, bold=True, size=32, align='center')]
    if subtitle:
        b.append(para(subtitle, italic=True, align='center'))
    b.append(para(''))
    return b


def kv(label, tag):
    return para(f'{label}: {{{tag}}}')


# ---------------------------------------------------------------------------
# 1. tpl_quotation_schedule — Quotation Schedule
# ---------------------------------------------------------------------------
def build_quotation_schedule():
    b = header('QUOTATION SCHEDULE')
    b += [
        kv('Quote reference', 'quote_reference'),
        kv('Policyholder', 'gen_policyholder_name'),
        kv('Occupation', 'gen_occupation'),
        kv('Quote valid until', 'quote_validity_expiry'),
        kv('Outcome', 'outcome_status'),
        kv('Total payable', 'total_payable'),
        para(''),
        para('Referral reasons (if any):', bold=True),
        para('{#broker_reasons}'),
        para('  - {.}'),
        para('{/broker_reasons}'),
        para(''),
        para('This quotation is issued subject to Antipodean\'s policy wording and the '
             'answers recorded on this submission. It does not itself constitute cover.'),
    ]
    return b


# ---------------------------------------------------------------------------
# 2. tpl_policy_schedule — Master Policy Schedule (the big one: 4 loops)
# ---------------------------------------------------------------------------
def build_policy_schedule():
    b = header('MASTER POLICY SCHEDULE')
    b += [
        kv('Policy number', 'policy_number'),
        kv('Product', 'product_code'),
        kv('Period of insurance — from', 'inception_date'),
        kv('Period of insurance — to', 'expiration_date'),
        kv('Total payable', 'total_payable'),
        para(''),
        para('Sub-limits', bold=True, size=24),
    ]
    # Loop A — single-row loop: open/close tags inside cells of ONE <w:tr>.
    b.append(table([
        row([('CODE', True), ('AMOUNT', True)]),
        row(['{#sub_limits_list}{code}', '{amount}{/sub_limits_list}']),
    ], 2))
    b.append(para(''))
    b.append(para('Revenue by state (stamp duty apportionment)', bold=True, size=24))
    # Loop B — whole-row-spanning loop: open tag in its own row, close tag in its own row.
    b.append(table([
        row([('STATE', True), ('PERCENT', True)]),
        row(['{#state_splits}', '']),
        row(['{state}', '{percent}']),
        row(['{/state_splits}', '']),
    ], 2))
    b.append(para(''))
    b.append(para('Clauses attaching to this policy', bold=True, size=24))
    b.append(para('{#clause_codes}'))
    b.append(para('  - {.}'))
    b.append(para('{/clause_codes}'))
    b.append(para(''))
    b.append(para('Endorsements attaching to this policy', bold=True, size=24))
    b.append(para('{#endorsement_codes}'))
    b.append(para('  - {.}'))
    b.append(para('{/endorsement_codes}'))
    return b


# ---------------------------------------------------------------------------
# 3. tpl_cert_currency — Certificate of Currency
# ---------------------------------------------------------------------------
def build_cert_currency():
    b = header('CERTIFICATE OF CURRENCY')
    b += [
        kv('Policy number', 'policy_number'),
        kv('Insured', 'gen_policyholder_name'),
        kv('Occupation', 'gen_occupation'),
        kv('Period of insurance — from', 'inception_date'),
        kv('Period of insurance — to', 'expiration_date'),
        para(''),
        para('Limits of indemnity', bold=True, size=24),
    ]
    b.append(table([
        row([('CODE', True), ('AMOUNT', True)]),
        row(['{#limits_summary_list}{code}', '{amount}{/limits_summary_list}']),
    ], 2))
    b.append(para(''))
    b.append(para('This certificate is evidence of insurance current at the date of issue. '
                   'It is not evidence of the full terms, conditions or exclusions of the policy.'))
    return b


# ---------------------------------------------------------------------------
# 4. tpl_tax_invoice — Tax Invoice (Payment on Account)
# ---------------------------------------------------------------------------
def build_tax_invoice():
    b = header('TAX INVOICE', 'Payment on account')
    b += [
        kv('Invoice number', 'invoice_number'),
        kv('Policy number', 'policy_number'),
        kv('Due date', 'due_date'),
        kv('Void deadline (unpaid after this date voids the policy)', 'void_deadline'),
        kv('Payment terms', 'payment_type'),
        kv('Amount due', 'amount_due'),
        para(''),
        para('Premium breakdown', bold=True, size=24),
    ]
    # Loop C — whole-row-spanning loop over a SYNTHESISED array (see artefact 6).
    b.append(table([
        row([('ITEM', True), ('AMOUNT', True)]),
        row(['{#premium_breakdown_list}', '']),
        row(['{label}', '{amount}']),
        row(['{/premium_breakdown_list}', '']),
    ], 2))
    b.append(para(''))
    b.append(para('Payment details', bold=True, size=24))
    b.append(para('[Bank EFT details — Antipodean to supply. No BSB/account/reference '
                   'field exists in any config wave 1 built; not a merge tag. See '
                   'contract artefact 6, "content gaps".]'))
    return b


# ---------------------------------------------------------------------------
# 5. tpl_mta_schedule — Endorsement Schedule (no loop — one MTA per document)
# ---------------------------------------------------------------------------
def build_mta_schedule():
    b = header('ENDORSEMENT SCHEDULE')
    b += [
        kv('Policy number', 'policy_number'),
        kv('Endorsement reference', 'mta_reference'),
        kv('Revision index', 'revision_index'),
        kv('Effective date', 'effective_date'),
        kv('Status', 'mta_status'),
        para(''),
        para('Nature of change', bold=True, size=24),
        kv('Description', 'change_description'),
        para(''),
        kv('Premium adjustment', 'premium_adjustment'),
    ]
    return b


# ---------------------------------------------------------------------------
# 6. tpl_cancellation_notice — Cancellation Notice (no loop; one conditional)
# ---------------------------------------------------------------------------
def build_cancellation_notice():
    b = header('CANCELLATION NOTICE')
    b += [
        kv('Policy number', 'policy_number'),
        kv('Cancellation effective date', 'effective_date'),
        kv('Refund amount', 'refund_amount'),
        kv('Reason', 'canc_reason'),
        para('{#canc_reason_other}'),
        kv('  Other — details', 'canc_reason_other'),
        para('{/canc_reason_other}'),
        para(''),
        para('This policy has been cancelled with effect from the date shown above. '
             'No cover is provided for any event occurring on or after that date.'),
    ]
    return b


# ---------------------------------------------------------------------------
# 7. tpl_void_notice — Notice of Voidance (no loop; static reason)
# ---------------------------------------------------------------------------
def build_void_notice():
    b = header('FORMAL NOTICE OF VOIDANCE')
    b += [
        kv('Policy number', 'policy_number'),
        kv('Original inception date', 'inception_date'),
        kv('Outstanding invoice', 'outstanding_invoice_number'),
        para(''),
        para('Reason for voidance', bold=True, size=24),
        para('This policy is voided ab initio for non-payment of the premium on account '
             'by the void deadline stated on the tax invoice referenced above, in '
             'accordance with the terms of issuance. There is no stored void_reason field '
             '— the only voidance path this build implements is the day-61 non-payment '
             'timer, so the reason is fixed prose, not a merge tag. See contract '
             'artefact 6, "content gaps".'),
        para(''),
        para('This policy is treated as if it never incepted. Any claim arising during '
             'the original period of insurance is not covered.'),
    ]
    return b


TEMPLATES = {
    'tpl_quotation_schedule': {
        'label': 'Quotation Schedule',
        'build': build_quotation_schedule,
        'output_name': 'quotation-schedule-{quote_reference}',
        'output_folder': 'antipodean.quotes',
        'source_record': 'submission_config (answers, quote_reference) + decision_config (outcome, quote_validity_expiry, total_payable, broker_reasons). Generated publisher-side at the ACCEPT/REFER decision.',
    },
    'tpl_policy_schedule': {
        'label': 'Master Policy Schedule',
        'build': build_policy_schedule,
        'output_name': 'policy-schedule-{policy_number}',
        'output_folder': 'antipodean.policies',
        'source_record': 'policy_config (policy_number, dates) + decision_config.terms (sub_limits, clause_codes, endorsement_codes) + submission_config (revenue-by-state, for state_splits synthesis). Generated at bind.',
    },
    'tpl_cert_currency': {
        'label': 'Certificate of Currency',
        'build': build_cert_currency,
        'output_name': 'certificate-{policy_number}',
        'output_folder': 'antipodean.policies',
        'source_record': 'policy_config + submission_config (via decision_config.submission_id join, for policyholder/occupation) + decision_config.terms.sub_limits. Generated on demand post-bind.',
    },
    'tpl_tax_invoice': {
        'label': 'Tax Invoice (Payment on Account)',
        'build': build_tax_invoice,
        'output_name': 'invoice-{invoice_number}',
        'output_folder': 'antipodean.invoices',
        'source_record': 'invoice_config (invoice_number, dates, amount_due) + decision_config (base_premium, fsl_levy, gst, stamp_duty, broker_commission, total_payable — flat fields, synthesised into premium_breakdown_list). Generated at bind alongside the invoice.',
    },
    'tpl_mta_schedule': {
        'label': 'Endorsement Schedule',
        'build': build_mta_schedule,
        'output_name': 'endorsement-{mta_reference}',
        'output_folder': 'antipodean.mta',
        'source_record': 'mta_config. Generated when an MTA binds.',
    },
    'tpl_cancellation_notice': {
        'label': 'Cancellation Notice',
        'build': build_cancellation_notice,
        'output_name': 'cancellation-{policy_number}',
        'output_folder': 'antipodean.cancellations',
        'source_record': 'cancellation_config. Generated when a cancellation is confirmed.',
    },
    'tpl_void_notice': {
        'label': 'Notice of Voidance',
        'build': build_void_notice,
        'output_name': 'void-notice-{policy_number}',
        'output_folder': 'antipodean.policies',
        'source_record': 'policy_config (policy_number, inception_date) + invoice_config (invoice_number, joined via policy_id), read by flow 4 policy-void at the day-61 timer.',
    },
}


def main():
    as_json = '--json' in sys.argv
    results = {}
    for key, spec in TEMPLATES.items():
        out_path = OUT_DIR / f'{key}.docx'
        placeholders = write_docx(out_path, spec['build']())
        results[key] = {'out': str(out_path), 'placeholders': placeholders, 'count': len(placeholders)}
    if as_json:
        print(json.dumps(results, indent=2))
    else:
        for key, r in results.items():
            print(f'wrote {r["out"]}  ({r["count"]} placeholders)')
            for p in r['placeholders']:
                print('   ', p)
    return results


if __name__ == '__main__':
    main()
