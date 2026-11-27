#!/usr/bin/env node
'use strict';
// tinyprobe hub + management console — zero dependencies.
// Usage: node hub.js [--port 8090] [--token SECRET] [--keep 180] [--state hub-state.json]
//
// Remote update model:
//   - Hub holds a desired version, a URL template (with {arch} and {ver}),
//     and a SHA256SUMS URL template.
//   - Each agent report carries its arch + version. If version differs from
//     desired and an update is armed for that arch, the report response
//     includes a one-shot "cmd: update" with the concrete download URL+sha256.
//   - Agent downloads, verifies sha256, replaces itself, restarts.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function arg(key, def) {
  const i = process.argv.indexOf('--' + key);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const PORT = parseInt(arg('port', '8090'), 10) || 8090;
const TOKEN = arg('token', '');
const ADMIN_TOKEN = arg('admin-token', TOKEN || 'admin');
const KEEP = Math.max(10, parseInt(arg('keep', '180'), 10) || 180);
const STATE_FILE = arg('state', path.join(__dirname, 'hub-state.json'));

/** @type {Map<string, {latest:any, history:any[], pending:any|null}>} */
const hosts = new Map();

// ---------- update config (persisted) ----------
const defaultUpdate = {
  version: '',                       // desired version, e.g. v1.1.0; empty = no updates
  urlTemplate: '',                   // e.g. https://raw.githubusercontent.com/OWNER/REPO/main/dist/probe-linux-{arch}
  sumsTemplate: '',                  // e.g. https://raw.githubusercontent.com/OWNER/REPO/main/dist/SHA256SUMS
  armed: false,                      // master switch: only when true are commands issued
  perArch: {},                       // { "amd64": {"version":"v1.1.0","url":"...","sha256":"..."} } manual override
  shaCache: {},                      // version -> { arch: sha }
};

function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (s && s.update) Object.assign(update, s.update);
    if (s && s.hosts) {
      for (const [k, v] of Object.entries(s.hosts)) {
        hosts.set(k, { latest: v.latest || null, history: v.history || [], pending: null });
      }
    }
  } catch (_) { /* fresh state */ }
}
const update = Object.assign({}, defaultUpdate);
loadState();

let saveTimer = null;
function saveState() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      const obj = { update, hosts: {} };
      for (const [k, v] of hosts) obj.hosts[k] = { latest: v.latest, history: v.history };
      fs.writeFileSync(STATE_FILE, JSON.stringify(obj));
    } catch (e) { console.error('save state:', e.message); }
  }, 500);
}

// ---------- helpers ----------
function human(b) {
  if (b == null) return '-';
  const u = ['B', 'K', 'M', 'G', 'T'];
  let i = 0;
  while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return b.toFixed(i ? 1 : 0) + u[i];
}
function readBody(req, cb, max = 2e6) {
  let size = 0;
  const chunks = [];
  req.on('data', c => {
    size += c.length;
    if (size > max) { req.destroy(); return; }
    chunks.push(c);
  });
  req.on('end', () => cb(Buffer.concat(chunks).toString('utf8')));
}
function json(res, code, obj) {
  const b = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(b) });
  res.end(b);
}
function isAdmin(req) {
  if (!ADMIN_TOKEN) return true;
  const h = req.headers['x-admin-token'];
  return h === ADMIN_TOKEN || (req.headers['authorization'] || '').endsWith(ADMIN_TOKEN);
}

// ---------- SHA256SUMS fetching + cache ----------
function parseSums(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^([0-9a-fA-F]{64})\s+(\S+)$/);
    if (m) out[path.basename(m[2])] = m[1].toLowerCase();
  }
  return out;
}
function fetchText(url, cb) {
  const mod = url.startsWith('https:') ? require('https') : require('http');
  const req = mod.get(url, { headers: { 'User-Agent': 'tinyprobe-hub' } }, res => {
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
      res.resume();
      return fetchText(new URL(res.headers.location, url).toString(), cb);
    }
    if (res.statusCode !== 200) { res.resume(); return cb(null, 'HTTP ' + res.statusCode); }
    let b = '';
    res.setEncoding('utf8');
    res.on('data', c => { b += c; if (b > 2e6) req.destroy(); });
    res.on('end', () => cb(b, null));
  });
  req.on('error', e => cb(null, e.message));
  req.setTimeout(10000, () => req.destroy(new Error('timeout')));
}
function refreshSums(cb) {
  if (!update.sumsTemplate || !update.version) return cb(null, 'no sumsTemplate/version');
  const url = update.sumsTemplate.replace('{ver}', update.version);
  if (update.shaCache[update.version]) return cb(update.shaCache[update.version], null);
  fetchText(url, (text, err) => {
    if (err) return cb(null, err);
    const sums = parseSums(text);
    update.shaCache[update.version] = sums;
    saveState();
    cb(sums, null);
  });
}

