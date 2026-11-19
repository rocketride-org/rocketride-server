/* Drives real browser-origin relationships using inert labels, no credentials. */
(() => {
 const c=window.__suppDriverConfig,children=new Map(),ready=new Set(),devReady=new Set(),sent=new Set(),forwarded=new Set(),finished=new Set();
 const out=document.querySelector('#results'),frames=document.querySelector('#frames');
 async function refresh(){const data=await(await fetch('/supplemental/results')).json();out.textContent=JSON.stringify(data,null,2);const table=document.querySelector('#summary');table.replaceChildren();const add=(values,header=false)=>{const tr=document.createElement('tr');for(const value of values){const td=document.createElement(header?'th':'td');td.textContent=String(value??'—');td.style.cssText='border:1px solid #ccd5df;padding:8px;text-align:left';tr.append(td);}table.append(tr);};add(['Case','Status','Flavor','Relation','Hooks','Token unchanged','Registered / requests','Forwarded'],true);for(const id of ['production-parent','dev-foreign-parent','dev-same-origin-positive','production-opener','dev-foreign-opener']){const r=data.results[id]||{};add([id,r.status||'NOT RUN',r.flavor,r.openerPresent?'opener':r.framed?(r.parentSameOrigin?'same-origin parent':'foreign parent'):'—',r.hooksPresent,r.tokenBaselineUnchanged,r.registrationLog===undefined?'—':String(r.registrationLog)+' / '+r.remoteRequests,r.forwardedConsole]);}return data;}
 function url(id){return c.shellOrigin+'/supplemental/shell/'+id+'?rrdev=1&appid='+encodeURIComponent('local.'+id.replaceAll('-','_'))+(id==='dev-foreign-opener'?'':'#rrtoken='+encodeURIComponent('RR2960_INERT_FRAGMENT_'+id));}
 function inject(id,target){if(sent.has(id)||!ready.has(id)||(id.startsWith('dev-')&&!devReady.has(id)))return;sent.add(id);const appId='local.'+id.replaceAll('-','_');target.postMessage({type:'rrdev:auth',token:id==='dev-same-origin-positive'?'':'RR2960_INERT_ATTACK_'+id},c.shellOrigin);target.postMessage({type:'rrdev:registerRemote',appId,moduleId:appId.replaceAll('.','_'),name:'Inert supplemental remote',entry:c.shellOrigin+'/supplemental/remote/'+id+'.js',manifest:{id:appId,name:'Inert supplemental remote',authenticated:false}},c.shellOrigin);target.postMessage({type:'supplemental:check'},c.shellOrigin);}
 window.addEventListener('message',event=>{
  const pair=[...children].find(([,win])=>win===event.source);if(!pair)return;const [id,target]=pair;
  if(event.origin!==c.shellOrigin)return;
  if(event.data?.type==='shell:devReady')devReady.add(id);
  if(event.data?.type==='supplemental:ready')ready.add(id);
  if(event.data?.type==='shell:devConsole'&&String(event.data.text).includes('RR2960_FORWARDING_CONTROL_'+id))forwarded.add(id);
  inject(id,target);
  if(event.data?.type==='supplemental:result'){
   finished.add(id);
   const value={...event.data};delete value.type;value.forwardedConsole=forwarded.has(id);
   if(value.status==='OBSERVATIONS_PASS')value.status=(id==='dev-same-origin-positive'?value.forwardedConsole:!value.forwardedConsole)?'PASS':'FAIL_CONSOLE_FORWARDING';
   void fetch('/supplemental/results',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(value)}).then(refresh);
  }
 });
 function deadline(id){setTimeout(()=>{if(!finished.has(id))void fetch('/supplemental/results',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id,status:ready.has(id)?'ATTACK_RESULT_TIMEOUT':'DRIVER_READINESS_TIMEOUT'})}).then(refresh);},30000);}
 function frame(id){const f=document.createElement('iframe');f.src=url(id);f.title=id;frames.append(f);children.set(id,f.contentWindow);deadline(id);}
 function opened(id){const w=window.open(url(id),'rr2960_'+id);if(w){children.set(id,w);deadline(id);}else void fetch('/supplemental/results',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id,status:'POPUP_BLOCKED'})}).then(refresh);}
 if(c.control)frame(c.control);
 else {
  document.querySelector('#start').onclick=()=>{frame('dev-foreign-parent');for(const [route,title]of [['same-origin-production','Same-origin production gate control'],['same-origin-parent','Same-origin dev remote and console positive']]){const f=document.createElement('iframe');f.title=title;f.src=c.shellOrigin+'/supplemental/'+route;f.style.height='500px';frames.append(f);}document.querySelector('#start').disabled=true;};
  document.querySelector('#prodOpen').onclick=()=>opened('production-opener');
  document.querySelector('#devOpen').onclick=()=>opened('dev-foreign-opener');
  document.querySelector('#refresh').onclick=()=>void refresh();
 }
 setInterval(()=>void refresh(),1500);
})();
