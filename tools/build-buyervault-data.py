#!/usr/bin/env python3
"""Build the BuyerVault §5A dashboard data exports (build-time, read-only).

Reads ONLY (sqlite mode=ro) from the owned BuyerVault databases and the
live dashboard buyer bundles, and writes slim JSON snapshots into
netlify/functions/ for the buyervault-* functions:

  buyervault-meta.json          provenance, counts, field keys, generatedAt
  buyervault-markets.json       market index (city markets from the master
                                buyer bundle + county markets from the FL/NC
                                candidate harvest) + ZIP -> market map
  buyervault-candidates-fl.json FL buyer candidates (array-of-arrays)
  buyervault-candidates-nc.json NC buyer candidates (array-of-arrays)
  buyervault-entities.json      Sunbiz-linked entities for FL candidates:
                                registered agent, officers, derived links
                                (shares_agent_with / shares_address_with)
  buyervault-sync-index.json    slim per-buyer rows for the HighLevel sync
                                preview/gate (phone buyers only)

NOTHING is invented: every value comes from the sources below. NC has no
sale prices in NC OneMap, so NC volume/median stay null (-> rendered "—").
Qualified flags for seed buyers come from buyervault-seed.db `buyers.qualified`
(phone + evidence buy box, computed at seed build); buyers merged after the
seed (NC traced merges, Nov 13) were merged only when qualified, so unmatched
rows default to qualified=1 ONLY when they carry a phone — the join method
and its residual ambiguity are recorded in buyervault-meta.json.

Run: python3 tools/build-buyervault-data.py
"""
import json
import os
import re
import sqlite3
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
DASH = os.path.dirname(HERE)
BV = os.path.expanduser("~/workspace/buyervault-pro")
OUT = os.path.join(DASH, "netlify", "functions")

GENERATED_AT = datetime.now(timezone.utc).isoformat()


def norm_name(n):
    return re.sub(r"\s+", " ", re.sub(r"[^A-Z0-9 ]", "", (n or "").upper())).strip()


def digits10(v):
    d = re.sub(r"\D", "", str(v or ""))
    return d[1:] if len(d) == 11 and d.startswith("1") else d


def ro_db(name):
    return sqlite3.connect(f"file:{os.path.join(BV, name)}?mode=ro", uri=True)


# ---------------------------------------------------------------- master ---
def load_master():
    src = open(os.path.join(DASH, "assets", "master-buyers.js")).read()
    return json.loads(src[src.index("["):src.rindex("]") + 1])


def seed_qualified_map():
    """(name_norm, primary_phone) -> qualified, plus name-only fallback."""
    con = ro_db("buyervault-seed.db")
    by_pair, by_name = {}, {}
    for name, qual, phones_json in con.execute(
            "SELECT name, qualified, phones_json FROM buyers"):
        try:
            phones = json.loads(phones_json) if phones_json else []
        except Exception:
            phones = []
        digs = []
        for p in phones:
            raw = p.get("phone", "") if isinstance(p, dict) else p
            d = digits10(raw)
            if d:
                digs.append(d)
        nn = norm_name(name)
        if digs:
            by_pair[(nn, digs[0])] = int(qual or 0)
        by_name.setdefault(nn, int(qual or 0))
    con.close()
    return by_pair, by_name


# ------------------------------------------------------------ candidates ---
CAND_FIELDS = ["name", "state", "counties", "parcels", "purch36", "purchAll",
               "volume36", "median36", "lastPurchase", "sunbizDoc", "hasAgent"]


def load_candidates(db_name, state):
    con = ro_db(db_name)
    rows = []
    for r in con.execute(
            "SELECT name_raw, counties, parcels_owned, purchases_36mo, "
            "purchases_all, total_volume_36mo, median_price_36mo, "
            "last_purchase_date, sunbiz_doc_no, has_registered_agent "
            "FROM buyer_candidates ORDER BY purchases_36mo DESC, "
            "parcels_owned DESC"):
        # counties is the FULL comma list: a candidate counts in every
        # county it buys in, not just the first (Duval: 7,481 anywhere
        # vs 2,487 single-county — first-county-only undercounts).
        counties = (r[1] or "").strip()
        rows.append([
            (r[0] or "").strip(), state, counties,
            int(r[2] or 0), int(r[3] or 0), int(r[4] or 0),
            (float(r[5]) if r[5] is not None else None),
            (float(r[6]) if r[6] is not None else None),
            r[7] or None, (r[8] or None), int(r[9] or 0),
        ])
    con.close()
    return rows


