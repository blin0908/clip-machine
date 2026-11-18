document.documentElement.classList.add('js');
const wave = document.querySelector('.waveform');
// Deterministic graphic, not sampled speech or fabricated analytics.
for (let i = 0; i < 64; i++) {
  const bar = document.createElement('b');
  bar.style.height = `${14 + ((i * 17 + i * i * 3) % 52)}px`;
  bar.style.setProperty('--delay', `${-(i % 11) * .22}s`);
  wave.append(bar);
}
const reduced = matchMedia('(prefers-reduced-motion: reduce)');
const toggle = document.querySelector('#motion');
let paused = reduced.matches;
function updateMotion() {
  document.body.classList.toggle('motion-paused', paused);
  toggle.setAttribute('aria-pressed', String(paused));
  toggle.textContent = paused ? 'Resume motion ▶' : 'Pause motion Ⅱ';
  toggle.disabled = reduced.matches;
  if (reduced.matches) toggle.textContent = 'Reduced motion enabled';
}
toggle.addEventListener('click', () => { paused = !paused; updateMotion(); });
reduced.addEventListener('change', () => { paused = reduced.matches; updateMotion(); });
document.addEventListener('visibilitychange', () => document.body.classList.toggle('page-hidden', document.hidden));
updateMotion();
if ('IntersectionObserver' in window) {
  const observer = new IntersectionObserver(entries => {
    for (const entry of entries) if (entry.isIntersecting) {
      entry.target.classList.add('visible'); observer.unobserve(entry.target);
    }
  }, { threshold: .12 });
  document.querySelectorAll('.reveal').forEach(el => observer.observe(el));
} else document.querySelectorAll('.reveal').forEach(el => el.classList.add('visible'));
