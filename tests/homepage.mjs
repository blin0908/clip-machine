// Homepage/workspace migration, installed/offline routes and the real desktop release.
// One browser page at a time; uses generated scratch state, never the app on 8765.
import {chromium} from 'playwright';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {readFile,mkdtemp,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,join,extname,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes} from 'node:crypto';
const root=resolve(fileURLToPath(new URL('..',import.meta.url))),docs=join(root,'docs');
const desktopRoot=process.env.DESKTOP_ROOT?resolve(process.env.DESKTOP_ROOT):root;
const out=join(root,'tests/web-out');await mkdir(out,{recursive:true});
const mimes={'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.json':'application/json','.png':'image/png','.ico':'image/x-icon','.woff2':'font/woff2','.ttf':'font/ttf'};
const web=createServer(async(req,res)=>{const p=new URL(req.url,'http://x').pathname;if(!p.startsWith('/clip-machine/')){res.writeHead(404).end();return;}const f=resolve(docs,decodeURIComponent(p.slice('/clip-machine/'.length))||'index.html');if(!f.startsWith(docs+sep)){res.writeHead(403).end();return;}try{const b=await readFile(f);res.writeHead(200,{'Content-Type':mimes[extname(f)]||'application/octet-stream'}).end(b);}catch{res.writeHead(404).end();}});
await new Promise(r=>web.listen(0,'127.0.0.1',r));const WEB=`http://127.0.0.1:${web.address().port}/clip-machine/`;
let browser,srv;const assert=(ok,name)=>{if(!ok)throw Error(name);console.log('PASS '+name);};
try{
 browser=await chromium.launch({channel:'chrome',headless:true});
 if(!process.env.DESKTOP_ROOT){
 const ctx=await browser.newContext({viewport:{width:1360,height:900}}),page=await ctx.newPage(),errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 page.on('console',m=>{if(/Refused to|violates.*Content Security Policy/i.test(m.text()))errors.push(m.text());});
 await page.goto(WEB);await page.locator('#motion').waitFor();
 assert(await page.locator('#file').count()===0,'root is the homepage at a GitHub Pages subpath');
 await page.getByRole('button',{name:'Pause motion',exact:false}).click();
 assert(await page.locator('#motion').getAttribute('aria-pressed')==='true','integrated homepage pause works');
 await page.evaluate(()=>localStorage.setItem('integration.keep','preserved'));
 await page.locator('a[href="workspace.html"]').first().click();await page.locator('#file').waitFor();
 assert(new URL(page.url()).pathname.endsWith('/workspace.html'),'Try it out enters the actual editor');
 assert(await page.locator('meta[name="cm-api"]').getAttribute('content')==='','optional accounts configuration preserved');
 await page.evaluate(async()=>{await navigator.serviceWorker.ready;});
 await page.waitForFunction(()=>!!navigator.serviceWorker.controller);
 const manifest=await (await ctx.request.get(WEB+'manifest.json')).json();
 assert(manifest.start_url==='workspace.html'&&manifest.id==='./'&&manifest.icons.some(i=>i.purpose==='any maskable'),'PWA opens editor, preserves install identity and declares maskable icon');
 await page.goto(WEB+'?platform=reels&n=1&version=short#preset');await page.locator('#file').waitFor();
 assert(new URL(page.url()).pathname.endsWith('/workspace.html')&&new URL(page.url()).hash==='#preset','legacy settings link keeps parameters and fragment');
 await page.waitForFunction(()=>document.querySelector('.chips[data-k="n"] [data-v="1"]').getAttribute('aria-pressed')==='true');
 assert(await page.evaluate(()=>localStorage.getItem('integration.keep'))==='preserved','homepage/editor navigation preserves existing browser storage');
 await page.goto(WEB+'?utm_source=review');await page.locator('#motion').waitFor();
 assert(!new URL(page.url()).pathname.endsWith('workspace.html'),'tracking-only queries stay on homepage');
 await page.setViewportSize({width:320,height:760});await page.emulateMedia({reducedMotion:'reduce'});
 assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'integrated homepage fits 320px');
 assert(await page.locator('#motion').isDisabled(),'integrated homepage respects reduced motion');
 await page.setViewportSize({width:1360,height:900});
 await page.screenshot({path:join(out,'homepage-integrated.png'),animations:'disabled'});
 await ctx.setOffline(true);await page.goto(WEB+'workspace.html?offline=1');await page.locator('#file').waitFor();
 assert(await page.locator('.mark path').count()===2,'offline editor has selected logo');
 await page.goto(WEB+'index.html');await page.locator('#motion').waitFor();
 assert(await page.locator('.brand-full').first().evaluate(i=>i.complete&&i.naturalWidth>0),'offline homepage and brand assets load');
 await ctx.setOffline(false);assert(errors.length===0,'web route changes have no JavaScript errors');await ctx.close();
 }
 const base='http://127.0.0.1:8790/',key=randomBytes(24).toString('hex'),jobs=await mkdtemp(join(tmpdir(),'cm-home-integration-'));
 let busy=false;try{await fetch(base+'api/info');busy=true;}catch{}if(busy)throw Error('Port 8790 occupied; refusing to reuse');
 srv=spawn(join(root,'.venv/bin/python'),['app.py'],{cwd:desktopRoot,env:{...process.env,CLIP_PORT:'8790',CLIP_KEY:key,CLIP_JOBS:jobs,CLIP_LOG:join(jobs,'log.json'),CLIP_STUDIO:join(jobs,'studio.json')},stdio:'ignore'});
 let up=false;for(let i=0;i<80;i++){try{if((await fetch(base+'api/info',{headers:{'X-Key':key}})).ok){up=true;break;}}catch{}await new Promise(r=>setTimeout(r,250));}assert(up,'isolated desktop started on 8790');
 const desk=await browser.newContext({viewport:{width:1360,height:900}}),dp=await desk.newPage();
 await dp.goto(base+'?key='+key);await dp.waitForFunction(()=>document.body.classList.contains('desk'));
 assert(!new URL(dp.url()).searchParams.has('key'),'desktop root opens editor and removes key from address bar');
 assert(await dp.locator('.mark path').count()===2,'desktop editor displays Peak window');
 await dp.screenshot({path:join(out,process.env.DESKTOP_ROOT?'desktop-release-integrated.png':'desktop-integrated.png'),animations:'disabled'});
 await dp.getByRole('link',{name:'Clip Machine home',exact:true}).click();await dp.locator('#motion').waitFor();
 await dp.locator('a[href="workspace.html"]').first().click();await dp.waitForFunction(()=>document.body.classList.contains('desk'));
 assert(await dp.locator('#file').count()===1,'desktop homepage returns to native editor with existing authentication');
 for(const asset of ['icon.svg','icon-180.png','icon-512.png','brand/favicon.svg','brand/favicon-32.png','brand/favicon.ico']){
  const r=await fetch(base+asset);assert(r.ok&&Buffer.compare(Buffer.from(await r.arrayBuffer()),await readFile(join(docs,asset)))===0,'desktop serves exact selected '+asset);
 }
 assert((await fetch(base+'workspace.html')).status===403&&(await fetch(base+'api/jobs')).status===403,'desktop workspace and jobs still require the access key');
 await desk.close();console.log('all checks passed'+(process.env.DESKTOP_ROOT?' (packaged desktop)':''));
}finally{if(browser)await browser.close();if(srv)srv.kill('SIGTERM');await new Promise(r=>web.close(r));}