# -------------------------------------------------------------- entities ---
def load_entities(fl_rows):
    """Sunbiz entity detail for every candidate carrying a doc number."""
    wanted = {}
    for row in fl_rows:
        doc = row[9]
        if doc:
            wanted.setdefault(doc, row)
    con = ro_db("buyervault-florida.db")
    entities = {}
    docs = list(wanted.keys())
    CH = 800
    for i in range(0, len(docs), CH):
        chunk = docs[i:i + CH]
        q = ",".join("?" * len(chunk))
        for r in con.execute(
                f"SELECT doc_no, name_raw, status, filing_type, principal_addr1,"
                f" principal_city, principal_state, principal_zip, mail_addr1,"
                f" mail_city, mail_state, mail_zip, file_date FROM entities "
                f"WHERE doc_no IN ({q})", chunk):
            entities[r[0]] = {
                "doc": r[0], "name": (r[1] or "").strip(), "status": r[2] or None,
                "filingType": r[3] or None,
                "principal": {"addr": r[4] or None, "city": r[5] or None,
                              "state": r[6] or None, "zip": r[7] or None},
                "mail": ({"addr": r[8] or None, "city": r[9] or None,
                          "state": r[10] or None, "zip": r[11] or None}
                         if r[8] and r[8] != r[4] else None),
                "fileDate": r[12] or None,
                "agent": None, "officers": [],
            }
    for i in range(0, len(docs), CH):
        chunk = docs[i:i + CH]
        q = ",".join("?" * len(chunk))
        for r in con.execute(
                f"SELECT doc_no, role, title, person_name_raw, city, state "
                f"FROM entity_people WHERE doc_no IN ({q}) ORDER BY role, id",
                chunk):
            ent = entities.get(r[0])
            if not ent:
                continue
            person = {"name": re.sub(r"\s+", " ", (r[3] or "")).strip(),
                      "title": r[2] or None,
                      "city": r[4] or None, "state": r[5] or None}
            if r[1] == "registered_agent" and ent["agent"] is None:
                ent["agent"] = person
            elif r[1] != "registered_agent" and len(ent["officers"]) < 6:
                ent["officers"].append(person)
    # Registered-agent street address lives on the agent row itself.
    for i in range(0, len(docs), CH):
        chunk = docs[i:i + CH]
        q = ",".join("?" * len(chunk))
        for r in con.execute(
                f"SELECT doc_no, addr, zip FROM entity_people "
                f"WHERE doc_no IN ({q}) AND role='registered_agent'", chunk):
            ent = entities.get(r[0])
            if ent and ent["agent"]:
                ent["agent"]["addr"] = r[1] or None
                ent["agent"]["zip"] = r[2] or None
    con.close()

    # Derived links WITHIN the exported (candidate-linked) entity set only.
    by_agent, by_addr = defaultdict(list), defaultdict(list)
    for doc, ent in entities.items():
        if ent["agent"] and ent["agent"]["name"]:
            by_agent[(norm_name(ent["agent"]["name"]),
                      ent["agent"].get("zip") or "")].append(doc)
        p = ent["principal"]
        if p["addr"]:
            by_addr[(re.sub(r"\s+", " ", p["addr"].upper()).strip(),
                     p["zip"] or "")].append(doc)
    out = []
    for doc, ent in entities.items():
        cand = wanted[doc]
        ent["candidate"] = {"parcels": cand[3], "purch36": cand[4],
                            "purchAll": cand[5], "volume36": cand[6],
                            "median36": cand[7], "lastPurchase": cand[8],
                            "counties": cand[2]}
        la = []
        if ent["agent"] and ent["agent"]["name"]:
            la = [d for d in by_agent[(norm_name(ent["agent"]["name"]),
                                       ent["agent"].get("zip") or "")]
                  if d != doc]
        ent["linkedAgent"] = [{"doc": d, "name": entities[d]["name"]}
                              for d in la[:8]]
        ent["linkedAgentCount"] = len(la)
        p = ent["principal"]
        lad = []
        if p["addr"]:
            lad = [d for d in by_addr[(re.sub(r"\s+", " ", p["addr"].upper()).strip(),
                                       p["zip"] or "")] if d != doc]
        ent["linkedAddress"] = [{"doc": d, "name": entities[d]["name"]}
                                for d in lad[:8]]
        ent["linkedAddressCount"] = len(lad)
        out.append(ent)
    out.sort(key=lambda e: -(e["candidate"]["purch36"] or 0))
    return out