// Decide the update command for one host. Returns null or a Command object.
// `h` is the stored host record so pending state persists across reports.
function commandFor(h) {
  if (!update.armed || !update.version) return null;
  const host = h.latest || {};
  const arch = host.arch;
  const cur = host.version || '';
  if (cur === update.version && cur !== 'dev') return null;
  // If this arch was already sent the same target and not yet applied, skip.
  if (h.pending && h.pending.version === update.version &&
      Date.now() - h.pending.at < 60000) return null;

  let url = '';
  let sha = '';
  const ov = update.perArch[arch];
  if (ov && ov.version === update.version) {
    url = ov.url || '';
    sha = ov.sha256 || '';
  } else {
    if (!update.urlTemplate) return null;
    url = update.urlTemplate
      .replace('{arch}', arch)
      .replace('{ver}', update.version);
    const sums = update.shaCache[update.version];
    if (sums) sha = sums['probe-linux-' + arch] || sums['probe-linux_' + arch] || '';
  }
  if (!url) return null;
  h.pending = { version: update.version, at: Date.now() };
  return { cmd: 'update', version: update.version, url, sha256: sha };
}

// ---------- report handling ----------
function handleReport(req, res) {
  if (TOKEN && req.headers['x-token'] !== TOKEN) return json(res, 403, { error: 'forbidden' });
  readBody(req, body => {
    let d;
    try { d = JSON.parse(body); } catch (_) { return json(res, 400, { error: 'bad json' }); }
    if (!d || !d.name) return json(res, 400, { error: 'missing name' });
    d.time = Date.now();
    let h = hosts.get(d.name);
    if (!h) { h = { latest: null, history: [], pending: null }; hosts.set(d.name, h); }
    h.latest = d;
    h.history.push(d);
    if (h.history.length > KEEP) h.history.splice(0, h.history.length - KEEP);
    saveState();
    const cmd = commandFor(h);
    json(res, 200, { ok: true, cmd: cmd || undefined });
  });
}

function snapshot() {
  const now = Date.now();
  const list = [];
  for (const [name, h] of hosts) {
    if (!h.latest) continue;
    const l = h.latest;
    list.push({
      name, online: now - l.time < 15000, time: l.time,
      host: l.host, version: l.version || '', arch: l.arch, platform: l.platform,
      cpu: l.cpu, mem: l.mem, disk: l.disk, net: l.net, cpus: l.cpus,
      load: l.load, uptime: l.uptime,
      history: h.history.map(x => ({ t: x.time, cpu: x.cpu, m: x.mem && x.mem.percent })),
    });
  }
  list.sort((a, b) => a.name.localeCompare(b.name));
  return {
    now, hosts: list,
    update: {
      version: update.version, armed: update.armed,
      urlTemplate: update.urlTemplate, sumsTemplate: update.sumsTemplate,
      hasSums: !!update.shaCache[update.version],
      perArch: update.perArch,
    },
  };
}

// ---------- API ----------
function handleApi(req, res, u) {
  if (u.pathname === '/api/data') return json(res, 200, snapshot());

  if (u.pathname === '/api/update/config' && req.method === 'GET') {
    if (!isAdmin(req)) return json(res, 403, { error: 'admin token required' });
    return json(res, 200, update);
  }
  if (u.pathname === '/api/update/config' && req.method === 'POST') {
    if (!isAdmin(req)) return json(res, 403, { error: 'admin token required' });
    return readBody(req, body => {
      let cfg;
      try { cfg = JSON.parse(body); } catch (_) { return json(res, 400, { error: 'bad json' }); }
      for (const k of ['version', 'urlTemplate', 'sumsTemplate', 'armed', 'perArch']) {
        if (k in cfg) update[k] = cfg[k];
      }
      saveState();
      // pre-fetch sums for the new version
      if (update.version && !update.shaCache[update.version]) {
        refreshSums(() => {});
      }
      json(res, 200, { ok: true, update });
    });
  }
  if (u.pathname === '/api/update/refresh-sums' && req.method === 'POST') {
    if (!isAdmin(req)) return json(res, 403, { error: 'admin token required' });
    delete update.shaCache[update.version];
    return refreshSums((sums, err) => json(res, err ? 500 : 200, err ? { error: err } : { ok: true, sums }));
  }
  if (u.pathname === '/api/update/force' && req.method === 'POST') {
    if (!isAdmin(req)) return json(res, 403, { error: 'admin token required' });
    return readBody(req, body => {
      let d = {};
      try { d = JSON.parse(body || '{}'); } catch (_) {}
      const name = d.name;
      const h = hosts.get(name);
      if (!h || !h.latest) return json(res, 404, { error: 'host not found' });
      h.pending = null; // clear suppression so next report gets the command
      json(res, 200, { ok: true, queued: name });
    });
  }
  return json(res, 404, { error: 'not found' });
}

