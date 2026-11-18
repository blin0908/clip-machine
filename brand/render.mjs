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
  if(process.argv.includes('--concepts-only')) process.exitCode=0;
  else {
    // All PNG pixels are rendered by installed Chrome, not a graphics library.
    for(const [source,size,output] of [
      ['docs/icon.svg',180,'docs/icon-180.png'],['docs/icon.svg',512,'docs/icon-512.png'],
      ['brand/favicon.svg',16,'brand/favicon-16.png'],['brand/favicon.svg',32,'brand/favicon-32.png']
    ]) {
      await page.setViewportSize({width:size,height:size});
      const sourceSvg=await readFile(resolve(root,source),'utf8');
      await page.setContent(`<style>html,body{margin:0;width:100%;height:100%;background:transparent}svg{display:block;width:100%;height:100%}</style>${sourceSvg}`);
      await page.screenshot({path:resolve(root,output),omitBackground:true});
    }
    // ICO container with the two exact Chrome-produced PNG payloads.
    const pngs=await Promise.all([16,32].map(s=>readFile(resolve(root,`brand/favicon-${s}.png`))));
    const header=Buffer.alloc(6+16*2);header.writeUInt16LE(1,2);header.writeUInt16LE(2,4);let offset=header.length;
    for(let i=0;i<2;i++){const p=6+i*16,s=[16,32][i];header[p]=s;header[p+1]=s;header.writeUInt16LE(1,p+4);header.writeUInt16LE(32,p+6);header.writeUInt32LE(pngs[i].length,p+8);header.writeUInt32LE(offset,p+12);offset+=pngs[i].length;}
    await writeFile(resolve(root,'brand/favicon.ico'),Buffer.concat([header,...pngs]));
    // Decode PNG alpha to verify every opaque mark pixel is inside the centre 80% circle.
    // Canvas returns actual Chrome raster alpha; the dark tile is excluded by its known RGB.
    await page.goto(`${base}/docs/icon.svg`);
    const safe=await page.evaluate(async()=>{
      const img=new Image();img.src='/docs/icon-512.png';await img.decode();const c=document.createElementNS('http://www.w3.org/1999/xhtml','canvas');c.width=c.height=512;
      const ctx=c.getContext('2d');ctx.drawImage(img,0,0);const d=ctx.getImageData(0,0,512,512).data;
      let markPixels=0,outside=0,maxRadius=0;
      for(let y=0;y<512;y++)for(let x=0;x<512;x++){let k=(y*512+x)*4;if(d[k+2]>100&&d[k+3]>128){markPixels++;let r=Math.hypot(x+.5-256,y+.5-256);maxRadius=Math.max(maxRadius,r);if(r>204.8)outside++;}}
      return {markPixels,outside,maxRadius,safeRadius:204.8,pass:outside===0&&markPixels>0};
    });
    if(!safe.pass)throw Error('Maskable pixel safety failed');
    await writeFile(resolve(root,'brand/icon-check.json'),JSON.stringify(safe,null,2)+'\n');
    await page.setViewportSize({width:1280,height:1000});
    await page.goto(`${base}/brand/identity.html`);await page.evaluate(()=>document.fonts.ready);
    await page.screenshot({path:resolve(root,'brand/identity-preview.png'),fullPage:true});
    await page.locator('.icon-row').screenshot({path:resolve(root,'brand/concepts/selected-favicon-zoom.png')});
    await page.setViewportSize({width:390,height:844});
    if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth))throw Error('Identity mobile overflow');
    await page.screenshot({path:resolve(root,'brand/identity-mobile.png'),fullPage:true});
    console.log('PASS: selected identity, outlined wordmark, 180/512 icons, ICO 16+32, maskable pixel check, mobile identity review');
  }
} finally { await browser.close(); await new Promise(r=>server.close(r)); }
