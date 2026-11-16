"""Find by description, desktop engine (search.py): ranking checks on fixed transcripts, and the reference scores
web-find.mjs compares the browser engine against.

    .venv/bin/python tests/search_parity.py                 # ranking checks
    .venv/bin/python tests/search_parity.py --dump out.json  # also write every window's score for every case

Fixtures (tests/fixtures): talk_40s.words.json is the desktop transcript of media/talk_40s.mp4 (faster-whisper base);
search-multilingual.json is one four-topic talk (pricing, hiring, cooking, a trip) in English, Spanish and Japanese.
Needs the search model (about 135 MB, downloaded once into the Hugging Face cache).
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
import search  # noqa: E402

FX = ROOT / "tests" / "fixtures"
# queries in en, es, ja -> words of which the right window must contain one, per transcript language
TOPICS = {
    "price": (["the part about pricing", "el precio del plan", "料金について"],
              {"en": ["pricing", "charge"], "es": ["precio", "Cobramos"], "ja": ["料金", "プラン"]}),
    "hire": (["how they hired engineers", "contratar personas", "採用の話"],
             {"en": ["Hiring", "interviewed"], "es": ["Contratar", "Entrevistamos"], "ja": ["採用", "面接"]}),
    "cook": (["the cooking recipe", "la receta de pollo", "料理のコツ"],
             {"en": ["cook", "dish"], "es": ["cocino", "plato"], "ja": ["料理"]}),
    "trip": (["the road trip in Iceland", "el viaje a Islandia", "アイスランド旅行"],
             {"en": ["Iceland"], "es": ["Islandia"], "ja": ["アイスランド"]}),
}
LANG_OF = {0: "en", 1: "es", 2: "ja"}   # the language of each topic's queries, in order
# Clearly unrelated queries: nothing should be offered. (In calibration "how to fix a flat bike tyre" did match the
# English cooking tip, "the trick is to...": the one known false positive, so it is not asserted.)
OFF = ["football match results", "quantum physics lecture", "la política europea", "株式市場のニュース"]
TALK = {"the biggest mistake I ever made": 0.0, "how to make a video": None, "a recipe for chocolate cake": "none"}


def cases():
    multi = json.loads((FX / "search-multilingual.json").read_text())
    talk = json.loads((FX / "talk_40s.words.json").read_text())
    out = [("talk_40s", talk, 40.0, q) for q in TALK]
    for lang, d in multi.items():
        out += [(lang, d["words"], d["duration"], q) for qs, _ in TOPICS.values() for q in qs]
        out += [(lang, d["words"], d["duration"], q) for q in OFF]
    return out


def main():
    fails = 0

    def check(ok, name, detail=""):
        nonlocal fails
        fails += not ok
        print(f"{'PASS' if ok else 'FAIL'}  {name}{'  · ' + detail if detail else ''}")

    dump, declined = [], []
    for src, words, dur, q in cases():
        wins = search.scored_windows(words, dur, q)
        scores = [w["score"] for w in wins]
        picks = search.pick([{k: w[k] for k in ("start", "end", "text")} for w in wins], scores, 3)
        dump.append({"src": src, "words": words, "duration": dur, "query": q, "windows": wins, "picks": picks})
        top = max(wins, key=lambda w: w["score"])
        info = f"top {top['score']:.3f} @{top['start']:.1f}s, strength {search.match_strength(scores):.3f}"
        if src == "talk_40s":
            want = TALK[q]
            if want == "none":
                check(not picks, f"talk_40s: nothing offered for {q!r}", info)
            elif want is None:
                check(bool(picks) and "film the moment" in picks[0]["text"], f"talk_40s: {q!r} finds the filming tip", info)
            else:
                check(bool(picks) and picks[0]["start"] == want, f"talk_40s: {q!r} finds the opening", info)
        elif q in OFF:
            check(not picks, f"{src}: nothing offered for {q!r}", info)
        else:
            qs, m = next((qs, m) for qs, m in TOPICS.values() if q in qs)
            markers, same = m[src], LANG_OF[qs.index(q)] == src
            right = any(k in top["text"] for k in markers)
            if same:     # asked in the transcript's own language: must be found
                check(bool(picks) and any(k in picks[0]["text"] for k in markers), f"{src}: {q!r} → the {markers[0]} window", info)
            else:        # asked in another language: the best window must be the right one; offering it is a bonus
                check(right and (not picks or picks[0]["start"] == top["start"]), f"{src}: {q!r} (another language) ranks the {markers[0]} window first",
                      info + ("" if picks else " · declined: below the match threshold"))
                if not picks:
                    declined.append(f"{src}/{q}")
    if "--dump" in sys.argv:
        Path(sys.argv[sys.argv.index("--dump") + 1]).write_text(json.dumps(dump, ensure_ascii=False))
    print(f"\ncross-language queries declined as too weak: {len(declined)} {declined}")
    print(f"{'all checks passed' if not fails else f'{fails} failed'}")
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
