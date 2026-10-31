import { SCRIPTS, MAX_BUBBLES, MAX_BUBBLE_CHARS } from './lab.js';

/** Public shell, authenticated APIs. Untrusted transcripts use textContent, never HTML. */
export function labPage() {
  return String.raw`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Clarion · WhatsApp lab</title><style>
:root{font:16px system-ui;color:#e9edef;background:#111b21}body{margin:0 auto;max-width:1000px;padding:24px}h1{font-size:26px}button,input,textarea{font:inherit;border:1px solid #50626d;border-radius:8px;padding:10px;background:#202c33;color:inherit}button{cursor:pointer;margin:4px}button:hover,button[aria-selected=true]{background:#005c4b}button:disabled{opacity:.5}input{max-width:95%}textarea{width:95%;min-height:90px}section{margin-top:20px}.chat{background:#0b141a;padding:16px;border-radius:12px;margin:12px 0}.bubble{white-space:pre-wrap;overflow-wrap:anywhere;background:#202c33;border-radius:10px;padding:10px 14px;max-width:80%;margin:8px 0}.user{background:#005c4b;margin-left:auto}.reaction{font-size:20px;display:block;text-align:right}.pass{color:#71e6a4}.fail{color:#ff8e8e}.meta{color:#aebac1;font-size:13px}pre{white-space:pre-wrap;overflow-wrap:anywhere}label{display:block;margin:12px 0}[hidden]{display:none!important}
</style><h1>Clarion · WhatsApp lab</h1><p class="meta">Real inbound handler · captured sends · isolated passengers · mechanical checks</p>
<form id="auth"><label>DEMO_TOKEN <input id="token" type="password" required autocomplete="off"></label><button>Open lab</button></form>
<p id="status" role="status"></p><div id="main" hidden><nav><button id="scripts-tab" aria-selected="true">Scripts</button><button id="live-tab" aria-selected="false">Live</button><button id="logout">Change token</button></nav>
<section id="scripts"><p class="meta">Each run starts a new passenger. Limits: ${MAX_BUBBLES} text bubbles / turn, ${MAX_BUBBLE_CHARS} characters / bubble. Language is a lexical smoke check. Evacuation permits direct instructions.</p><div id="buttons"><button data-run="">Run all</button>${Object.keys(SCRIPTS).map(n => `<button data-run="${n}">${n}</button>`).join('')}</div>
<details><summary>Custom conversation</summary><label>One passenger message per line<textarea id="texts" placeholder="English&#10;How long is the security queue?"></textarea></label><button id="custom">Run custom</button></details>
<label><input id="keep" type="checkbox"> Keep isolated run state for inspection</label><div id="results"></div></section>
<section id="live" hidden><p class="meta">Last 200 real WhatsApp events · phones masked · text capped at 200 characters · refresh every 3s</p><div id="events"></div></section></div>
<script>
const $=s=>document.querySelector(s);
const el=(tag,cls,text)=>{const n=document.createElement(tag);n.className=cls||'';n.textContent=text??'';return n};
const storage={get:()=>{try{return localStorage.getItem('clarionLabToken')||''}catch{return ''}},set:v=>{try{v?localStorage.setItem('clarionLabToken',v):localStorage.removeItem('clarionLabToken')}catch{}}};
let token=storage.get(),live=false,busy=false,polling=false;
function gate(){storage.set('');$('#auth').hidden=false;$('#main').hidden=true}
async function api(path,body){const r=await fetch(path,{method:body===undefined?'GET':'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});if(r.status===401)gate();const d=await r.json();if(!r.ok)throw Error(d.error||'HTTP '+r.status);return d}
function error(e){$('#status').textContent=e.message}
async function open(){await api('/lab/events');storage.set(token);$('#auth').hidden=true;$('#main').hidden=false;$('#status').textContent='Ready'}
$('#auth').onsubmit=async e=>{e.preventDefault();token=$('#token').value;try{await open()}catch(e){error(e)}};
$('#logout').onclick=()=>{token='';gate()};
async function refresh(){if(!live||polling||$('#main').hidden)return;polling=true;try{const d=await api('/lab/events');$('#events').replaceChildren(...d.events.slice().reverse().map(e=>el('pre',e.kind==='send-failure'||e.kind==='agent-error'?'fail':'meta',JSON.stringify(e,null,2))))}catch(e){error(e)}finally{polling=false}}
function tab(v){live=v;$('#live').hidden=!v;$('#scripts').hidden=v;$('#live-tab').setAttribute('aria-selected',String(v));$('#scripts-tab').setAttribute('aria-selected',String(!v));refresh()}
$('#live-tab').onclick=()=>tab(true);$('#scripts-tab').onclick=()=>tab(false);setInterval(refresh,3000);
function render(report){$('#results').replaceChildren();for(const [name,r] of Object.entries(report.results)){const box=el('article','chat');box.append(el('h2',r.violations.length?'fail':'pass',name+' · '+(r.violations.length?'FAIL':'PASS')),el('p','meta',r.phone+(r.kept?' · state retained':'')));r.transcript.forEach((t,i)=>{const turn=el('div');const user=el('div','bubble user',t.user);turn.append(user);for(const b of t.replies){if(b.startsWith('[react]'))user.append(el('span','reaction',b.slice(7)));else turn.append(el('div','bubble',b))}turn.append(el('p','meta',t.ms+'ms · tools: '+(t.tools.join(', ')||'none')+' · language: '+t.lang));const bad=r.violations.filter(v=>v.turn===i+1);turn.append(el('p',bad.length?'fail':'pass',bad.length?bad.map(v=>v.rule+': '+v.detail).join('\n'):'✓ All checks pass'));box.append(turn)});$('#results').append(box)}}
async function run(body){if(busy)return;busy=true;document.querySelectorAll('[data-run],#custom').forEach(b=>b.disabled=true);$('#status').textContent='Running…';try{const r=await api('/lab/run',{...body,keep:$('#keep').checked});render(r);$('#status').textContent=r.pass?'PASS':'FAIL: '+r.failed.join(', ')}catch(e){error(e)}finally{busy=false;document.querySelectorAll('[data-run],#custom').forEach(b=>b.disabled=false)}}
$('#buttons').onclick=e=>{const b=e.target.closest('[data-run]');if(b)run(b.dataset.run?{script:b.dataset.run}:{})};$('#custom').onclick=()=>run({texts:$('#texts').value.split('\n').filter(t=>t.trim())});
if(token)open().catch(error);
</script></html>`;
}
