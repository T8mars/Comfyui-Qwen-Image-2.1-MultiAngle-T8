// Development-only server and browser; never operates a running ComfyUI instance.
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, extname, sep } from 'node:path';
import { createRequire } from 'node:module';
import { uiLayout } from './ui-layout.mjs';
import { guideEditor } from './guide-editor.mjs';
const require=createRequire(import.meta.url), {chromium}=require(process.env.ANYANGLE_PLAYWRIGHT || 'playwright');
const root=resolve(fileURLToPath(new URL('..',import.meta.url))),out=resolve(root,'.local','ui-browser');
await mkdir(out,{recursive:true});
const types={'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.png':'image/png','.jpg':'image/jpeg','.css':'text/css','.svg':'image/svg+xml','.woff2':'font/woff2'};
const server=createServer(async(req,res)=>{try {
  const path=new URL(req.url,'http://localhost').pathname;
  if(['/tests/editor.html','/tests/gestures.html'].includes(path)) {
    let html=await readFile(resolve(root,'web/editor/index.html'),'utf8');
    if(path==='/tests/gestures.html') {
      const app=await readFile(resolve(root,'web/editor/app.mjs'),'utf8'),scene=app.match(/from '(\.\/scene\.mjs[^']*)'/)[1];
      html=html.replace(/<script type="module" src="([^"]+)"><\/script>/,(_,entry)=>`<script type="module">import {StudioScene} from '${scene}'; const init=StudioScene.prototype.init; StudioScene.prototype.init=async function(...args){window.auditStudio=this;return init.apply(this,args);};await import('${entry}');</script>`);
    }
    res.writeHead(200,{'Content-Type':'text/html'});res.end(html.replace('<head>','<head><base href="/web/editor/">'));return;
  }
  if(!path.startsWith('/web/')){res.writeHead(404);res.end();return;}
  const file=resolve(root,'.'+path);if(!file.startsWith(root+sep)){res.writeHead(400);res.end();return;}
  const data=await readFile(file);res.writeHead(200,{'Content-Type':types[extname(file)]||'application/octet-stream'});res.end(data);
}catch{res.writeHead(404);res.end();}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve)); let browser;
try {
  browser=await chromium.launch({headless:true,executablePath:process.env.ANYANGLE_CHROMIUM||undefined});
  const origin=`http://127.0.0.1:${server.address().port}`;
  const receipt={date:new Date().toISOString(),layout:await uiLayout(browser,origin,out),guides:await guideEditor(browser,origin)};
  await writeFile(resolve(out,'receipt.json'),JSON.stringify(receipt,null,2));console.log(JSON.stringify(receipt));
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
