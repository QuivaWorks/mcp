#!/usr/bin/env python3
"""The mechanical two-way assertion contract artefact 6 exists to be:

1. Extract placeholders from every committed .docx in this directory (ground
   truth — never from 06-merge-tags.json, never from a template's own
   companion .json). An unmatched placeholder renders as an EMPTY STRING,
   silently, so the file itself is the only thing worth trusting.
2. Diff that extraction against 06-merge-tags.json's per-template tag list.
   Anything in the file but not documented is UNRESOLVED (fails). Anything
   documented but not in the file is STALE (fails) — 06-merge-tags.json has
   drifted from the templates it was derived from.
3. Optionally (--unused), report which of contract artefact 1's question keys
   and system_keys no template references at all. This is informational, not
   a failure — the vast majority of a ~200-key data model is expected to be
   unused by 7 documents.

usage:
  python3 verify_merge_tags.py                 # the two-way match, exit 1 on any problem
  python3 verify_merge_tags.py --unused         # also print the unused-key report
  python3 verify_merge_tags.py --plan-repo PATH # override the sibling delivery-plan checkout
"""
import json, re, sys, zipfile
from pathlib import Path

HERE = Path(__file__).parent
DEFAULT_PLAN_REPO = HERE.parent.parent.parent.parent / 'evari-olympus' / '.worktrees' / 'antipodean-delivery-plan'
CONTRACTS = 'docs/antipodean spec/contracts'

LOOP_INTERNAL_ONLY = {'code', 'amount', 'state', 'percent', 'label', '.'}  # loop-body tags whose
# meaning is documented once per loop (in payload_synthesis or a real-field loop), not per
# occurrence — {code} appears inside two different loops with two different real sources.


def extract_tags(docx_path):
    xml = zipfile.ZipFile(docx_path).read('word/document.xml').decode()
    return sorted(set(re.findall(r'\{[^{}]{1,80}\}', xml)))


def strip(tag):
    inner = tag[1:-1]
    if inner.startswith('#') or inner.startswith('/'):
        return inner[1:]
    return inner


def load_artefact(plan_repo, name):
    path = plan_repo / CONTRACTS / name
    if not path.exists():
        return None
    return json.loads(path.read_text())


def main():
    args = sys.argv[1:]
    plan_repo = DEFAULT_PLAN_REPO
    if '--plan-repo' in args:
        plan_repo = Path(args[args.index('--plan-repo') + 1])
    show_unused = '--unused' in args

    a6 = load_artefact(plan_repo, '06-merge-tags.json')
    if a6 is None:
        print(f'FATAL: could not find 06-merge-tags.json under {plan_repo / CONTRACTS}')
        print('Pass --plan-repo /path/to/antipodean-delivery-plan if the checkout is elsewhere.')
        return 2

    documented = {t['key']: t for t in a6['templates']}
    problems = 0

    print('=== two-way match: extracted placeholders vs. 06-merge-tags.json ===\n')
    all_extracted = {}
    for key, spec in documented.items():
        docx_path = HERE / f'{key}.docx'
        if not docx_path.exists():
            print(f'{key}: MISSING .docx at {docx_path}')
            problems += 1
            continue
        tags = extract_tags(docx_path)
        all_extracted[key] = tags
        names = {strip(t) for t in tags} - {''}

        documented_names = {t['tag'].split(' (in ')[0] for t in spec['tags']}
        # loop array names are documented via the `loop: true` tag entries, whose 'tag' IS the
        # array name — plus per-occurrence loop-body fields recorded as "field (in array)".
        loop_body_names = {t['tag'].split(' (in ')[0] for t in spec['tags'] if ' (in ' in t['tag']}
        documented_all = documented_names | loop_body_names | LOOP_INTERNAL_ONLY

        unresolved = sorted(n for n in names if n not in documented_all)
        stale = sorted(n for n in documented_names if n not in names and n not in LOOP_INTERNAL_ONLY)

        print(f'{key}: {len(tags)} placeholders extracted, {len(names)} distinct names')
        if unresolved:
            print(f'  UNRESOLVED (in file, not in 06-merge-tags.json): {unresolved}')
            problems += 1
        if stale:
            print(f'  STALE (in 06-merge-tags.json, not in file): {stale}')
            problems += 1
        if not unresolved and not stale:
            print('  OK — every tag documented, every documented tag present')
    print()

    if show_unused:
        print('=== informational: artefact 1 keys no template references ===\n')
        a1 = load_artefact(plan_repo, '01-key-list.json')
        if a1 is None:
            print('  (skipped — 01-key-list.json not found)')
        else:
            used = {strip(t) for tags in all_extracted.values() for t in tags} - {''} | LOOP_INTERNAL_ONLY
            question_keys = {k['schema_key'] for k in a1.get('keys', []) if k.get('schema_key')}
            system_keys = {k['schema_key'] for k in a1.get('system_keys', {}).get('keys', [])}
            unused_q = sorted(question_keys - used)
            unused_s = sorted(system_keys - used)
            print(f'  {len(unused_q)}/{len(question_keys)} question keys unused by any document')
            print(f'  {len(unused_s)}/{len(system_keys)} system keys unused by any document')
            print('  (expected — see 06-merge-tags.md "The two-way match" for the categories worth naming)')
        print()

    print(f'{"FAIL — " + str(problems) + " problem(s)" if problems else "PASS — two-way match holds for all seven templates"}')
    return 1 if problems else 0


if __name__ == '__main__':
    sys.exit(main())
