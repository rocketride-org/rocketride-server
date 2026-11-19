/* Test-only page instrumentation around unmodified production/development assets. */
(() => {
 const c=window.__suppConfig;
 const state=window.__supp={loaded:0,assetErrors:0,registrationLog:false,rejectionLogs:0,bootstrapError:false,sentinelSaved:false,checksStarted:false};
 const native={};
 for(const level of ['log','warn','error']) {
  native[level]=console[level].bind(console);
  console[level]=(...args)=>{const text=args.map(String).join(' ');if(text.includes('Local override registered for "'+c.appId+'"'))state.registrationLog=true;if(text.includes('from untrusted sender'))state.rejectionLogs++;if(text.includes('[bootstrap] Server probe failed:'))state.bootstrapError=true;native[level](...args);};
 }
 // Fresh, credential-free origin state; all values are inert test labels.
 localStorage.removeItem('rr:user_token');
 sessionStorage.setItem('rr:dev','1');
 sessionStorage.setItem('rr:tab',JSON.stringify({dev:true,appId:c.appId,authOrigin:''}));
 window.__rrDevBoot={appId:c.appId};
 const reportTo=(window.opener||window.parent);
 const readToken=()=>{try{if(c.flavor==='prod')return {readable:true,value:localStorage.getItem('rr:user_token')||''};const cm=window.__rrShellDev?.getShareScope()?.shell?.ConnectionManager?.getInstance();return typeof cm?.loadToken==='function'?{readable:true,value:cm.loadToken()}:{readable:false,value:null};}catch{return {readable:false,value:null};}};
 const selected=()=>c.assets.every(a=>[...document.scripts].some(s=>new URL(s.src||location.href).pathname===a.url));
 const otherLoaded=()=>performance.getEntriesByType('resource').some(r=>c.otherAssets.some(a=>new URL(r.name).pathname===a.url));
 const parentSameOrigin=()=>{try{return window.parent!==window&&window.parent.location.origin===location.origin;}catch{return false;}};
 const base=()=>({id:c.id,flavor:c.flavor,hooksPresent:!!window.__rrShellDev,selectedScriptsLoaded:state.loaded===c.assets.length,otherFlavorLoaded:otherLoaded(),rootRendered:!!document.querySelector('#root')?.childElementCount,bootstrapPortal:!!document.querySelector('#rr-popup-portal'),bootstrapError:state.bootstrapError,assetErrors:state.assetErrors,framed:window.self!==window.top,parentSameOrigin:parentSameOrigin(),openerPresent:!!window.opener,registrationLog:state.registrationLog,rejectionLogs:state.rejectionLogs});
 const record=async value=>{await fetch('/supplemental/results',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(value)});reportTo.postMessage({type:'supplemental:result',...value},'*');};
 const started=performance.now();
 const timer=setInterval(()=>{
  const b=base();
  if(b.assetErrors||b.bootstrapError){clearInterval(timer);void record({...b,status:'LOAD_FAILURE'});return;}
  if(b.selectedScriptsLoaded&&selected()&&b.rootRendered&&b.bootstrapPortal&&(c.flavor==='prod'||b.hooksPresent)){
   clearInterval(timer);state.baselineToken=readToken();reportTo.postMessage({type:'supplemental:ready',id:c.id},'*');
  }else if(performance.now()-started>25000){clearInterval(timer);void record({...b,status:'READINESS_TIMEOUT'});}
 },100);
 window.addEventListener('message',event=>{
  if(event.source!==reportTo||event.data?.type!=='supplemental:check'||state.checksStarted)return;
  state.checksStarted=true;
  setTimeout(()=>console.log('RR2960_FORWARDING_CONTROL_'+c.id),300);
  setTimeout(async()=>{
   const b=base(),token=readToken();
   const tokenObserverReadable=token.readable&&state.baselineToken?.readable===true;
   const tokenBaselineUnchanged=tokenObserverReadable&&token.value===state.baselineToken.value;
   const saved=[localStorage.getItem('rr:user_token'),token.value];
   const tokenSentinelSaved=saved.includes(c.sentinel)||saved.includes(c.fragment);
   const remoteRequests=(await(await fetch('/supplemental/counts')).json())[c.id]||0;
   const positiveRendered=document.querySelector('#root')?.textContent.includes('RR2960_POSITIVE_REMOTE_RENDERED')||false;
   const fragmentRemoved=!location.hash.includes(c.fragment);
   const valid=b.selectedScriptsLoaded&&!b.otherFlavorLoaded&&!b.bootstrapError&&!b.assetErrors&&b.rootRendered&&b.bootstrapPortal;
   // Framed URLs belong to their embedder; only top-level rejected fragments are stripped.
   const fragmentPolicySatisfied=b.framed?!fragmentRemoved:fragmentRemoved;
   // This credential-free positive proves registration and forwarding; the login gate may
   // keep the registered remote unfetched. The real authenticated previews test rendering.
   const pass=c.positive?valid&&b.hooksPresent&&b.registrationLog:valid&&b.hooksPresent===(c.flavor==='dev')&&tokenObserverReadable&&tokenBaselineUnchanged&&!tokenSentinelSaved&&!b.registrationLog&&remoteRequests===0&&(c.flavor==='prod'?fragmentPolicySatisfied:b.rejectionLogs>=2);
   await record({...b,status:pass?'OBSERVATIONS_PASS':'FAIL',scope:c.positive?'remote-registration-and-console-positive':'credential-and-remote-rejection',tokenObserverReadable,tokenBaselineUnchanged,tokenSentinelSaved,remoteRequests,positiveRendered,fragmentRemoved,fragmentPolicySatisfied});
  },2000);
 });
})();
