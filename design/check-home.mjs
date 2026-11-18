import { chromium } from '../tests/node_modules/playwright/index.mjs';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
const out=resolve(root,'design/previews'); await mkdir(out,{recursive:true});
const mime={'.html':'text/html','.css':'text/css','.js':'text/javascript','.svg':'image/svg+xml','.png':'image/png','.woff2':'font/woff2','.json':'application/json'};
const server=createServer(async(req,res)=>{
  const f=resolve(root,'.'+decodeURIComponent(new URL(req.url,'http://local').pathname)+(req.url.split('?')[0].endsWith('/')?'index.html':''));
  if(!f.startsWith(root+sep)){res.writeHead(403).end();return;}
  try{const body=await readFile(f);res.writeHead(200,{'Content-Type':mime[extname(f)]||'application/octet-stream'}).end(body);}catch{res.writeHead(404).end();}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({channel:'chrome',headless:true});
const results=[]; const check=(ok,label)=>{results.push({label,pass:!!ok});if(!ok)throw Error(label);console.log('PASS '+label);};
try{
  const page=await browser.newPage({viewport:{width:1440,height:1000},deviceScaleFactor:1});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(base+'/design/homepage/');await page.evaluate(()=>document.fonts.ready);
  check(await page.locator('.waveform b').count()===64,'deterministic animated waveform loads');
  check(await page.locator('.machine [aria-label]').count()===0,'diagram has one accessible description, not duplicate controls');
  await page.getByRole('button',{name:'Pause motion',exact:false}).click();check(await page.locator('#motion').getAttribute('aria-pressed')==='true','pause motion works');
  check(await page.locator('.playhead').evaluate(el=>getComputedStyle(el).animationPlayState)==='paused','pause stops animated process graphic');
  await page.screenshot({path:resolve(out,'homepage-desktop.png'),animations:'disabled'});
  await page.getByRole('link',{name:'How it works',exact:true}).click();
  await page.waitForFunction(()=>Math.abs(document.querySelector('#how').getBoundingClientRect().top-100)<8);
  check(new URL(page.url()).hash==='#how','click-through scroll reaches workflow');
  await page.locator('.reveal').evaluateAll(items=>items.forEach(el=>el.classList.add('visible')));
  await page.evaluate(()=>window.scrollTo({top:0,behavior:'instant'}));
  await page.screenshot({path:resolve(out,'homepage-full.png'),fullPage:true,animations:'disabled'});
  await page.emulateMedia({reducedMotion:'reduce'});await page.goto(base+'/design/homepage/');
  check(await page.locator('#motion').isDisabled(),'reduced-motion mode honours OS preference');
  check(await page.locator('.playhead').evaluate(el=>getComputedStyle(el).display)==='none','reduced-motion mode removes playhead motion');
  check(await page.locator('.reveal').first().evaluate(el=>getComputedStyle(el).opacity)==='1','reduced-motion content remains visible');
  await page.setViewportSize({width:390,height:844});await page.evaluate(()=>document.fonts.ready);
  await page.screenshot({path:resolve(out,'homepage-mobile.png'),fullPage:true});
  const overflow=await page.evaluate(()=>[...document.querySelectorAll('body *')].filter(el=>el.getBoundingClientRect().right>innerWidth+1).map(el=>({tag:el.tagName,cls:el.className,right:el.getBoundingClientRect().right})).slice(0,12));
  const documentFits=await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth);
  if(!documentFits)console.log('Overflow diagnostics',overflow);
  check(documentFits,'390px layout has no horizontal overflow');
  await page.setViewportSize({width:320,height:700});
  check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'320px layout has no horizontal overflow');
  await page.setViewportSize({width:390,height:844});
  await page.keyboard.press('Tab');check(await page.locator('.skip').evaluate(el=>el===document.activeElement),'skip link is first keyboard stop');
  const links=await page.locator('a[href="../../docs/index.html"]').all();check(links.length===3,'three working app entry points');
  await links[0].click();check(await page.locator('#file').count()===1&&await page.locator('#go').count()===1,'Try it out opens actual unchanged workspace');
  check(errors.length===0,'no browser JavaScript errors');
}finally{await writeFile(resolve(out,'checks.json'),JSON.stringify(results,null,2)+'\n');await browser.close();await new Promise(r=>server.close(r));}
