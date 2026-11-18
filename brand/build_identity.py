"""Rebuild selected concept A as vector assets, including outlined Archivo lettering."""
from pathlib import Path
import hashlib
import json
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.pens.boundsPen import BoundsPen

ROOT = Path(__file__).resolve().parent
REPO = ROOT.parent
MARK = '<path d="M5 5h6v3H8v16h3v3H5zM21 5h6v22h-6v-3h3V8h-3z"/><path d="M11 14h3v7h-3zM15 10h3v15h-3zM19 15h3v5h-3z"/>'
COLORS = {'dark': ('#e8edf6', '#7aa7ff'), 'light': ('#142744', '#142744')}

def svg(w, h, body, title):
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w:g} {h:g}" role="img" aria-label="{title}">{body}</svg>\n'

def paths_for_wordmark():
    source = REPO/'docs/fonts/ui/archivo-400-800.woff2'
    font = TTFont(source)
    font = instantiateVariableFont(font, {'wght': 800, 'wdth': 125}, inplace=False)
    glyphs, cmap = font.getGlyphSet(), font.getBestCmap()
    x = 0
    parts = [[], []]
    total_bounds = []
    for i, char in enumerate('CLIPMACHINE'):
        name = cmap[ord(char)]
        pen = SVGPathPen(glyphs, ntos=lambda value: f'{value:.2f}'.rstrip('0').rstrip('.') if value else '0')
        glyphs[name].draw(TransformPen(pen, (1, 0, 0, -1, x, 0)))
        parts[0 if i < 4 else 1].append(pen.getCommands())
        bounds = BoundsPen(glyphs)
        glyphs[name].draw(TransformPen(bounds, (1, 0, 0, -1, x, 0)))
        if bounds.bounds:
            total_bounds.append(bounds.bounds)
        # Deliberately tracked uppercase logotype; no browser font or kerning dependency.
        x += glyphs[name].width - 18
    left = min(b[0] for b in total_bounds)
    top = min(b[1] for b in total_bounds)
    right = max(b[2] for b in total_bounds)
    bottom = max(b[3] for b in total_bounds)
    scale = 100 / (bottom-top)
    width = (right-left)*scale
    group = f'translate({-left*scale:.5f} {-top*scale:.5f}) scale({scale:.8f})'
    return parts, group, width, {'font': str(source.relative_to(REPO)), 'sha256': hashlib.sha256(source.read_bytes()).hexdigest(), 'axes': {'wght': 800, 'wdth':125}, 'tracking_font_units': -18}

def build():
    parts, transform, width, provenance = paths_for_wordmark()
    def word(fg, accent):
        return f'<g transform="{transform}"><path fill="{fg}" d="{"".join(parts[0])}"/><path fill="{accent}" d="{"".join(parts[1])}"/></g>'
    for mode, (fg, accent) in COLORS.items():
        mark_color = accent
        (ROOT/f'logo-mark-{mode}.svg').write_text(svg(32,32,f'<g fill="{mark_color}">{MARK}</g>','Clip Machine Peak window mark'))
        (ROOT/f'wordmark-{mode}.svg').write_text(svg(width,100,word(fg,accent),'Clip Machine outlined wordmark'))
        # 80px mark box alongside 32px-high wordmark; mark has internal clear space.
        word_scale=.32
        w=80+16+width*word_scale
        body=f'<g fill="{mark_color}" transform="scale(2.5)">{MARK}</g><g transform="translate(96 24) scale({word_scale})">{word(fg,accent)}</g>'
        (ROOT/f'lockup-horizontal-{mode}.svg').write_text(svg(w,80,body,'Clip Machine horizontal logo'))
        stacked_w=max(width*.42,150)
        body=f'<g fill="{mark_color}" transform="translate({(stacked_w-128)/2:g} 0) scale(4)">{MARK}</g><g transform="translate({(stacked_w-width*.42)/2:g} 154) scale(.42)">{word(fg,accent)}</g>'
        (ROOT/f'lockup-stacked-{mode}.svg').write_text(svg(stacked_w,196,body,'Clip Machine stacked logo'))
    for name in ['logo-mark','wordmark','lockup-horizontal','lockup-stacked']:
        (ROOT/f'{name}.svg').write_bytes((ROOT/f'{name}-dark.svg').read_bytes())
    (ROOT/'logo-mark-mono.svg').write_text(svg(32,32,f'<g fill="currentColor">{MARK}</g>','Clip Machine monochrome mark'))
    # At 80% SVG scale the ink bounds fit comfortably inside radius 40 around (50,50).
    # Furthest corner = sqrt(27.5² + 27.5²) = 38.89 < 40.
    icon=f'<rect width="100" height="100" fill="#05070c"/><g fill="#7aa7ff" transform="translate(10 10) scale(2.5)">{MARK}</g>'
    (REPO/'docs/icon.svg').write_text(svg(100,100,icon,'Clip Machine app icon'))
    (ROOT/'icon.svg').write_bytes((REPO/'docs/icon.svg').read_bytes())
    favicon=f'<rect width="32" height="32" rx="6" fill="#05070c"/><g fill="#7aa7ff">{MARK}</g>'
    (ROOT/'favicon.svg').write_text(svg(32,32,favicon,'Clip Machine favicon'))
    palette={'ink':'#05070c','panel':'#0a1120','panel2':'#111b30','well':'#03050a','line':'#18233a','line2':'#26344f','text':'#e8edf6','mute':'#9aa6bd','faint':'#7e8aa2','slate':'#7aa7ff','slate-ink':'#04102a','rec':'#ff5a4e','good':'#4cc38a','warn':'#f2a530','light-mark':'#142744','light-surface':'#eef2f8'}
    def lum(color):
        rgb=[int(color[i:i+2],16)/255 for i in (1,3,5)]
        rgb=[v/12.92 if v<=.04045 else ((v+.055)/1.055)**2.4 for v in rgb]
        return sum(a*b for a,b in zip(rgb,[.2126,.7152,.0722]))
    def ratio(a,b):
        x,y=sorted([lum(a),lum(b)]);return round((y+.05)/(x+.05),2)
    meta={'selected':'A — Peak window','selection_date':'2026-11-18','wordmark':provenance,'wordmark_width':round(width,4),'mark_ink_bounds':[5,5,27,27],'icon_ink_bounds':[22.5,22.5,77.5,77.5],'mask_safe_circle':{'center':[50,50],'radius':40,'maximum_ink_corner_radius':38.890873,'pass':True},'palette':[{'token':k,'hex':v,'contrast_on_ink':ratio(v,palette['ink'])} for k,v in palette.items()],'light_mark_contrast':ratio(palette['light-mark'],palette['light-surface']),'accent_button_text_contrast':ratio(palette['slate-ink'],palette['slate'])}
    (ROOT/'identity.json').write_text(json.dumps(meta,indent=2)+'\n')
    print('Built selected A: outlined wordmark, mark/lockup variants and mask-safe icon SVG.')

if __name__=='__main__':build()
