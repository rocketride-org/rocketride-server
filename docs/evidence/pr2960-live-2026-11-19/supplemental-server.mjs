// Independent, credential-free HTTP regression controls; never a Builder debug substitute.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const worktree = process.env.SUPPLEMENTAL_WORKTREE || '/Users/nihalnihalani/Desktop/Github/rr-worktrees/pr2960-live-20261119';
const shellOrigin = 'http://127.0.0.1:5586';
const attackerOrigin = 'http://localhost:5587';
const staticRoot = path.join(worktree, 'dist/server/static');
const sourceHtml = fs.readFileSync(path.join(staticRoot, 'shell/index.html'), 'utf8');
const flavors = JSON.parse(sourceHtml.match(/var RR_FLAVORS=(\{.*?\});/s)[1]);
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const assets = Object.fromEntries(Object.entries(flavors).map(([flavor, entries]) => [flavor, entries.js.map(url => ({url, sha256: sha(fs.readFileSync(path.join(staticRoot, url.slice(1))))}))]));
const cases = {
  'production-parent': { flavor: 'prod', positive: false },
  'dev-foreign-parent': { flavor: 'dev', positive: false },
  'dev-same-origin-positive': { flavor: 'dev', positive: true },
  'production-opener': { flavor: 'prod', positive: false },
  'dev-foreign-opener': { flavor: 'dev', positive: false },
};
const results = {};
const counts = {};
const receive = req => new Promise((resolve, reject) => { let body=''; req.on('data', b => {body+=b; if(body.length>20000)req.destroy();});req.on('end',()=>resolve(body));req.on('error',reject); });
function send(res, body, type='text/html', status=200) {res.writeHead(status, {'Content-Type':type,'Cache-Control':'no-store','Access-Control-Allow-Origin':'*'});res.end(body);}
function testPage(id) {
  const spec=cases[id];if(!spec)return null;
  const appId='local.'+id.replaceAll('-','_');
  const config={id,...spec,appId,moduleId:appId.replaceAll('.','_'),shellOrigin,attackerOrigin,assets:assets[spec.flavor],otherAssets:assets[spec.flavor==='prod'?'dev':'prod'],sentinel:'RR2960_INERT_ATTACK_'+id,fragment:'RR2960_INERT_FRAGMENT_'+id};
  const styles=flavors[spec.flavor].css.map(url=>`<link rel="stylesheet" href="${url}">`).join('');
  const scripts=flavors[spec.flavor].js.map(url=>`<script defer src="${url}" onload="window.__supp.loaded++" onerror="window.__supp.assetErrors++"></script>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>PR2960 ${id}</title>${styles}<script>window.__suppConfig=${JSON.stringify(config)};</script><script src="/supplemental/observer.js"></script></head><body><div id="root"></div>${scripts}</body></html>`;
}
function driverPage(control=null) {
  const origin=control?shellOrigin:attackerOrigin;
  return `<!doctype html><html><head><meta charset="utf-8"><title>PR2960 HTTP bundle controls</title><style>body{font:15px system-ui;margin:24px;background:#f4f7fa;color:#152238}h1{font-size:24px}button{padding:10px;margin:8px 8px 8px 0}pre{white-space:pre-wrap;background:white;padding:16px;border:1px solid #ccd5df}iframe{width:100%;height:180px;border:1px solid #ccd5df}.note{max-width:1000px}</style></head><body><h1>PR 2960 — actual built shell HTTP controls</h1><p class="note">Credential-free defensive tests. Production/dev assets are selected explicitly; no flavor-picker script runs. These pages are independent test fixtures, not App Builder debug evidence. LOAD_FAILURE and TIMEOUT never count as PASS.</p>${control?'':'<button id="start">Run framed controls</button><button id="prodOpen">Open production opener control</button><button id="devOpen">Open dev opener control</button><button id="refresh">Refresh results</button>'}<table id="summary" style="border-collapse:collapse;background:white;width:100%;font-size:13px;margin:16px 0"></table><details open><summary>All raw observations and asset hashes</summary><pre id="results">NOT RUN</pre></details><div id="frames"></div><script>window.__suppDriverConfig=${JSON.stringify({control,origin,shellOrigin,attackerOrigin})};</script><script src="/supplemental/driver.js"></script></body></html>`;
}
function proxy(req,res) {
  const upstream=http.request({host:'127.0.0.1',port:5565,path:req.url,method:req.method,headers:{...req.headers,host:'127.0.0.1:5565'}},back=>{res.writeHead(back.statusCode,back.headers);back.pipe(res);});
  upstream.on('error',()=>send(res,'Engine proxy failed','text/plain',502));req.pipe(upstream);
}
async function handler(req,res) {
  const url=new URL(req.url,'http://localhost');
  if(url.pathname==='/supplemental/results') {
    if(req.method==='POST') {try {const x=JSON.parse(await receive(req));if(cases[x.id])results[x.id]={...results[x.id],...x,receivedAt:new Date().toISOString()};}catch {return send(res,'invalid JSON','text/plain',400);}}
    return send(res,JSON.stringify({testedHead:'7c36f51af7d4a58af5bf2efdd4db55fe54b5b86b',assets,results,remoteRequests:counts},null,2),'application/json');
  }
  if(url.pathname==='/supplemental/same-origin-parent')return send(res,driverPage('dev-same-origin-positive'));
  if(url.pathname==='/supplemental/same-origin-production')return send(res,driverPage('production-parent'));
  if(url.pathname==='/supplemental/observer.js'||url.pathname==='/supplemental/driver.js')return send(res,fs.readFileSync(path.join(here,'supplemental-'+path.basename(url.pathname))),'text/javascript');
  if(url.pathname.startsWith('/supplemental/shell/')) {const html=testPage(url.pathname.split('/').at(-1));return html?send(res,html):send(res,'unknown case','text/plain',404);}
  if(url.pathname.startsWith('/supplemental/remote/')) {
    const id=path.basename(url.pathname,'.js');counts[id]=(counts[id]||0)+1;
    const moduleId=('local.'+id.replaceAll('-','_')).replaceAll('.','_');
    return send(res,`window.${moduleId}={init:function(){},get:function(){return Promise.resolve(function(){return {default:{id:${JSON.stringify('local.'+id.replaceAll('-','_'))},name:'Inert positive control',components:{App:function(){return 'RR2960_POSITIVE_REMOTE_RENDERED';}}}};});}};`,'text/javascript');
  }
  if(url.pathname==='/supplemental/counts')return send(res,JSON.stringify(counts),'application/json');
  if(url.pathname==='/')return send(res,driverPage());
  // The exact engine assets and public probe are relayed byte-for-byte.
  proxy(req,res);
}
for(const port of [5586,5587]) {
  const server=http.createServer((req,res)=>void handler(req,res).catch(()=>send(res,'harness failure','text/plain',500)));
  server.on('upgrade',(req,socket,head)=>{
    const upstream=http.request({host:'127.0.0.1',port:5565,path:req.url,method:req.method,headers:{...req.headers,host:'127.0.0.1:5565'}});
    upstream.on('upgrade',(response,back,backHead)=>{socket.write(`HTTP/1.1 ${response.statusCode} ${response.statusMessage}\r\n`+Object.entries(response.headers).map(([k,v])=>`${k}: ${v}`).join('\r\n')+'\r\n\r\n');if(head.length)back.write(head);if(backHead.length)socket.write(backHead);socket.pipe(back).pipe(socket);back.on('error',()=>socket.destroy());socket.on('error',()=>back.destroy());});
    upstream.on('error',()=>socket.destroy());upstream.end();
  });
  server.listen(port,'127.0.0.1',()=>console.log(`Supplemental HTTP control listener ${port}`));
}
fs.writeFileSync(path.join(here,'supplemental-artifacts.json'),JSON.stringify({testedHead:'7c36f51af7d4a58af5bf2efdd4db55fe54b5b86b',engine:'http://localhost:5565',shellOrigin,attackerOrigin,sourceIndexSha256:sha(sourceHtml),assets},null,2)+'\n');
