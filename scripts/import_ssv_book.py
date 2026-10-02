"""Parse the SSV Book .xlsx export into vehicle rows for Supabase.

Usage:
  python scripts/import_ssv_book.py "SSV Book.xlsx"
Writes import/vehicles.json and prints a per-dealer summary. Upload it from the app: menu > Import history file.

Dealer tabs share one layout: A = date header or invoice #, D = stock, F-I = year/make/model/color,
L = VIN, N = service code, O/P = notes. Rows sit under the most recent date header above them.
"""
import datetime as dt
import json
import re
import sys
from pathlib import Path

import openpyxl

SKIP_TABS = {'WSs', 'WSs OLD', 'WSs Archive 2023'}
ACTIVE = {'MRS', 'SJD', 'DM', 'H', 'DayG', 'SG'}
PLACEHOLDERS = {'stk#', '//', 'vin#', 'stk #', 'vin #'}
DATE_RE = re.compile(r'^\s*(\d{1,2})/(\d{1,2})/(\d{2,4})\s*$')


def cell(row, i):
    v = row[i] if i < len(row) else None
    if v is None:
        return ''
    if isinstance(v, float) and v.is_integer():
        v = int(v)
    s = str(v).strip()
    return '' if s.lower() in PLACEHOLDERS else s


def as_date(v):
    if isinstance(v, (dt.datetime, dt.date)):
        return v.date() if isinstance(v, dt.datetime) else v
    m = DATE_RE.match(str(v or ''))
    if not m:
        return None
    mo, d, y = map(int, m.groups())
    y = y + 2000 if y < 100 else y
    try:
        return dt.date(y, mo, d)
    except ValueError:
        return None


def is_dealer_tab(ws):
    hdr = [str(c.value or '').strip().lower() for c in next(ws.iter_rows(min_row=1, max_row=1))]
    return len(hdr) > 11 and hdr[3] == 'stk #' and hdr[11] == 'vin #'


def parse(path):
    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    dealers, vehicles = [], []
    for ws in wb.worksheets:
        if ws.title in SKIP_TABS or not is_dealer_tab(ws):
            continue
        code = ws.title.strip()
        rows = list(ws.iter_rows(values_only=True))
        a1 = cell(rows[0], 0)
        emails = ', '.join(e for r in rows[1:4] for e in [cell(r, 0), cell(r, 5)] if '@' in e)
        dealers.append({'code': code, 'name': a1 if len(a1) > 4 else code, 'billing_emails': emails or None,
                        'active': code in ACTIVE})
        current = None
        for r in rows[1:]:
            d = as_date(r[0] if r else None)
            if d:
                current = d
                continue
            stock, year, make, model, color, vin = (cell(r, i) for i in (3, 5, 6, 7, 8, 11))
            if not (stock or vin or model):
                continue
            a = cell(r, 0)
            code_ = cell(r, 13).upper() or None
            notes = ' '.join(x for x in (cell(r, 14), cell(r, 15), cell(r, 16)) if x) or None
            low = (a + ' ' + (notes or '')).lower()
            inv = a if re.fullmatch(r'\d{3,6}', a) else None
            if 'void' in low:
                status = 'voided'
            elif 'wholesale' in low:
                status = 'wholesale'
            elif 'declin' in low:
                status = 'declined'
            elif 'inspect' in low:
                status = 'waiting_inspection'
            elif inv:
                status = 'done'
            else:
                status = 'other'
            day = current or dt.date.today()
            vehicles.append({
                'dealer_code': code, 'stock': stock.upper() or None, 'vin': vin.upper() or None,
                'year': year or None, 'make': make or None, 'model': model or None, 'color': color or None,
                'service_code': code_, 'status': status,
                'status_note': None if status != 'other' else 'Imported: no invoice #',
                'notes': notes, 'legacy_invoice_no': inv,
                'found_at': f'{day.isoformat()}T12:00:00-04:00', 'work_date': day.isoformat(),
            })
    return dealers, vehicles


def main():
    path = sys.argv[1]
    dealers, vehicles = parse(path)
    out = Path(__file__).resolve().parent.parent / 'import'
    out.mkdir(exist_ok=True)
    (out / 'vehicles.json').write_text(json.dumps({'dealers': dealers, 'vehicles': vehicles}, indent=0))
    by = {}
    for v in vehicles:
        by.setdefault(v['dealer_code'], {}).setdefault(v['status'], 0)
        by[v['dealer_code']][v['status']] += 1
    for d in dealers:
        print(f"{d['code']:>10} {'ACTIVE ' if d['active'] else 'retired'} {sum(by.get(d['code'], {}).values()):>5}  "
              f"{by.get(d['code'], {})}  {d['name'][:40]}")
    print('total vehicles:', len(vehicles))


if __name__ == '__main__':
    main()
