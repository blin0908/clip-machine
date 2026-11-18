"""Build the original, editable SVG concept review. No selected identity yet."""
from pathlib import Path
from html import escape

ROOT = Path(__file__).parent
CONCEPTS = [
    ("A", "Peak window", "peak-window", "Find the signal.",
     "In and out brackets isolate one strong peak. The negative space makes the act of choosing a moment visible, and the open corners keep the 16-pixel silhouette clear.",
     '<path d="M5 5h6v3H8v16h3v3H5zM21 5h6v22h-6v-3h3V8h-3z"/><path d="M11 14h3v7h-3zM15 10h3v15h-3zM19 15h3v5h-3z"/>'),
    ("B", "Splice", "splice", "Make the cut.",
     "Two solid pieces of a slate are separated by a single rising cut. It is the most compact, equipment-like direction: a useful shape before it is a symbol, without crossed ribbons or a play triangle.",
     '<path d="M5 6h22v7L5 20zM5 23l22-7v10H5z"/>'),
    ("C", "Cue", "cue", "Keep the moment.",
     "A squared C wraps around a small cue on a timeline. Its stepped opening suggests a frame being pulled out of a longer recording. A broad continuous shape keeps it quiet and readable at favicon size.",
     '<path d="M7 5h18v6h-4V9H9v14h12v-2h4v6H7l-2-2V7z"/><path d="M15 14h12v4H15z"/>'),
]

def svg(label, paths):
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" fill="currentColor" role="img" aria-label="Clip Machine {label} concept">{paths}</svg>'