// ---------- console UI ----------
const HTML = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>tinyprobe 控制台</title><style>
:root{--bg:#0d1117;--card:#161b22;--bd:#30363d;--fg:#e6edf3;--mut:#8b949e;--ok:#3fb950;--bad:#f85149;--acc:#58a6ff;--warn:#d29922}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 -apple-system,"Segoe UI",Arial,sans-serif}
header{padding:12px 20px;border-bottom:1px solid var(--bd);display:flex;align-items:center;gap:12px;flex-wrap:wrap}
header h1{font-size:16px;margin:0}.dot{width:8px;height:8px;border-radius:50%;background:var(--ok);box-shadow:0 0 8px var(--ok)}
.meta{margin-left:auto;color:var(--mut);font-size:12px}
.tabs{display:flex;gap:4px;padding:0 20px;border-bottom:1px solid var(--bd)}
.tab{padding:9px 14px;cursor:pointer;color:var(--mut);border-bottom:2px solid transparent;font-size:13px}
.tab.active{color:var(--fg);border-color:var(--acc)}
.view{display:none;padding:16px}.view.active{display:block}
.wrap{display:grid;grid-template-columns:repeat(auto-fill,minmax(400px,1fr));gap:14px}
.card{background:var(--card);border:1px solid var(--bd);border-radius:8px;padding:14px}.card.off{opacity:.6}
.top{display:flex;align-items:center;gap:8px;margin-bottom:10px;flex-wrap:wrap}
.nm{font-weight:600;font-size:15px}.badge{font-size:11px;padding:1px 7px;border-radius:10px;background:#1f6feb22;color:var(--acc);border:1px solid var(--acc)}
.badge.off{background:#f8514922;color:var(--bad);border-color:var(--bad)}
.badge.ver{background:#3fb95022;color:var(--ok);border-color:var(--ok)}.badge.old{background:#d2992222;color:var(--warn);border-color:var(--warn)}
.sub{color:var(--mut);font-size:11px;margin-left:auto}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:8px 14px}.k{color:var(--mut);font-size:12px}.v{font-variant-numeric:tabular-nums}
.bar{height:6px;border-radius:4px;background:#21262d;overflow:hidden;margin-top:3px}.bar>i{display:block;height:100%;background:var(--ok);border-radius:4px}
.bar.warn>i{background:var(--warn)}.bar.crit>i{background:var(--bad)}
svg{width:100%;height:46px;display:block;margin-top:10px}polyline{fill:none;stroke-width:1.5}.cpu{stroke:var(--acc)}.mem{stroke:var(--warn)}
.empty{color:var(--mut);padding:40px;text-align:center;grid-column:1/-1}
table{width:100%;border-collapse:collapse;font-size:13px}th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--bd)}th{color:var(--mut);font-weight:500}
.btn{background:#1f6feb;color:#fff;border:0;border-radius:6px;padding:7px 14px;cursor:pointer;font-size:13px}.btn:hover{background:#388bfd}
.btn.ghost{background:#21262d;border:1px solid var(--bd);color:var(--fg)}.btn:disabled{opacity:.5;cursor:not-allowed}
.field{margin-bottom:14px}.field label{display:block;color:var(--mut);font-size:12px;margin-bottom:5px}
.field input[type=text],.field input[type=password]{width:100%;background:#0d1117;border:1px solid var(--bd);border-radius:6px;color:var(--fg);padding:9px 10px;font:13px monospace}
.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.panel{background:var(--card);border:1px solid var(--bd);border-radius:8px;padding:18px;max-width:820px}
.hint{color:var(--mut);font-size:12px;margin-top:5px}.toast{position:fixed;right:20px;bottom:20px;background:#1f6feb;color:#fff;padding:10px 16px;border-radius:6px;display:none;z-index:9}
code{background:#21262d;padding:1px 5px;border-radius:4px;font-size:12px}
.tag{font-size:11px;color:var(--mut)}
</style></head><body>
<header><span class="dot"></span><h1>tinyprobe 控制台</h1><span class="meta" id="meta">连接中…</span></header>
<div class="tabs"><div class="tab active" data-v="hosts">主机</div><div class="tab" data-v="update">远程更新</div></div>
<div class="view active" id="v-hosts"><div class="wrap" id="wrap"></div></div>
<div class="view" id="v-update">
 <div class="panel">
  <h3 style="margin-top:0">更新配置</h3>
  <div class="hint">目标版本 + 下载地址模板（<code>{arch}</code> / <code>{ver}</code> 会被替换）+ SHA256SUMS 模板。开启后，版本不符的探针在下次上报时自动收到更新指令。</div>
  <div class="field" style="margin-top:14px"><label>目标版本 version</label><input type="text" id="c-version" placeholder="v1.1.0"></div>
  <div class="field"><label>下载地址模板 urlTemplate</label><input type="text" id="c-url" placeholder="https://raw.githubusercontent.com/OWNER/REPO/main/dist/probe-linux-{arch}"></div>
  <div class="field"><label>SHA256SUMS 地址模板 sumsTemplate</label><input type="text" id="c-sums" placeholder="https://raw.githubusercontent.com/OWNER/REPO/main/dist/SHA256SUMS"></div>
  <div class="field"><label>管理令牌 admin-token</label><input type="password" id="c-admin" placeholder="留空则用浏览器会话已有的值"></div>
  <div class="row">
   <label class="tag"><input type="checkbox" id="c-armed"> 启用下发更新 (armed)</label>
   <button class="btn" id="btn-save">保存配置</button>
   <button class="btn ghost" id="btn-refresh">刷新 SHA256 清单</button>
  </div>
  <div id="cfg-msg" class="hint" style="margin-top:10px"></div>
 </div>
 <div class="panel" style="margin-top:14px">
  <h3 style="margin-top:0">主机版本 / 强制更新</h3>
  <table><thead><tr><th>主机</th><th>架构</th><th>当前版本</th><th>操作</th></tr></thead><tbody id="up-body"></tbody></table>
 </div>
</div>
<div class="toast" id="toast"></div>
<script>
const H=(v)=>String(v==null?'':v).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
function toast(m){const t=document.getElementById('toast');t.textContent=m;t.style.display='block';setTimeout(()=>t.style.display='none',2500)}
function bar(v){const c=v>=85?'crit':v>=65?'warn':'';return '<div class="bar '+c+'"><i style="width:'+Math.max(0,Math.min(100,v||0))+'%"></i></div>'}
function human(b){if(b==null)return '-';const u=['B','K','M','G','T'];let i=0;while(b>=1024&&i<u.length-1){b/=1024;i++}return b.toFixed(i?1:0)+u[i]}
function spark(h){if(!h||!h.length)return '';const w=100,hh=46,n=h.length;const mk=k=>h.map((p,i)=>(i/(n-1||1)*w).toFixed(1)+','+(hh-(p[k]||0)/100*hh).toFixed(1)).join(' ');return '<svg viewBox="0 0 '+w+' '+hh+'" preserveAspectRatio="none"><polyline class="cpu" points="'+mk('cpu')+'"/><polyline class="mem" points="'+mk('m')+'"/></svg>'}
let adminToken=sessionStorage.getItem('tp-admin')||'';
function cfgHeaders(){return adminToken?{'X-Admin-Token':adminToken}:{}}
async function load(){
 try{
  const s=await(await fetch('/api/data',{cache:'no-store'})).json();
  document.getElementById('meta').textContent='主机 '+s.hosts.length+' · 目标版本 '+(s.update.version||'未设置')+' · '+new Date(s.now).toLocaleTimeString();
  const w=document.getElementById('wrap');
  if(!s.hosts.length){w.innerHTML='<div class="empty">等待探针上报… 服务器执行：<code>curl -fsSL 安装URL | bash</code></div>'}
  else w.innerHTML=s.hosts.map(h=>{
   const l=h.online?'<span class="badge">在线</span>':'<span class="badge off">离线</span>';
   const vu=(s.update.version&&h.version&&h.version!==s.update.version)?'<span class="badge old">'+H(h.version)+'</span>':'<span class="badge ver">'+H(h.version||'?')+'</span>';
   const m=h.mem||{},d=h.disk||{},n=h.net||{};
   return '<div class="card '+(h.online?'':'off')+'"><div class="top"><span class="nm">'+H(h.name)+'</span>'+l+vu+'<span class="sub">'+H(h.arch||'')+' · '+H(h.cpus||'')+' 核</span></div>'
    +'<div class="grid"><div><div class="k">CPU</div><div class="v">'+h.cpu+'%</div>'+bar(h.cpu)+'</div>'
    +'<div><div class="k">内存</div><div class="v">'+m.percent+'% · '+human(m.used)+'/'+human(m.total)+'</div>'+bar(m.percent)+'</div>'
    +'<div><div class="k">磁盘 '+H(d.path||'')+'</div><div class="v">'+d.percent+'% · '+human(d.used)+'/'+human(d.total)+'</div>'+bar(d.percent)+'</div>'
    +'<div><div class="k">网络</div><div class="v">↓'+human(n.rx)+'/s ↑'+human(n.tx)+'/s</div><div class="k">运行 '+Math.floor((h.uptime||0)/86400)+'天'+Math.floor((h.uptime||0)%86400/3600)+'时</div></div></div>'+spark(h.history)+'</div>'
  }).join('');
  document.getElementById('up-body').innerHTML=s.hosts.map(h=>'<tr><td>'+H(h.name)+'</td><td>'+H(h.arch)+'</td><td>'+H(h.version||'?')+'</td><td><button class="btn ghost" onclick="forceUpdate(\''+encodeURIComponent(h.name)+'\')">强制更新</button></td></tr>').join('');
 }catch(e){document.getElementById('meta').textContent='连接失败: '+e.message}
}
async function forceUpdate(name){try{const r=await fetch('/api/update/force',{method:'POST',headers:Object.assign({'Content-Type':'application/json'},cfgHeaders()),body:JSON.stringify({name:decodeURIComponent(name)})});const j=await r.json();toast(j.ok?'已排队: '+decodeURIComponent(name):(j.error||'失败'))}catch(e){toast('失败: '+e.message)}}
document.querySelectorAll('.tab').forEach(t=>t.onclick=()=>{document.querySelectorAll('.tab').forEach(x=>x.classList.toggle('active',x===t));document.querySelectorAll('.view').forEach(v=>v.classList.toggle('active',v.id==='v-'+t.dataset.v));if(t.dataset.v==='update')loadCfg()});
async function loadCfg(){try{const r=await fetch('/api/update/config',{headers:cfgHeaders()});if(!r.ok){document.getElementById('cfg-msg').textContent='需要管理令牌';return}const c=await r.json();document.getElementById('c-version').value=c.version||'';document.getElementById('c-url').value=c.urlTemplate||'';document.getElementById('c-sums').value=c.sumsTemplate||'';document.getElementById('c-armed').checked=!!c.armed}catch(e){document.getElementById('cfg-msg').textContent=e.message}}
document.getElementById('btn-save').onclick=async()=>{
 const t=document.getElementById('c-admin').value.trim();if(t){adminToken=t;sessionStorage.setItem('tp-admin',t)}
 const cfg={version:document.getElementById('c-version').value.trim(),urlTemplate:document.getElementById('c-url').value.trim(),sumsTemplate:document.getElementById('c-sums').value.trim(),armed:document.getElementById('c-armed').checked};
 try{const r=await fetch('/api/update/config',{method:'POST',headers:Object.assign({'Content-Type':'application/json'},cfgHeaders()),body:JSON.stringify(cfg)});const j=await r.json();toast(j.ok?'已保存':'失败');document.getElementById('cfg-msg').textContent=j.ok?('目标 '+cfg.version+', armed='+cfg.armed):(j.error||'')}catch(e){toast('失败: '+e.message)}
};
document.getElementById('btn-refresh').onclick=async()=>{try{const r=await fetch('/api/update/refresh-sums',{method:'POST',headers:cfgHeaders()});const j=await r.json();toast(j.ok?('SHA256 已刷新 ('+Object.keys(j.sums||{}).length+' 项)'):(j.error||'失败'))}catch(e){toast('失败: '+e.message)}};
load();setInterval(load,2000);
</script></body></html>`;

const server = http.createServer((req, res) => {
  let u;
  try { u = new URL(req.url, 'http://x'); } catch (_) { res.writeHead(400); return res.end('bad url'); }
  if (req.method === 'POST' && u.pathname === '/report') return handleReport(req, res);
  if (u.pathname.startsWith('/api/')) return handleApi(req, res, u);
  if (u.pathname === '/' || u.pathname === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(HTML);
  }
  res.writeHead(404); res.end('not found');
});

server.listen(PORT, () => {
  console.log(`tinyprobe hub on http://0.0.0.0:${PORT}`);
  console.log(`console:  http://127.0.0.1:${PORT}`);
  console.log(`state:    ${STATE_FILE}`);
  console.log(`admin:    ${ADMIN_TOKEN ? 'token set' : 'no token'}`);
});
