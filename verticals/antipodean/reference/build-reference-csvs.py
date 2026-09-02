#!/usr/bin/env python3
"""Normalise Antipodean's supplied rate CSVs into loader-shaped ones.

The supplied files cannot be fed to `recordload` directly:

  * Rates.csv is a two-level sheet flattened into one header row, so
    "Question Set", "Min Excess", "Endorsements" and "Wording" each appear three
    times. recordload maps a column by header NAME into a map, so a duplicate
    silently resolves to the LAST occurrence — every product would read General
    Property's column and nothing would say so.
  * Money arrives as "$1,000,000" and "$-", which `as: "number"` rejects
    (strconv.ParseFloat), and eligibility arrives with one row's "no" lowercased.
  * "Rates by hazard" carries 79 rows of "Not in use" against 21 real ones.

Everything here is mechanical: rename, coerce, drop empty rows. No rate, factor
or threshold is computed — the premium formula is NOT in any supplied file (see
the delivery plan §4.2) and must not be inferred here.

    python3 build-reference-csvs.py [source-dir] [out-dir]

Default source-dir is the delivery plan's spec folder in evari-olympus.
"""

import csv
import os
import re
import sys

DEFAULT_SRC = os.path.expanduser(
    "~/Documents/GitHub/evari-olympus/.worktrees/antipodean-delivery-plan/"
    "docs/antipodean spec"
)


def money(cell):
    """"$1,000,000" -> 1000000. "$-" and "" -> "" (absent, not zero)."""
    text = (cell or "").strip().replace("$", "").replace(",", "").strip()
    if text in ("", "-"):
        return ""
    try:
        return f"{float(text):g}"
    except ValueError:
        return ""


def percent(cell):
    """"10%" -> 10. Stored as the percentage, the way the sheet states it."""
    text = (cell or "").strip().rstrip("%").strip()
    try:
        return f"{float(text):g}"
    except ValueError:
        return ""


def codes(cell):
    """"AUIT25005, AUIT25018" -> "AUIT25005;AUIT25018" (recordload's list)."""
    parts = [p.strip() for p in re.split(r"[,;]", cell or "") if p.strip()]
    return ";".join(parts)


def eligibility(cell):
    """yes / no / refer. One AH row ships "no" lowercased; normalise all three."""
    return (cell or "").strip().lower()


# Rates.csv column offsets. The header row names the product at the offset the
# block starts, then repeats generic names, so the offsets are the contract.
PRODUCTS = [
    ("itpi", 3, [
        (4, "question_set", str), (5, "hazard_class", str),
        (6, "min_excess", money), (7, "min_premium", money),
        (8, "default_limit_pi", money), (9, "default_ri_pi", str),
        (10, "default_limit_ppl", money), (11, "endorsements", codes),
        (12, "wording", str),
    ]),
    ("ah", 13, [
        (14, "question_set", str), (15, "hazard_class", str),
        (16, "min_excess", money), (17, "min_premium", money),
        # "$1m PI $10m PL" — a sentence, not an amount. Kept verbatim.
        (18, "default_limit", str), (19, "endorsements", codes),
        (20, "wording", str),
    ]),
    ("gp", 21, [
        (22, "question_set", str), (23, "hazard_class", str),
        (24, "min_excess", money), (25, "min_premium", money),
        (26, "default_limit", money), (27, "endorsements", codes),
        (28, "wording", str),
    ]),
]


def build_occupations(src, out):
    rows = [r for r in csv.reader(open(src, encoding="utf-8-sig"))][1:]
    rows = [r for r in rows if any(c.strip() for c in r)]

    header = ["occupation_code", "occupation_label", "occupation_category",
              "occupation_active"]
    for prefix, _, cols in PRODUCTS:
        header.append(f"{prefix}_eligibility")
        header += [f"{prefix}_{name}" for _, name, _ in cols]

    with open(out, "w", newline="", encoding="utf-8") as fh:
        writer = csv.writer(fh)
        writer.writerow(header)
        for r in rows:
            # Nothing in the source retires an occupation, so every row is
            # active. The field exists because a bound policy outlives a
            # withdrawn occupation (artefact 1) and it will be needed later.
            line = [r[1].strip(), r[0].strip(), r[2].strip(), "true"]
            for prefix, flag, cols in PRODUCTS:
                line.append(eligibility(r[flag]))
                line += [fn(r[i]) for i, _, fn in cols]
            writer.writerow(line)
    return len(rows)


def build_hazard_rates(src, out):
    rows = [[c.strip() for c in r]
            for r in csv.reader(open(src, encoding="utf-8-sig"))
            if any(c.strip() for c in r)][1:]
    kept = [r for r in rows if r[1] and r[1].lower() != "not in use"]
    with open(out, "w", newline="", encoding="utf-8") as fh:
        writer = csv.writer(fh)
        writer.writerow(["hazard_class", "rate_pi", "rate_pl"])
        for r in kept:
            writer.writerow([r[0], r[1], r[2]])
    return len(kept), len(rows) - len(kept)


def build_size_discounts(src, out):
    rows = [[c.strip() for c in r]
            for r in csv.reader(open(src, encoding="utf-8-sig"))
            if any(c.strip() for c in r)][1:]
    with open(out, "w", newline="", encoding="utf-8") as fh:
        writer = csv.writer(fh)
        writer.writerow(["band_id", "revenue_min", "revenue_max",
                         "discount_percent"])
        for i, r in enumerate(rows, start=1):
            lo, hi = money(r[0]), money(r[1])
            # "$-" is the open bottom of band 1, which is zero revenue.
            writer.writerow([f"itpi_size_{i:02d}", lo or "0", hi, percent(r[2])])
    return len(rows)


def build_excess_factors(src, out):
    rows = [[c.strip() for c in r]
            for r in csv.reader(open(src, encoding="utf-8-sig"))
            if any(c.strip() for c in r)][1:]
    with open(out, "w", newline="", encoding="utf-8") as fh:
        writer = csv.writer(fh)
        writer.writerow(["excess", "factor"])
        for r in rows:
            writer.writerow([money(r[0]), r[1]])
    return len(rows)


def main():
    src = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_SRC
    out = sys.argv[2] if len(sys.argv) > 2 else os.path.dirname(
        os.path.abspath(__file__))
    j = lambda *p: os.path.join(*p)

    n = build_occupations(j(src, "Rates.csv"), j(out, "occupations.csv"))
    print(f"occupations.csv            {n} rows")
    kept, skipped = build_hazard_rates(
        j(src, "ITPI - Rates by hazard.csv"), j(out, "itpi-hazard-rates.csv"))
    print(f"itpi-hazard-rates.csv      {kept} rows ({skipped} 'Not in use' dropped)")
    n = build_size_discounts(
        j(src, "ITPI Size Discounts.csv"), j(out, "itpi-size-discounts.csv"))
    print(f"itpi-size-discounts.csv    {n} rows")
    n = build_excess_factors(
        j(src, "ITPI- Excess Factors.csv"), j(out, "itpi-excess-factors.csv"))
    print(f"itpi-excess-factors.csv    {n} rows")


if __name__ == "__main__":
    main()