def build():
    out = ROOT / "concepts"
    out.mkdir(exist_ok=True)
    cards = []
    for letter, name, slug, tagline, desc, paths in CONCEPTS:
        mark = svg(name, paths)
        (out / f"{slug}.svg").write_text(mark + "\n")
        scales = ''.join(f'<div><span style="width:{size}px;height:{size}px">{mark}</span><small>{size} px</small></div>' for size in [16, 32, 64, 256])
        cards.append(f'''<article id="{slug}">
          <div class="card-top"><span class="index">{letter}</span><span>CONCEPT {letter} / 03</span></div>
          <div class="hero-mark">{mark}</div>
          <div class="card-copy"><h2>{name}</h2><p class="tagline">{tagline}</p><p>{desc}</p></div>
          <div class="light"><span>{mark}</span><p>Same silhouette.<br>One colour.</p></div>
          <details><summary>Inspect at actual sizes</summary><div class="sizes dark">{scales}</div><div class="sizes light-sizes">{scales}</div></details>
        </article>''')
    (out / "concepts.html").write_text('''<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Clip Machine — three identity directions</title><style>
@font-face{font-family:Archivo;src:url('../../docs/fonts/ui/archivo-400-800.woff2')}@font-face{font-family:Instrument;src:url('../../docs/fonts/ui/instrumentsans-400-700.woff2')}@font-face{font-family:Mono;src:url('../../docs/fonts/ui/ibmplexmono-400.woff2')}
*{box-sizing:border-box}body{margin:0;background:#05070c;color:#e8edf6;font:16px/1.55 Instrument,system-ui,sans-serif}main{max-width:1440px;margin:auto;padding:48px 48px 72px}.eyebrow,.index,.card-top,small{font:11px/1.5 Mono,monospace;letter-spacing:.08em}.eyebrow{color:#7aa7ff}header{border-bottom:1px solid #26344f;padding-bottom:30px;margin-bottom:32px;display:flex;align-items:flex-end;justify-content:space-between;gap:32px}h1{font:800 clamp(40px,5vw,72px)/1 Archivo,sans-serif;letter-spacing:-.05em;margin:18px 0}header p{max-width:400px;color:#9aa6bd}h2{font:700 28px Archivo,sans-serif;letter-spacing:-.03em;margin:0}.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:20px}article{border:1px solid #26344f;border-radius:18px;overflow:hidden;background:#0a1120}.card-top{padding:20px;display:flex;justify-content:space-between;color:#9aa6bd}.index{border:1px solid #36517b;border-radius:50%;width:27px;height:27px;display:grid;place-items:center;color:#e8edf6}.hero-mark{height:280px;display:grid;place-items:center;color:#7aa7ff;background:radial-gradient(ellipse at 50% 50%,#111b30 0,transparent 68%)}.hero-mark svg{width:200px;height:200px}.card-copy{padding:26px 24px;min-height:235px}.card-copy p{color:#9aa6bd;font-size:14px}.card-copy .tagline{font-size:18px;color:#e8edf6;margin:10px 0}.light{background:#eef2f8;color:#142744;display:flex;align-items:center;justify-content:space-between;padding:20px 24px}.light span{width:64px;height:64px}.light p{font-size:13px;margin:0}.light svg{width:100%;height:100%}summary{cursor:pointer;padding:20px 24px;font-size:13px;color:#b2c8ef}summary:focus-visible,a:focus-visible{outline:2px solid #7aa7ff;outline-offset:-3px}.sizes{display:flex;align-items:flex-end;flex-wrap:wrap;gap:24px;padding:24px}.sizes div{display:grid;justify-items:center;gap:12px}.sizes span{display:block;color:#7aa7ff}.sizes svg{width:100%;height:100%}.sizes small{color:#9aa6bd}.light-sizes{background:#eef2f8}.light-sizes span{color:#142744}.light-sizes small{color:#34435e}footer{border-top:1px solid #26344f;margin-top:36px;padding-top:24px;display:flex;justify-content:space-between;gap:30px;color:#9aa6bd;font-size:13px}a{color:#b3cdff}a:hover{color:white}.notes{margin-top:40px}.notes h2{font-size:20px}.zoom-row{display:flex;flex-wrap:wrap;gap:24px;margin-top:20px}.zoom-card{border:1px solid #26344f;padding:24px;border-radius:12px;display:flex;align-items:center;gap:20px}.zoom-card img{width:128px;height:128px;image-rendering:pixelated}.zoom-card p{margin:0;color:#9aa6bd;font-size:13px}.mask{width:128px;height:128px;background:#111b30;border-radius:50%;display:grid;place-items:center;color:#7aa7ff}.mask svg{width:80%;height:80%}.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}@media(max-width:850px){main{padding:28px 20px}.grid{grid-template-columns:1fr}header{display:block}.hero-mark{height:230px}.card-copy{min-height:0}footer{display:block}.sizes{gap:16px}}
</style><main><header><div><div class="eyebrow">CLIP MACHINE / IDENTITY STUDY 01</div><h1>Find the moment.</h1></div><p>Three original directions. Compare the silhouette first, then the smallest sizes. Nothing here replaces the current app identity.</p></header><section class="grid" aria-label="Three logo concepts">''' + ''.join(cards) + '''</section>
<section class="notes"><h2>Small marks, up close.</h2><p>These are actual 16 px rasterizations enlarged 8×, followed by centre-circle icon previews. Final icons follow your choice.</p><div class="zoom-row">''' + ''.join(f'<div class="zoom-card"><img src="{slug}-16.png" alt="Concept {letter} rasterized at 16 pixels, enlarged"><div><strong>{letter} / {name}</strong><p>16 px → 128 px</p></div></div>' for letter,name,slug,*_ in CONCEPTS) + '''</div><div class="zoom-row">''' + ''.join(f'<div class="zoom-card"><div class="mask">{svg(name,paths)}</div><p>{letter} / circular crop<br>Candidate composition only</p></div>' for letter,name,slug,tag,desc,paths in CONCEPTS) + '''</div></section><footer><span>Working palette: #05070c / #7aa7ff / #eef2f8</span><span>Choose A, B or C. Then refine the mark, wordmark and app icons.</span></footer></main></html>''')

if __name__ == '__main__':
    build()
