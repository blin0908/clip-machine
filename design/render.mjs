import { chromium } from '../tests/node_modules/playwright/index.mjs';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile, copyFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
const root=resolve(fileURLToPath(new URL('..',import.meta.url))), dir=resolve(root,'design');
const assets=JSON.parse(await readFile(resolve(dir,'assets.json'),'utf8'));
const mime={'.html':'text/html','.css':'text/css','.js':'text/javascript','.svg':'image/svg+xml','.png':'image/png','.woff2':'font/woff2','.json':'application/json'};
const server=createServer(async(req,res)=>{const url=new URL(req.url,'http://local'),f=resolve(root,'.'+decodeURIComponent(url.pathname));if(!f.startsWith(root+sep)){res.writeHead(403).end();return;}try{const body=await readFile(f);res.writeHead(200,{'Content-Type':mime[extname(f)]||'application/octet-stream'}).end(body);}catch{res.writeHead(404).end();}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({channel:'chrome',headless:true}),checks=[];
try{
  let page;
  for(const a of assets){
    page=await browser.newPage({viewport:{width:a.width,height:a.height},deviceScaleFactor:1});await page.goto(base+'/design/'+a.source);await page.evaluate(async()=>{await document.fonts.load('800 24px Archivo');await document.fonts.ready;});
    const broken=await page.locator('img').evaluateAll(imgs=>imgs.filter(i=>!i.complete||!i.naturalWidth).map(i=>i.src));if(broken.length)throw Error('Missing image '+broken.join(','));
    if(a.name!=='youtube-profile' && !(await page.evaluate(()=>document.fonts.check('800 24px Archivo'))))throw Error('Archivo missing');
    const textOverflow=await page.locator('h1,p,.facts').evaluateAll(items=>items.filter(el=>{const r=el.getBoundingClientRect();return r.x<0||r.right>innerWidth+1||r.bottom>innerHeight;}).map(el=>el.textContent));if(textOverflow.length)throw Error(a.name+' text outside canvas '+textOverflow);
    await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
    await page.screenshot({path:resolve(dir,a.output),animations:'disabled'});checks.push({asset:a.name,width:a.width,height:a.height,images_loaded:true,text_within_canvas:true});
    if(a.name==='youtube-banner'){await page.locator('.canvas').evaluate(e=>e.classList.add('safe-preview'));await page.screenshot({path:resolve(dir,'youtube-banner-safe-preview.png')});}
    await page.close();
  }
  await copyFile(resolve(dir,'og-image.png'),resolve(root,'docs/og-image.png'));
  // Real smallest display-size samples, separate from publishable masters.
  await mkdir(resolve(dir,'previews'),{recursive:true});
  const sizes={'og-image':600,'readme-hero':800,'readme-studio':800,'release-banner':640,'feature-queue':360,'feature-studio':360,'feature-find':360,'feature-handoff':360,'youtube-banner':1280,'youtube-profile':98};
  const gallery='<!doctype html><html><meta charset="utf-8"><title>Clip Machine graphic review</title><style>body{background:#172033;color:#fff;font:16px system-ui;margin:24px}section{margin-bottom:30px}img{max-width:100%;display:block;border:1px solid #4d6082}h2{font-size:16px}</style>'+assets.map(a=>`<section><h2>${a.name} · ${a.width} × ${a.height} · shown at ${sizes[a.name]}px</h2><img width="${sizes[a.name]}" src="../${a.output}" alt="${a.name}"></section>`).join('')+'</html>';
  await writeFile(resolve(dir,'previews/marketing.html'),gallery);
  page=await browser.newPage({viewport:{width:1440,height:1000},deviceScaleFactor:1});await page.goto(base+'/design/previews/marketing.html');await page.screenshot({path:resolve(dir,'previews/marketing-small.png'),fullPage:true});
  await writeFile(resolve(dir,'previews/graphics-checks.json'),JSON.stringify(checks,null,2)+'\n');
  console.log('PASS: '+assets.length+' exact-size exports; real captures loaded; text within canvas; OG copied; safe-area and smallest-display review built.');
}finally{await browser.close();await new Promise(r=>server.close(r));}
