// Rebuild review images with installed Chrome, one page at a time.
import { chromium } from '../tests/node_modules/playwright/index.mjs';
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const mime = {'.svg':'image/svg+xml','.html':'text/html','.png':'image/png','.woff2':'font/woff2'};
const server = createServer(async(req,res)=>{
  const path=resolve(root,'.'+decodeURIComponent(new URL(req.url,'http://local').pathname));
  if(!path.startsWith(root+sep)){res.writeHead(403).end();return;}
  try{const body=await readFile(path);res.writeHead(200,{'Content-Type':mime[extname(path)]||'application/octet-stream'}).end(body);}catch{res.writeHead(404).end();}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const base=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({channel:'chrome',headless:true});
try {
  const page=await browser.newPage({viewport:{width:1440,height:1100},deviceScaleFactor:1});
  for(const slug of ['peak-window','splice','cue']){
    await page.setContent(`<style>body{margin:0;background:#05070c}svg{display:block;color:#7aa7ff;width:16px;height:16px}</style>${await readFile(resolve(root,`brand/concepts/${slug}.svg`),'utf8')}`);
    await page.locator('svg').screenshot({path:resolve(root,`brand/concepts/${slug}-16.png`)});
  }
  await page.goto(`${base}/brand/concepts/concepts.html`);
  await page.evaluate(()=>document.fonts.ready);
  await page.screenshot({path:resolve(root,'brand/concepts/comparison.png'),fullPage:true});
  await page.locator('.zoom-row').first().screenshot({path:resolve(root,'brand/concepts/favicon-zoom.png')});
  // Expand both dark and light actual-size samples in the archived review.
  await page.locator('summary').evaluateAll(items=>items.forEach(i=>i.parentElement.open=true));
  await page.screenshot({path:resolve(root,'brand/concepts/actual-sizes.png'),fullPage:true});
  await page.setViewportSize({width:390,height:844});
  if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth))throw Error('Mobile horizontal overflow');
  await page.screenshot({path:resolve(root,'brand/concepts/mobile.png'),fullPage:true});
  console.log('PASS: three SVGs, actual 16px rasters, dark/light size study, circular previews, mobile overflow check');
} finally { await browser.close(); await new Promise(r=>server.close(r)); }