# --------------------------------------------------------------- markets ---
def build_markets(master, fl_rows, nc_rows, qual_flags):
    markets = {}
    zip_map = {}
    city_acc = defaultdict(lambda: {"buyers": 0, "qualified": 0, "withPhone": 0,
                                    "apSum": 0, "apN": 0})
    for i, b in enumerate(master):
        city = (b.get("c") or "").strip()
        state = (b.get("s") or "").strip().upper()
        if city and state:
            acc = city_acc[(city.lower(), state)]
            acc["buyers"] += 1
            acc["withPhone"] += 1 if b.get("p") else 0
            acc["qualified"] += qual_flags[i]
            if b.get("ap"):
                acc["apSum"] += b["ap"]
                acc["apN"] += 1
        z = (b.get("z") or "")[:5]
        if z and z != "00000" and city and state:
            zip_map.setdefault(z, {"kind": "city", "city": city, "state": state})
    for (city_l, state), acc in city_acc.items():
        if acc["buyers"] < 3:
            continue
        city = next(b["c"] for b in master
                    if (b.get("c") or "").strip().lower() == city_l
                    and (b.get("s") or "").strip().upper() == state)
        key = f"city:{city_l}|{state}"
        markets[key] = {
            "key": key, "kind": "city", "label": f"{city}, {state}",
            "city": city, "county": None, "state": state,
            "buyers": acc["buyers"], "qualified": acc["qualified"],
            "withPhone": acc["withPhone"],
            "medianAvgPurchase": (round(acc["apSum"] / acc["apN"])
                                  if acc["apN"] else None),
            "candidates": 0, "entitiesLinked": 0,
            "candidateMedian": None, "candidateLastPurchase": None,
            "sources": ["master_buyers"],
        }
    cand_acc = defaultdict(lambda: {"candidates": 0, "entitiesLinked": 0,
                                    "meds": [], "last": None, "volume": 0.0})
    for rows in (fl_rows, nc_rows):
        for r in rows:
            counties = [c.strip() for c in (r[2] or "").split(",") if c.strip()]
            for county in counties:
                acc = cand_acc[(county.lower(), r[1])]
                acc["candidates"] += 1
                acc["entitiesLinked"] += 1 if r[9] else 0
                if r[7] is not None:
                    acc["meds"].append(r[7])
                if r[6]:
                    acc["volume"] += r[6]
                if r[8] and (acc["last"] is None or r[8] > acc["last"]):
                    acc["last"] = r[8]
    for (county_l, state), acc in cand_acc.items():
        county = county_l.title()
        key = f"county:{county_l}|{state}"
        meds = sorted(acc["meds"])
        markets[key] = {
            "key": key, "kind": "county",
            "label": f"{county} County, {state}",
            "city": None, "county": county, "state": state,
            "buyers": 0, "qualified": 0, "withPhone": 0,
            "medianAvgPurchase": None,
            "candidates": acc["candidates"],
            "entitiesLinked": acc["entitiesLinked"],
            "candidateMedian": (meds[len(meds) // 2] if meds else None),
            "candidateLastPurchase": acc["last"],
            "candidateVolume36": round(acc["volume"]) if acc["volume"] else None,
            "sources": ["buyer_candidates"],
        }
    return markets, zip_map


def main():
    master = load_master()
    by_pair, by_name = seed_qualified_map()
    qual_flags, matched = [], 0
    for b in master:
        nn = norm_name(b.get("n"))
        pair = by_pair.get((nn, digits10(b.get("p"))))
        if pair is not None:
            qual_flags.append(pair)
            matched += 1
        elif nn in by_name:
            qual_flags.append(by_name[nn])
            matched += 1
        else:
            # Post-seed merges (NC traced, Nov 13) entered only when qualified.
            qual_flags.append(1 if b.get("p") else 0)
    print(f"master {len(master)} | seed-matched {matched} | "
          f"qualified {sum(qual_flags)}", file=sys.stderr)

    fl_rows = load_candidates("buyervault-florida.db", "FL")
    nc_rows = load_candidates("buyervault-northcarolina.db", "NC")
    print(f"candidates FL {len(fl_rows)} NC {len(nc_rows)}", file=sys.stderr)

    entities = load_entities(fl_rows)
    print(f"entities {len(entities)} | with agent "
          f"{sum(1 for e in entities if e['agent'])}", file=sys.stderr)

    markets, zip_map = build_markets(master, fl_rows, nc_rows, qual_flags)

    # Sync index: phone buyers only; w = likely-wholesaler flag (HARD RULE D).
    sync_index = []
    for i, b in enumerate(master):
        if not b.get("p"):
            continue
        sync_index.append([
            b.get("n") or "", digits10(b.get("p")), int(b.get("sc") or 0),
            b.get("ti") or "", b.get("st") or "", (b.get("c") or ""),
            (b.get("s") or ""), int(b.get("pc") or 0),
            int(b.get("ap") or 0), int(b.get("pv") or 0),
            int(b.get("w") or 0), qual_flags[i],
        ])

    meta = {
        "generatedAt": GENERATED_AT,
        "generator": "tools/build-buyervault-data.py (read-only DB access)",
        "sources": {
            "masterBuyers": {"file": "assets/master-buyers.js",
                             "buyers": len(master),
                             "qualified": sum(qual_flags),
                             "qualifiedMethod": "seed buyers.qualified flag "
                             "joined by (name, primary phone), name-only "
                             "fallback; post-seed NC merges default qualified "
                             "when a phone is present (they were merged only "
                             "when qualified). Residual ambiguity ~13 rows vs "
                             "the 21,551 headline."},
            "candidatesFL": {"db": "buyervault-florida.db", "rows": len(fl_rows)},
            "candidatesNC": {"db": "buyervault-northcarolina.db", "rows": len(nc_rows),
                             "note": "NC OneMap publishes no sale prices: "
                             "volume36/median36 are null."},
            "entities": {"db": "buyervault-florida.db (Sunbiz)",
                         "rows": len(entities),
                         "withAgent": sum(1 for e in entities if e["agent"])},
        },
        "candidateFields": CAND_FIELDS,
        "syncIndexFields": ["name", "phone", "score", "tier", "strategy",
                            "city", "state", "props", "avgPurchase",
                            "portfolioValue", "likelyWholesaler", "qualified"],
        "markets": len(markets),
    }

    def dump(name, obj):
        path = os.path.join(OUT, name)
        with open(path, "w") as fh:
            json.dump(obj, fh, separators=(",", ":"))
        print(f"wrote {name} {os.path.getsize(path):,} bytes", file=sys.stderr)

    dump("buyervault-meta.json", meta)
    dump("buyervault-markets.json",
         {"markets": list(markets.values()), "zips": zip_map})
    dump("buyervault-candidates-fl.json", fl_rows)
    dump("buyervault-candidates-nc.json", nc_rows)
    dump("buyervault-entities.json", entities)
    dump("buyervault-sync-index.json", sync_index)
    print("DONE", file=sys.stderr)


if __name__ == "__main__":
    main()
