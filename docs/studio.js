// The clip studio: a live preview of the cut (source video + caption overlay, with the cuts skipped as it plays),
// a timeline with draggable in/out points that snap to word boundaries, caption-line editing, the look controls,
// and a render button that queues the edit and lets you move on.
export function createStudio(api) {
  const { X, esc, toast, fmtTC } = api;
  const $ = id => document.getElementById(id);
  const root = $("studio"), vid = $("stVid"), out = $("stOut"), frame = $("stFrame"), bg = $("stBg"), cap = $("stCap"), hook = $("stHook");
  const tl = $("stTl"), tctx = tl.getContext("2d"), bctx = bg.getContext("2d");
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const drafts = new WeakMap();                 // clip → { long, short }: unsaved edits survive switching clips
  let ST = null, raf = 0, drag = null, srcId = null;
  const MIN = 3;

  // ------------------------------------------------------------ model
  const cutObj = () => ST.c ? (ST.cut === "short" ? ST.c.short : ST.c) : null;
  const plat = () => X.F.platforms[ST.sess.o.platform];
  const dur = () => ST.sess.info.duration;
  const fresh = (sess, c, cut) => {
    const v = cut === "short" ? c.short : c;
    return { start: v.start, end: v.end, title: v.title ?? c.title ?? "", look: { ...(v.look || api.lookFrom(sess.o)) },
             cta: v.cta ?? (cut === "long" ? c.cta || "" : "") };
  };
  const key = d => JSON.stringify(d);
  const spoken = (sess = ST.sess) => sess === ST?.sess ? (ST._sp ||= X.spoken(sess.words)) : X.spoken(sess.words);
  function nearest(ws, t, by) {                // index of the word whose `by` time is closest to t (ws sorted by s)
    let lo = 0, hi = ws.length - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (ws[m][by] < t) lo = m + 1; else hi = m; }
    return lo > 0 && Math.abs(ws[lo - 1][by] - t) < Math.abs(ws[lo][by] - t) ? lo - 1 : lo;
  }
  // in/out points land in the gap between words, never inside one (same rule as the trim nudges)
  function snapIn(t, sess = ST.sess) {
    const ws = spoken(sess); if (!ws.length) return t;
    const i = nearest(ws, t, "s"), w = ws[i], prev = ws[i - 1];
    return +Math.min(w.s, Math.max(0, w.s - 0.12, prev ? prev.e + 0.02 : 0)).toFixed(2);
  }
  function snapOut(t, sess = ST.sess) {
    const ws = spoken(sess); if (!ws.length) return t;
    const i = nearest(ws, t, "e"), w = ws[i], next = ws[i + 1];
    return +Math.min(sess.info.duration, Math.max(w.s + 0.1, Math.min(w.e + 0.35, next ? next.s - 0.01 : Infinity))).toFixed(2);
  }
  function derive() {                           // everything that depends on the draft
    const d = ST.d, m = { start: d.start, end: d.end, words: ST.sess.words };
    ST.keep = X.keepIntervals({ ...m, words: ST.sess.words.filter(w => w.s >= d.start && w.s <= d.end) }, d.look.tighten, ST.sess.remote ? null : ST.sess.quiet);   // the desktop engine cuts on word gaps only
    ST.gaps = [];
    let prev = 0; for (const [a, b] of ST.keep) { if (a > prev + 0.01) ST.gaps.push([prev, a]); prev = b; }
    if (prev < d.end - d.start - 0.01) ST.gaps.push([prev, d.end - d.start]);
    ST.groups = X.captionGroups(m, { captions: d.look.captions, style: d.look.style });
    ST.after = ST.keep.reduce((a, [x, y]) => a + y - x, 0);
    drafts.set(ST.c || ST, { ...(drafts.get(ST.c || ST) || {}), [ST.cut]: d });
  }
  function hist() { ST.hist.push(key(ST.d)); if (ST.hist.length > 60) ST.hist.shift(); ST.fut = []; }
  function changed(full = true) { derive(); paintHead(); paintIO(); if (full) paintLook(); paintFrame(); need(); }

  // ------------------------------------------------------------ open / close
  function open(sess, c, cut = "long", seekT) {
    if (!sess?.words) return toast("This video isn't transcribed yet.");
    if (cut === "short" && !c.short) cut = "long";
    const d = drafts.get(c)?.[cut] || fresh(sess, c, cut);
    start({ sess, c, cut, d, orig: key(fresh(sess, c, cut)) }, seekT ?? d.start);
  }
  function openNew(sess, a, b, text = "") {
    if (!sess?.words) return toast("This video isn't transcribed yet.");
    const s = snapIn(Math.max(0, a), sess), e = Math.max(s + MIN, snapOut(Math.min(sess.info.duration, b), sess));
    const words = (text || sess.words.filter(w => w.s >= s && w.s <= e).map(w => w.w).join(" ")).split(/\s+/).filter(Boolean);
    let title = words.slice(0, 9).join(" ").replace(/[,;:]$/, "");
    if (title) title = title[0].toUpperCase() + title.slice(1);
    const d = { start: s, end: Math.min(e, sess.info.duration), title: title.slice(0, 80), look: api.lookFrom(sess.o), cta: "" };
    start({ sess, c: null, cut: "new", d, orig: null }, d.start);
  }

  function start(state, seekT) {
    const wasOpen = !!ST?.open;
    ST = { ...state, hist: [], fut: [], open: true, mode: "source", loop: ST?.loop ?? true, view: null, _sp: null };
    derive();
    if (srcId !== ST.sess.id) { vid.src = api.srcURL(ST.sess); srcId = ST.sess.id; }
    const go = () => { try { vid.currentTime = Math.max(0, seekT); } catch {} };
    vid.readyState >= 1 ? go() : vid.addEventListener("loadedmetadata", go, { once: true });
    fit();
    setMode("source");
    paintHead(); paintIO(); paintLook(); paintLines(); paintFrame();
    $("stStatus").textContent = "";
    paintJob(api.jobFor(ST.c, ST.cut));
    if (!wasOpen) {
      root.classList.remove("hide");
      document.querySelector(".app").inert = true; document.querySelector(".top").inert = true;
      document.body.style.overflow = "hidden";
      ST.returnFocus = document.activeElement;
      requestAnimationFrame(() => $("stPlay").focus());
    }
    cancelAnimationFrame(raf); raf = requestAnimationFrame(loop);
  }
  function close() {
    if (!ST) return;
    commitLines();
    vid.pause(); out.pause();
    root.classList.add("hide");
    document.querySelector(".app").inert = false; document.querySelector(".top").inert = false;
    document.body.style.overflow = "";
    cancelAnimationFrame(raf);
    const c = ST.c; ST = null;
    api.onClose(c);
  }
  $("stClose").onclick = close;

  // ------------------------------------------------------------ header, IO, inspector
  function paintHead() {
    const d = ST.d, c = ST.c;
    $("stNum").textContent = c ? `${c.idx}${ST.cut === "short" ? " · short" : c.short ? " · long" : ""}` : "New clip";
    $("stTitle").textContent = d.title || "Untitled clip";
    $("stCuts").innerHTML = c?.short ? `<button data-stcut="short" aria-pressed="${ST.cut === "short"}">Short</button><button data-stcut="long" aria-pressed="${ST.cut === "long"}">Long</button>` : "";
    $("stCuts").hidden = !c?.short;
    const list = api.list(), i = c ? list.indexOf(c) : -1;
    $("stPrev").disabled = i <= 0; $("stNext").disabled = i < 0 || i >= list.length - 1;
    $("stRend").disabled = !c;
    $("stReset").disabled = !c ? false : key(d) === ST.orig;
    if (!api.jobFor(ST.c, ST.cut)) $("stState").textContent = !c ? "Not rendered yet" : key(d) !== ST.orig ? "Unsaved changes" : "";
    $("stState").classList.remove("busy");
    $("stCtaWrap").hidden = ST.cut === "short";
  }
  function target() {                       // the length range this cut aims for
    const p = plat(), len = ST.d.end - ST.d.start;
    if (ST.cut === "short" || !p.long || ST.sess.version === "short") return p.short;
    if (ST.cut === "long" && !ST.c?.custom) return p.long;
    return len <= p.short[1] + 2 ? p.short : p.long;
  }
  function paintIO() {
    const d = ST.d, [lo, hi] = target();
    $("stIn").textContent = fmtTC(d.start); $("stOutTC").textContent = fmtTC(d.end);
    const fits = ST.after >= lo - 1 && ST.after <= hi + 1;
    $("stLen").innerHTML = `<b>${(d.end - d.start).toFixed(1)}s</b>${ST.gaps.length ? ` → <b>${ST.after.toFixed(1)}s</b> after ${ST.gaps.length} cut${ST.gaps.length > 1 ? "s" : ""}` : ""} · <span class="${fits ? "fit" : "off"}">target ${lo}–${hi}s${fits ? " ✓" : ""}</span>`;
  }
  const B = v => v ? "1" : "0";
  function paintLook() {
    const L = ST.d.look;
    const val = { captions: B(L.captions), style: L.style, hl: (L.hl || "").toUpperCase(), size: L.size, pos: L.pos, hook: B(L.hook), format: L.format, layout: L.layout, tighten: B(L.tighten),
                  logo: B(L.logo), lpos: L.lpos || "tl", lsize: L.lsize || "m" };
    root.querySelectorAll(".chips[data-ek]").forEach(g => g.querySelectorAll(".chip[data-v]").forEach(b => b.setAttribute("aria-pressed", b.dataset.v.toUpperCase() === String(val[g.dataset.ek]).toUpperCase())));
    if (/^#[0-9a-f]{6}$/i.test(L.hl)) $("stHlc").value = L.hl.toLowerCase();
    const sw = [...root.querySelectorAll('.chips[data-ek="hl"] .chip[data-v]')];
    $("stHlc").parentElement.dataset.on = !sw.some(b => b.getAttribute("aria-pressed") === "true");
    $("stCropHint").hidden = L.layout !== "crop";
    $("stBrand").hidden = !api.brand();                      // no logo added yet: nothing to switch on
    const ed = $("stHeadline"); if (document.activeElement !== ed) ed.value = ST.d.title;
    const ct = $("stCta"); if (document.activeElement !== ct) ct.value = ST.d.cta || "";
  }
  function paintLines() {
    ST.lines = X.captionLines(ST.sess.words, ST.d.start, ST.d.end);
    $("stLines").innerHTML = ST.lines.map((l, i) => `<div class="lnrow" data-row="${i}"><button class="tcb" data-seek="${l.s}" aria-label="Jump to ${fmtTC(l.s)}">${fmtTC(l.s)}</button><input class="txt ed-line" data-line="${i}" value="${esc(l.text)}" aria-label="Caption line ${i + 1}" spellcheck="true"></div>`).join("")
      || `<p class="msg">No speech in this cut.</p>`;
  }
  function commitLines() {                   // fold typed caption fixes into the session transcript
    if (!ST?.lines) return false;
    const inputs = [...$("stLines").querySelectorAll(".ed-line")], texts = inputs.map(x => x.value);
    if (!inputs.length || texts.every((t, i) => t.trim() === ST.lines[i]?.text)) return false;
    X.applyLineEdits(ST.sess.words, ST.lines, texts);
    ST._sp = null;
    api.onWords(ST.sess);
    paintLines(); derive(); paintFrame();
    return true;
  }
  $("stLines").addEventListener("change", e => { if (e.target.classList.contains("ed-line")) { commitLines(); paintHead(); } });
  $("stLines").addEventListener("keydown", e => {
    if (!e.target.classList.contains("ed-line")) return;
    const i = +e.target.dataset.line;
    if (e.key === "Enter" && !e.metaKey && !e.ctrlKey) { e.preventDefault(); const n = $("stLines").querySelector(`[data-line="${i + (e.shiftKey ? -1 : 1)}"]`); n ? n.focus() : e.target.blur(); }
  });
  $("stLines").addEventListener("focusin", e => { const i = e.target.dataset?.line; if (i != null && ST.lines[+i]) seek(ST.lines[+i].s); });
  $("stLines").addEventListener("click", e => { const b = e.target.closest("[data-seek]"); if (b) seek(+b.dataset.seek); });
  $("stHeadline").addEventListener("focus", () => hist());
  $("stHeadline").addEventListener("input", e => { ST.d.title = e.target.value.slice(0, 90); derive(); paintHead(); paintFrame(); });
  $("stCta").addEventListener("focus", () => hist());
  $("stCta").addEventListener("input", e => { ST.d.cta = e.target.value.slice(0, 80); derive(); paintHead(); });
  root.querySelectorAll(".chips[data-ek]").forEach(g => g.addEventListener("click", e => {
    const b = e.target.closest(".chip[data-v]"); if (!b) return;
    hist();
    const k = g.dataset.ek, v = b.dataset.v;
    ST.d.look[k] = ["captions", "hook", "tighten", "logo"].includes(k) ? v === "1" : v;
    if (k === "format") fitFrame();
    changed();
  }));
  $("stHlc").addEventListener("input", e => { ST.d.look.hl = e.target.value.toUpperCase(); changed(); });
  $("stHlc").addEventListener("focus", () => hist());
  for (const [tab, pane] of [["stTabText", "stText"], ["stTabLook", "stLook"]]) $(tab).onclick = () => {
    for (const [t, p] of [["stTabText", "stText"], ["stTabLook", "stLook"]]) { $(t).setAttribute("aria-selected", t === tab); $(p).hidden = t !== tab; }
  };
  $("stCuts").addEventListener("click", e => { const b = e.target.closest("[data-stcut]"); if (b && b.dataset.stcut !== ST.cut) { commitLines(); open(ST.sess, ST.c, b.dataset.stcut); } });
  function step(dir) {
    const list = api.list(), i = list.indexOf(ST.c), c = list[i + dir];
    if (!c) return;
    commitLines(); open(ST.sess, c, c.view === "short" && c.short ? "short" : "long");
  }
  $("stPrev").onclick = () => step(-1);
  $("stNext").onclick = () => step(1);
  $("stReset").onclick = () => {
    if (!ST.c) return;
    hist(); ST.d = fresh(ST.sess, ST.c, ST.cut); fitFrame(); changed(); paintLines(); seek(ST.d.start);
    toast("Back to the rendered version");
  };
  root.addEventListener("click", e => {
    const n = e.target.closest("[data-nudge]"); if (!n) return;
    const [which, dir] = n.dataset.nudge.split(":");
    hist();
    Object.assign(ST.d, X.nudge(ST.sess.words, ST.d.start, ST.d.end, which, +dir));
    changed(false); paintLines(); seek(which === "start" ? ST.d.start : Math.max(ST.d.start, ST.d.end - 1.5));
  });

  // ------------------------------------------------------------ render
  function render() {
    if (!ST) return;
    commitLines();
    const job = { sess: ST.sess, c: ST.c, cut: ST.cut, d: JSON.parse(key(ST.d)) };
    const at = { c: ST.c, cut: ST.cut, holder: ST };
    $("stStatus").textContent = "";
    api.queueRender(job).then(res => {
      if (res.superseded) return;                            // a newer edit of the same cut replaced this one
      const here = ST && ST.c === at.c && ST.cut === at.cut;
      if (!res.ok) { if (here || (ST && at.c === null && ST.c === null)) $("stStatus").textContent = "⚠ " + res.msg; else toast("⚠ An edit failed. Open the clip to see why."); return; }
      if (at.c) drafts.delete(at.c);
      if (ST && ST === at.holder && at.c === null) {          // the new clip now exists: keep editing it as a normal clip
        drafts.delete(ST);
        ST.c = res.clip; ST.cut = "long"; ST.orig = key(fresh(ST.sess, ST.c, "long"));
        if (key(ST.d) === key(job.d)) ST.d = fresh(ST.sess, ST.c, "long");
        derive(); paintHead();
      } else if (here) {
        ST.orig = key(fresh(ST.sess, ST.c, ST.cut));
        if (key(ST.d) === key(job.d)) ST.d = fresh(ST.sess, ST.c, ST.cut);
        derive(); paintHead();
        if (ST.mode === "rendered") setMode("rendered");
      }
      const v = res.clip && (at.cut === "short" ? res.clip.short : res.clip);
      const q = v?.quality || [];
      if (ST) $("stStatus").textContent = here || at.c === null ? `Rendered · quality ${q.filter(x => x.ok).length}/${q.length}${v.retried ? " (safe mode)" : ""}. It's on the board.` : "";
      if (!here) toast(`Rendered: ${res.clip.title}`);
    });
    toast(api.jobFor(ST.c, ST.cut)?.state === "running" ? "Rendering…" : "Queued to render");
  }
  $("stRender").onclick = render;
  function paintJob(job) {
    const el = $("stState");
    if (!job || job.state === "done" || job.state === "failed") { el.classList.remove("busy"); if (ST) paintHead(); return; }
    el.textContent = api.jobLabel(job); el.classList.add("busy");
  }
  function onJob(job) { if (ST && job.cut === ST.cut && (ST.c ? job.c === ST.c : !job.c && (job.state === "done" || job.state === "failed" || job === api.jobFor(null, ST.cut)))) paintJob(job); }

  // ------------------------------------------------------------ preview
  function setMode(m) {
    ST.mode = m;
    const v = cutObj(), rendered = m === "rendered" && v;
    $("stSrc").setAttribute("aria-pressed", !rendered); $("stRend").setAttribute("aria-pressed", !!rendered);
    out.classList.toggle("hide", !rendered); vid.classList.toggle("hide", !!rendered); bg.classList.toggle("hide", !!rendered);
    cap.hidden = hook.hidden = !!rendered;
    if (rendered) { vid.pause(); if (out.getAttribute("src") !== v.url) out.src = v.url; frame.style.setProperty("--ar", (v.look?.format || "9:16").replace(":", "/")); }
    else { out.pause(); fitFrame(); }
  }
  $("stSrc").onclick = () => setMode("source");
  $("stRend").onclick = () => setMode("rendered");
  $("stLoop").onclick = () => { ST.loop = !ST.loop; $("stLoop").setAttribute("aria-pressed", ST.loop); };
  function fitFrame() {
    const [a, b] = X.FORMATS[ST.d.look.format] || [9, 16];
    frame.style.setProperty("--ar", `${a}/${b}`); frame.style.setProperty("--arw", a / b);
    bg.width = a >= b ? 64 : Math.round(64 * a / b); bg.height = a >= b ? Math.round(64 * b / a) : 64;
  }
  const previewFonts = new Set();
  function previewFont(f) {                         // load a script's caption font into the page once, for the live preview
    if (previewFonts.has(f.name)) return;
    previewFonts.add(f.name);
    new FontFace(f.name, `url(${f.url})`, { weight: "900" }).load().then(ff => document.fonts.add(ff)).catch(() => previewFonts.delete(f.name));
  }
  function paintFrame() {
    const L = ST.d.look, lay = X.captionLayout(plat(), L);
    frame.classList.toggle("crop", L.layout === "crop");
    vid.style.objectPosition = L.layout === "crop" ? `${(L.cx ?? 0.5) * 100}% ${(L.cy ?? 0.5) * 100}%` : "";
    const base = { pop: 84, clean: 70, boxed: 72 }[L.style] || 84;
    frame.style.setProperty("--fs", (base * lay.scale / lay.PX * 100).toFixed(3));
    frame.style.setProperty("--hs", (58 * Math.min(1, lay.scale / ({ s: 0.82, m: 1, l: 1.2 }[L.size] || 1)) / lay.PX * 100).toFixed(3));
    frame.style.setProperty("--ml", (lay.marginLR / lay.PX * 100).toFixed(2) + "%");
    frame.style.setProperty("--hl", /^#[0-9a-f]{6}$/i.test(L.hl) ? L.hl : "#FFF000");
    cap.className = `st-cap ${L.style}`;
    cap.style.top = cap.style.bottom = cap.style.transform = "";
    if (lay.align === 2) cap.style.bottom = (lay.marginV / lay.PY * 100) + "%";
    else if (lay.align === 8) cap.style.top = (lay.marginV / lay.PY * 100) + "%";
    else { cap.style.top = "50%"; cap.style.transform = "translateY(-50%)"; }
    hook.style.top = (lay.hookTop / lay.PY * 100) + "%";
    const cf = X.captionFont({ start: ST.d.start, end: ST.d.end, title: ST.d.title || "", words: ST.sess.words });   // the font the render will use
    frame.style.setProperty("--capfont", cf.url ? `"${cf.name}", "Cap Black"` : `"Cap Black"`);
    if (cf.url) previewFont(cf);
    cap.lang = cf === X.F.captionFonts.greek ? "el" : "";     // CSS capitals then drop Greek accents, as the render does
    cap.dir = hook.dir = "auto";                              // Arabic/Hebrew lines take a right-to-left base, as libass does
    const lg = $("stLogo"), url = api.brand();               // the logo, placed exactly where the render puts it
    lg.hidden = !(L.logo && url);
    if (!lg.hidden) {
      const b = X.logoBox(L.format, L);
      if (lg.getAttribute("src") !== url) lg.src = url;
      Object.assign(lg.style, { width: b.box / b.W * 100 + "%", height: b.box / b.H * 100 + "%", top: b.my / b.H * 100 + "%",
        left: b.right ? "" : b.mx / b.W * 100 + "%", right: b.right ? b.mx / b.W * 100 + "%" : "", opacity: X.logoOpacity(L.lop),
        objectPosition: b.right ? "right top" : "left top" });
    }
    ST._capKey = null;
  }
  function paintCaption(t) {
    const d = ST.d, L = d.look, inSel = t >= d.start && t <= d.end;
    const clipT = inSel ? X.remap(t - d.start, ST.keep) : 99;
    const showHook = L.hook && d.title && clipT < 3.2;
    const hk = showHook ? d.title : "";
    if (hook._t !== hk) { hook._t = hk; hook.innerHTML = hk ? `<span>${esc(hk)}</span>` : ""; }
    let html = "";
    if (inSel && L.captions) {
      const g = ST.groups.find(x => t >= x.s && t < x.e);
      if (g) {
        const cut = L.style === "clean" ? g.s + 3.5 : null;
        if (!cut || t < cut) {
          let wi = -1; g.words.forEach((w, i) => { if (w.s <= t) wi = i; });
          const txt = w => L.style === "clean" ? esc(w.w) : esc(X.captionText(w.w));
          const lastE = wi >= 0 ? (wi + 1 < g.words.length ? g.words[wi + 1].s : g.e) : 0;
          const lit = L.style !== "clean" && wi >= 0 && t - g.words[wi].s < 1.6 && t < lastE;
          const body = X.joinWords(g.words.map(w => w.w), g.words.map((w, i) => i === wi && lit ? `<span class="hl">${txt(w)}</span>` : txt(w)));
          html = L.style === "boxed" ? `<span class="ln">${body}</span>` : body;
        }
      }
    }
    if (ST._capKey !== html) { ST._capKey = html; cap.innerHTML = html; }
  }
  function paintBg() {
    if (ST.d.look.layout !== "fit" || vid.readyState < 2 || !vid.videoWidth) return;
    const W = bg.width, H = bg.height, vr = vid.videoWidth / vid.videoHeight, fr = W / H;
    let sw = vid.videoWidth, sh = vid.videoHeight, sx = 0, sy = 0;
    if (vr > fr) { sw = sh * fr; sx = (vid.videoWidth - sw) / 2; } else { sh = sw / fr; sy = (vid.videoHeight - sh) / 2; }
    try { bctx.drawImage(vid, sx, sy, sw, sh, 0, 0, W, H); } catch {}
  }
  function seek(t) { if (!ST) return; t = Math.max(0, Math.min(dur(), t)); try { vid.currentTime = t; } catch {} ST.lastT = t; follow(t); need(); }
  function togglePlay() {
    if (ST.mode === "rendered") { out.paused ? out.play() : out.pause(); return; }
    if (vid.paused) {
      const t = vid.currentTime;
      if (t < ST.d.start - 0.05 || t >= ST.d.end - 0.05) vid.currentTime = ST.d.start + (ST.keep[0]?.[0] || 0);
      vid.play().catch(() => {});
    } else vid.pause();
  }
  $("stPlay").onclick = () => togglePlay();
  const playIcon = () => { const p = ST && (ST.mode === "rendered" ? !out.paused : !vid.paused); $("stPlay").innerHTML = `<svg class="i"><use href="#i-${p ? "pause" : "play"}"/></svg>`; $("stPlay").setAttribute("aria-label", p ? "Pause (Space)" : "Play selection (Space)"); };
  for (const v of [vid, out]) { v.addEventListener("play", playIcon); v.addEventListener("pause", playIcon); }

  // drag the picture to reframe (Fill / crop)
  frame.addEventListener("pointerdown", e => {
    if (!ST || ST.mode !== "source" || ST.d.look.layout !== "crop" || !vid.videoWidth) return;
    hist();
    const r = frame.getBoundingClientRect(), vr = vid.videoWidth / vid.videoHeight, fr = r.width / r.height;
    const ox = vr > fr ? r.height * vr - r.width : 0, oy = vr > fr ? 0 : r.width / vr - r.height;
    const s = { x: e.clientX, y: e.clientY, cx: ST.d.look.cx ?? 0.5, cy: ST.d.look.cy ?? 0.5 };
    frame.setPointerCapture(e.pointerId);
    const mv = ev => {
      if (ox > 1) ST.d.look.cx = +Math.min(1, Math.max(0, s.cx - (ev.clientX - s.x) / ox)).toFixed(3);
      if (oy > 1) ST.d.look.cy = +Math.min(1, Math.max(0, s.cy - (ev.clientY - s.y) / oy)).toFixed(3);
      vid.style.objectPosition = `${ST.d.look.cx * 100}% ${ST.d.look.cy * 100}%`;
    };
    const up = () => { frame.removeEventListener("pointermove", mv); frame.removeEventListener("pointerup", up); frame.removeEventListener("pointercancel", up); derive(); paintHead(); };
    frame.addEventListener("pointermove", mv); frame.addEventListener("pointerup", up); frame.addEventListener("pointercancel", up);
  });

  function loop() {
    if (!ST) return;
    const t = vid.currentTime, d = ST.d;
    if (!vid.paused && ST.mode === "source") {
      if (t >= d.end - 0.03 && t < d.end + 0.6) {
        if (ST.loop) vid.currentTime = d.start + (ST.keep[0]?.[0] || 0); else { vid.pause(); vid.currentTime = d.end; }
      } else if (t >= d.start && t < d.end) {
        const rel = t - d.start, g = ST.gaps.find(([a, b]) => rel >= a && rel < b - 0.03);
        if (g) vid.currentTime = d.start + g[1];
      }
      follow(t);
    }
    paintCaption(t); paintBg();
    const shown = ST.mode === "rendered" ? out.currentTime : t;
    const tc = ST.mode === "rendered" ? `${fmtTC(shown)} / ${fmtTC(out.duration || 0)}` : `${fmtTC(t)}${t >= d.start && t <= d.end ? `  ·  clip ${fmtTC(X.remap(t - d.start, ST.keep))}` : ""}`;
    if ($("stTC")._t !== tc) { $("stTC")._t = tc; $("stTC").textContent = tc; }
    $("stLines").querySelectorAll(".lnrow").forEach((r, i) => { const l = ST.lines[i]; r.classList.toggle("now", !!l && t >= l.s - 0.05 && t <= l.e + 0.3); });
    if (ST.dirty || !vid.paused || drag || ST.lastDrawT !== t) { draw(); ST.dirty = false; ST.lastDrawT = t; }
    raf = requestAnimationFrame(loop);
  }
  const need = () => { if (ST) ST.dirty = true; };

  // ------------------------------------------------------------ timeline
  const RULER = 20, LANE = 26;
  function fit() {
    const d = ST.d, pad = Math.max(4, (d.end - d.start) * 0.3);
    ST.view = { a: Math.max(0, d.start - pad), b: Math.min(dur(), d.end + pad) };
    need();
  }
  function zoom(f, at) {
    const v = ST.view, len = Math.min(dur(), Math.max(2, (v.b - v.a) * f));
    at ??= (vid.currentTime >= v.a && vid.currentTime <= v.b) ? vid.currentTime : (v.a + v.b) / 2;
    const r = (at - v.a) / (v.b - v.a);
    let a = at - r * len; a = Math.max(0, Math.min(dur() - len, a));
    ST.view = { a, b: a + len }; need();
  }
  function pan(dt) { const v = ST.view, len = v.b - v.a; let a = Math.max(0, Math.min(dur() - len, v.a + dt)); ST.view = { a, b: a + len }; need(); }
  function follow(t) {
    const v = ST.view; if (!v) return;
    const len = v.b - v.a;
    if (t > v.b - len * 0.04 || t < v.a) pan(t - v.a - len * 0.25);
  }
  $("stZoomIn").onclick = () => zoom(1 / 1.6);
  $("stZoomOut").onclick = () => zoom(1.6);
  $("stZoomFit").onclick = () => fit();
  const X_ = t => (t - ST.view.a) / (ST.view.b - ST.view.a) * tl.clientWidth;
  const T_ = x => ST.view.a + x / tl.clientWidth * (ST.view.b - ST.view.a);
  function niceStep(pxPerSec) {
    for (const s of [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1200]) if (s * pxPerSec >= 64) return s;
    return 1800;
  }
  function hatch(ctx, x0, y0, w, h, color) {
    ctx.save(); ctx.beginPath(); ctx.rect(x0, y0, w, h); ctx.clip();
    ctx.fillStyle = "rgba(255,90,78,.10)"; ctx.fillRect(x0, y0, w, h);
    ctx.strokeStyle = color; ctx.lineWidth = 1;
    for (let x = x0 - h; x < x0 + w; x += 6) { ctx.beginPath(); ctx.moveTo(x, y0 + h); ctx.lineTo(x + h, y0); ctx.stroke(); }
    ctx.restore();
  }
  function draw() {
    if (!ST?.view) return;
    const dpr = devicePixelRatio || 1, w = tl.clientWidth, h = tl.clientHeight;
    if (!w || !h) return;
    if (tl.width !== Math.round(w * dpr) || tl.height !== Math.round(h * dpr)) { tl.width = Math.round(w * dpr); tl.height = Math.round(h * dpr); }
    const c = tctx, d = ST.d, v = ST.view, pps = w / (v.b - v.a);
    c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, w, h);
    const waveTop = RULER + 4, waveH = h - RULER - LANE - 10, mid = waveTop + waveH / 2, laneY = h - LANE - 3;
    const xs = X_(d.start), xe = X_(d.end);
    // selection band
    c.fillStyle = "rgba(242,194,48,.07)"; c.fillRect(xs, 0, xe - xs, h);
    // ruler
    const st = niceStep(pps), minor = st >= 5 ? st / 5 : st / 2;
    c.fillStyle = "#8a8d94"; c.font = "500 10px 'Plex Mono', ui-monospace, monospace"; c.textBaseline = "middle";
    for (let t = Math.floor(v.a / minor) * minor; t <= v.b; t += minor) {
      const x = Math.round(X_(t)) + 0.5, major = Math.abs(t / st - Math.round(t / st)) < 1e-6;
      c.fillRect(x, major ? 4 : 12, 1, major ? RULER - 6 : RULER - 14);
      if (major) c.fillText(st < 1 ? fmtTC(t) : X.fmtT(t), x + 4, 9);
    }
    c.fillStyle = "#2a2d33"; c.fillRect(0, RULER, w, 1);
    // waveform from the quiet map (50 ms steps)
    const q = ST.sess.quiet;
    if (q) {
      const top = q.thr + 33, bot = q.thr - 6, rel = ST.gaps;
      for (let x = 0; x < w; x += 2) {
        const t0 = T_(x), t1 = T_(x + 2);
        let i0 = Math.max(0, Math.floor(t0 / q.step)), i1 = Math.min(q.db.length - 1, Math.max(i0, Math.floor(t1 / q.step)));
        let m = -200; for (let i = i0; i <= i1; i++) if (q.db[i] > m) m = q.db[i];
        const lv = Math.max(0.03, Math.min(1, (m - bot) / (top - bot))), bh = lv * waveH;
        const tm = (t0 + t1) / 2, inSel = tm >= d.start && tm <= d.end;
        const inGap = inSel && rel.some(([a, b]) => tm - d.start >= a && tm - d.start < b);
        c.fillStyle = !inSel ? "#3d414a" : inGap ? "rgba(255,90,78,.45)" : "#f2c230";
        c.fillRect(x, mid - bh / 2, 1.4, bh);
      }
    }
    for (const [a, b] of ST.gaps) { const x0 = X_(d.start + a), x1 = X_(d.start + b); if (x1 > 0 && x0 < w) hatch(c, x0, waveTop, Math.max(1, x1 - x0), waveH, "rgba(255,90,78,.35)"); }
    // words lane
    const ws = ST.sess.words, i0 = Math.max(0, nearest(ws, v.a, "s") - 1), t = vid.currentTime;
    c.font = "500 11px 'Instrument Sans', system-ui, sans-serif"; c.textBaseline = "middle";
    for (let i = i0; i < ws.length && ws[i].s <= v.b; i++) {
      const wd = ws[i], x0 = X_(wd.s), x1 = Math.max(x0 + 2, X_(wd.e) - 1);
      if (x1 < 0) continue;
      const inSel = wd.s >= d.start - 0.05 && wd.s <= d.end, filler = X.F.fillerSet.has(wd.w.toLowerCase().replace(/[^a-z]/g, ""));
      const now = t >= wd.s && t < wd.e;
      c.fillStyle = now ? "#ecebe6" : filler ? "rgba(255,90,78,.18)" : inSel ? "#383c44" : "#24272d";
      c.fillRect(x0, laneY, x1 - x0, LANE - 4);
      if (x1 - x0 > 16) {
        c.save(); c.beginPath(); c.rect(x0 + 3, laneY, x1 - x0 - 5, LANE - 4); c.clip();
        c.fillStyle = now ? "#121316" : filler ? "#a2a3a8" : inSel ? "#ecebe6" : "#8a8d94";
        c.fillText(wd.w, x0 + 4, laneY + (LANE - 4) / 2 + 0.5); c.restore();
      }
    }
    // in/out brackets
    for (const [x, dir] of [[xs, 1], [xe, -1]]) {
      if (x < -12 || x > w + 12) continue;
      c.fillStyle = "#f2c230";
      c.fillRect(x - (dir > 0 ? 0 : 3), 0, 3, h);
      c.fillRect(dir > 0 ? x : x - 12, 0, 12, 4); c.fillRect(dir > 0 ? x : x - 12, h - 4, 12, 4);
      c.beginPath();                                       // grip tab
      const gx = dir > 0 ? x + 3 : x - 3;
      c.roundRect ? c.roundRect(dir > 0 ? gx : gx - 9, mid - 14, 9, 28, 3) : c.rect(dir > 0 ? gx : gx - 9, mid - 14, 9, 28);
      c.fill();
      c.fillStyle = "#16130a"; c.fillRect(dir > 0 ? gx + 3 : gx - 6, mid - 7, 1, 14); c.fillRect(dir > 0 ? gx + 5 : gx - 4, mid - 7, 1, 14);
    }
    // playhead
    const xp = X_(t);
    if (xp >= -2 && xp <= w + 2) {
      c.fillStyle = "#ff5a4e"; c.fillRect(Math.round(xp) - 1, 0, 2, h);
      c.beginPath(); c.moveTo(xp - 6, 0); c.lineTo(xp + 6, 0); c.lineTo(xp, 8); c.closePath(); c.fill();
    }
  }
  function hit(x, touch) {
    const r = touch ? 20 : 9, xs = X_(ST.d.start), xe = X_(ST.d.end);
    const ds = Math.abs(x - xs), de = Math.abs(x - xe);
    if (Math.min(ds, de) > r) return null;
    return ds <= de ? "in" : "out";
  }
  function setIn(t, free) {
    let s = free ? +t.toFixed(2) : snapIn(t);
    s = Math.max(0, Math.min(s, ST.d.end - MIN)); ST.d.start = s;
  }
  function setOut(t, free) {
    let e = free ? +t.toFixed(2) : snapOut(t);
    e = Math.min(dur(), Math.max(e, ST.d.start + MIN)); ST.d.end = e;
  }
  tl.addEventListener("pointerdown", e => {
    if (!ST) return;
    const r = tl.getBoundingClientRect(), x = e.clientX - r.left, t = T_(x);
    let mode = hit(x, e.pointerType === "touch");
    if (!mode && e.shiftKey) mode = Math.abs(t - ST.d.start) < Math.abs(t - ST.d.end) ? "in" : "out";
    drag = { mode: mode || "seek", moved: false };
    tl.setPointerCapture(e.pointerId);
    if (mode) { hist(); (mode === "in" ? setIn : setOut)(t, e.altKey); changed(false); seek(mode === "in" ? ST.d.start : ST.d.end); }
    else { vid.pause(); seek(t); }
    e.preventDefault();
  });
  tl.addEventListener("pointermove", e => {
    if (!ST) return;
    const r = tl.getBoundingClientRect(), x = e.clientX - r.left;
    if (!drag) { tl.style.cursor = hit(x, false) ? "ew-resize" : "crosshair"; return; }
    const t = T_(Math.max(0, Math.min(r.width, x)));
    drag.moved = true;
    if (drag.mode === "seek") seek(t);
    else { (drag.mode === "in" ? setIn : setOut)(t, e.altKey); changed(false); seek(drag.mode === "in" ? ST.d.start : ST.d.end); }
  });
  const endDrag = () => { if (drag && drag.mode !== "seek" && ST) paintLines(); drag = null; };
  tl.addEventListener("pointerup", endDrag);
  tl.addEventListener("pointercancel", endDrag);
  tl.addEventListener("wheel", e => {
    if (!ST) return;
    e.preventDefault();
    const r = tl.getBoundingClientRect();
    if (e.ctrlKey || e.metaKey) zoom(Math.exp(e.deltaY * 0.01), T_(e.clientX - r.left));
    else pan((Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY) / r.width * (ST.view.b - ST.view.a));
  }, { passive: false });
  addEventListener("resize", need);

  // ------------------------------------------------------------ keyboard
  function wordStep(dir) {
    const ws = spoken(), t = vid.currentTime;
    const w = dir > 0 ? ws.find(x => x.s > t + 0.02) : [...ws].reverse().find(x => x.s < t - 0.05);
    if (w) { vid.pause(); seek(w.s); }
  }
  addEventListener("keydown", e => {                   // on the window: focus may sit on <body> after clicking the preview
    if (!ST || $("keys").open) return;
    const k = e.key, mod = e.metaKey || e.ctrlKey;
    if (mod && k === "Enter") { e.preventDefault(); render(); return; }
    if (k === "Tab") {                                  // keep focus inside the studio
      const f = [...root.querySelectorAll("button:not(:disabled), input, [tabindex='0'], video[controls]")].filter(el => el.offsetParent !== null);
      const i = f.indexOf(document.activeElement);
      if (e.shiftKey && i <= 0) { e.preventDefault(); f.at(-1).focus(); } else if (!e.shiftKey && i === f.length - 1) { e.preventDefault(); f[0].focus(); }
      return;
    }
    const inField = e.target.closest("input, textarea, select") && e.target.type !== "color";
    if (k === "Escape") { e.preventDefault(); if (inField) e.target.blur(); else close(); return; }
    if (inField) return;
    if (mod && k.toLowerCase() === "z") { e.preventDefault(); undo(e.shiftKey); return; }
    if (mod || e.altKey && !/^[io]$/i.test(k)) return;
    const big = e.shiftKey ? 5 : 1;
    switch (k) {
      case " ": if (e.target.closest("button, video[controls], summary")) return; e.preventDefault(); togglePlay(); break;
      case "k": case "K": e.preventDefault(); vid.pause(); out.pause(); break;
      case "j": case "J": e.preventDefault(); seek(vid.currentTime - big); break;
      case "l": case "L": e.preventDefault(); seek(vid.currentTime + big); break;
      case "i": case "I": e.preventDefault(); if (e.shiftKey) seek(ST.d.start); else { hist(); setIn(vid.currentTime, e.altKey); changed(false); paintLines(); } break;
      case "o": case "O": e.preventDefault(); if (e.shiftKey) seek(ST.d.end); else { hist(); setOut(vid.currentTime, e.altKey); changed(false); paintLines(); } break;
      case "ArrowLeft": e.preventDefault(); e.shiftKey ? seek(vid.currentTime - 5) : wordStep(-1); break;
      case "ArrowRight": e.preventDefault(); e.shiftKey ? seek(vid.currentTime + 5) : wordStep(1); break;
      case "[": e.preventDefault(); step(-1); break;
      case "]": e.preventDefault(); step(1); break;
      case "+": case "=": e.preventDefault(); zoom(1 / 1.6); break;
      case "-": case "_": e.preventDefault(); zoom(1.6); break;
      case "0": e.preventDefault(); fit(); break;
      case "?": e.preventDefault(); $("keys").showModal(); break;
    }
  });
  function undo(redo) {
    const from = redo ? ST.fut : ST.hist, to = redo ? ST.hist : ST.fut;
    if (!from.length) return toast(redo ? "Nothing to redo" : "Nothing to undo");
    to.push(key(ST.d)); ST.d = JSON.parse(from.pop());
    fitFrame(); changed(); paintLines();
  }

  return { open, openNew, close, onJob, isOpen: () => !!ST };
}
