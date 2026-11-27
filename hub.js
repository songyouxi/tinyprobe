#!/usr/bin/env node
'use strict';
// tinyprobe hub + management console — zero dependencies.
// Usage: node hub.js [--port 47821] [--token SECRET] [--keep 180] [--state hub-state.json]
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

const PORT = parseInt(arg('port', '47821'), 10) || 47821;
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
let lastStateWrite = 0;
const STATE_MIN_INTERVAL = 5000; // throttle: heavy report traffic must not thrash the disk

// Persist only what's needed to restore after a restart: the config and each
// host's latest snapshot (NOT the full 180-point history). This keeps the file
// small and the write cheap regardless of host count.
function saveState(immediate) {
  const now = Date.now();
  if (!immediate && now - lastStateWrite < STATE_MIN_INTERVAL) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      const obj = { update, hosts: {} };
      for (const [k, v] of hosts) obj.hosts[k] = { latest: v.latest };
      fs.writeFileSync(STATE_FILE, JSON.stringify(obj));
      lastStateWrite = Date.now();
    } catch (e) { console.error('save state:', e.message); }
  }, immediate ? 0 : STATE_MIN_INTERVAL);
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

  // Auto-generate the agent install command from the ACTUAL request host/port.
  // So whatever address the operator used to reach the console is exactly what
  // gets baked into the agent — no manual IP/port/token stitching.
  if (u.pathname === '/api/bootstrap') {
    const name = (u.searchParams.get('name') || '').trim() || 'my-server';
    const os = (u.searchParams.get('os') || 'linux').toLowerCase() === 'windows' ? 'windows' : 'linux';
    const hostHdr = req.headers['host'] || ('127.0.0.1:' + PORT);
    // Derive the hub base URL from the Host header the browser actually used.
    const fwdProto = req.headers['x-forwarded-proto'];
    const proto = fwdProto ? fwdProto.split(',')[0] : 'http';
    const hubBase = proto + '://' + hostHdr;
    const repo = (update.repoBase || 'https://github.com/songyouxi/tinyprobe/releases/download').replace(/\/$/, '');
    const ver = (update.version || 'v1.2.0');
    const token = TOKEN || '';
    const rawBase = repo.replace(/\/releases\/download.*$/, '') + '/raw/main';
    let command, installUrl;
    if (os === 'windows') {
      // PowerShell one-liner: set env vars then irm|iex.
      installUrl = rawBase + '/install.ps1';
      const setEnv = [
        '$env:HUB=' + JSON.stringify(hubBase),
        '$env:NAME=' + JSON.stringify(name),
        token ? '$env:TOKEN=' + JSON.stringify(token) : '',
        '$env:VERSION=' + JSON.stringify(ver),
        '$env:REPO=' + JSON.stringify(repo),
      ].filter(Boolean).join('; ');
      command = setEnv + '; irm ' + installUrl + ' | iex';
    } else {
      installUrl = rawBase + '/install.sh';
      const env = [
        'HUB=' + hubBase,
        'NAME=' + name,
        token ? 'TOKEN=' + token : '',
        'VERSION=' + ver,
        'REPO=' + repo,
      ].filter(Boolean).join(' ');
      command = 'curl -fsSL ' + installUrl + ' | ' + env + ' bash';
    }
    return json(res, 200, {
      command, hubBase, name, os, version: ver, repo,
      token, hasToken: !!token, installUrl,
    });
  }

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
      saveState(true);
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
<div class="tabs"><div class="tab active" data-v="hosts">主机</div><div class="tab" data-v="install">接入主机</div><div class="tab" data-v="update">远程更新</div></div>
<div class="view active" id="v-hosts"><div class="wrap" id="wrap"></div></div>
<div class="view" id="v-install">
 <div class="panel">
  <h3 style="margin-top:0">一键接入新主机</h3>
  <div class="hint">控制台已根据你当前访问的地址自动填好 <code>HUB</code> / <code>TOKEN</code> / <code>VERSION</code> / <code>REPO</code>。只需填节点名，复制命令到目标服务器执行即可自动互通。</div>
  <div class="field" style="margin-top:14px"><label>节点名 NAME（每台唯一）</label><input type="text" id="i-name" placeholder="web-01"></div>
   <div class="field"><label>目标系统</label><div class="row"><label class="tag"><input type="radio" name="i-os" value="linux" checked onchange="genInstall()"> Linux</label><label class="tag"><input type="radio" name="i-os" value="windows" onchange="genInstall()"> Windows</label></div></div>
  <div class="field"><label>生成的安装命令（已按本控制台地址拼好）</label>
   <div style="display:flex;gap:8px;align-items:flex-start">
    <textarea id="i-cmd" readonly style="flex:1;min-height:96px;background:#0d1117;border:1px solid var(--bd);border-radius:6px;color:var(--cyan);padding:10px;font:12px/1.6 monospace;resize:vertical"></textarea>
   </div>
  </div>
  <div class="row">
   <button class="btn" id="btn-copy">复制命令</button>
   <button class="btn ghost" id="btn-gen">重新生成</button>
  </div>
  <div id="i-info" class="hint" style="margin-top:12px"></div>
  <div class="hint" style="margin-top:10px">
   <b>前提条件：</b>GitHub Release <code>v1.2.0</code> 已发布（含 12 个架构二进制 + SHA256SUMS）。若还没发，先按 README 建 Release，否则脚本会下载 404。
  </div>
 </div>
</div>
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
document.querySelectorAll('.tab').forEach(t=>t.onclick=()=>{document.querySelectorAll('.tab').forEach(x=>x.classList.toggle('active',x===t));document.querySelectorAll('.view').forEach(v=>v.classList.toggle('active',v.id==='v-'+t.dataset.v));if(t.dataset.v==='update')loadCfg();if(t.dataset.v==='install')genInstall()});
async function genInstall(){
 const name=document.getElementById('i-name').value.trim()||'my-server';
  const osEl=document.querySelector('input[name="i-os"]:checked');
  const os=osEl?osEl.value:'linux';
 try{
  const r=await fetch('/api/bootstrap?name='+encodeURIComponent(name)+'&os='+os);
  const j=await r.json();
  document.getElementById('i-cmd').value=j.command||'';
  document.getElementById('i-info').innerHTML='目标系统 <b>'+H(os)+'</b> · 控制端 <b>'+H(j.hubBase)+'</b> · 版本 <b>'+H(j.version)+'</b> · 令牌 <b>'+(j.hasToken?'已自动填入':'未启用')+'</b><br>命令里的 <code>HUB</code> 就是你访问本控制台的地址，无需再手改。';
 }catch(e){document.getElementById('i-info').textContent='生成失败: '+e.message}
}
document.getElementById('btn-gen').onclick=genInstall;
document.getElementById('i-name').addEventListener('input',()=>{clearTimeout(window._gi);window._gi=setTimeout(genInstall,300)});
document.getElementById('btn-copy').onclick=async()=>{
 const txt=document.getElementById('i-cmd').value;if(!txt){toast('请先生成命令');return}
 try{await navigator.clipboard.writeText(txt);toast('命令已复制')}catch(e){
  const ta=document.getElementById('i-cmd');ta.select();document.execCommand('copy');toast('命令已复制');
 }
};
async function loadCfg(){try{const r=await fetch('/api/update/config',{headers:cfgHeaders()});if(!r.ok){document.getElementById('cfg-msg').textContent='需要管理令牌';return}const c=await r.json();document.getElementById('c-version').value=c.version||'';document.getElementById('c-url').value=c.urlTemplate||'';document.getElementById('c-sums').value=c.sumsTemplate||'';document.getElementById('c-armed').checked=!!c.armed}catch(e){document.getElementById('cfg-msg').textContent=e.message}}
document.getElementById('btn-save').onclick=async()=>{
 const t=document.getElementById('c-admin').value.trim();if(t){adminToken=t;sessionStorage.setItem('tp-admin',t)}
 const cfg={version:document.getElementById('c-version').value.trim(),urlTemplate:document.getElementById('c-url').value.trim(),sumsTemplate:document.getElementById('c-sums').value.trim(),armed:document.getElementById('c-armed').checked};
 try{const r=await fetch('/api/update/config',{method:'POST',headers:Object.assign({'Content-Type':'application/json'},cfgHeaders()),body:JSON.stringify(cfg)});const j=await r.json();toast(j.ok?'已保存':'失败');document.getElementById('cfg-msg').textContent=j.ok?('目标 '+cfg.version+', armed='+cfg.armed):(j.error||'')}catch(e){toast('失败: '+e.message)}
};
document.getElementById('btn-refresh').onclick=async()=>{try{const r=await fetch('/api/update/refresh-sums',{method:'POST',headers:cfgHeaders()});const j=await r.json();toast(j.ok?('SHA256 已刷新 ('+Object.keys(j.sums||{}).length+' 项)'):(j.error||'失败'))}catch(e){toast('失败: '+e.message)}};
(function(){const h=(location.hash||'').replace('#','');if(h==='install'||h==='update'){const t=Array.from(document.querySelectorAll('.tab')).find(x=>x.dataset.v===h);if(t)t.click()}})();
load();setInterval(load,2000);
</script></body></html>`;

// ------------------------------- BIG SCREEN -------------------------------
const SCREEN_HTML = String.raw`<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>tinyprobe · 中控大屏</title><style>
:root{--bg:#050b17;--panel:rgba(16,32,58,.72);--bd:#1d3a63;--fg:#e8f4ff;--mut:#6f8bb3;--cyan:#00e5ff;--blue:#2f8fff;--grn:#00e59a;--org:#ffb020;--red:#ff4d5e}
*{box-sizing:border-box;margin:0;padding:0}
body{background:radial-gradient(ellipse at 50% -20%,#0d2749 0%,#050b17 60%);color:var(--fg);font-family:"Segoe UI",Arial,sans-serif;height:100vh;overflow:hidden;display:flex;flex-direction:column}
body::before{content:"";position:absolute;inset:0;background-image:linear-gradient(rgba(47,143,255,.04) 1px,transparent 1px),linear-gradient(90deg,rgba(47,143,255,.04) 1px,transparent 1px);background-size:40px 40px;pointer-events:none}
.head{flex:0 0 66px;display:flex;align-items:center;justify-content:center;position:relative;border-bottom:1px solid var(--bd)}
.head h1{font-size:26px;letter-spacing:5px;font-weight:700;text-shadow:0 0 18px rgba(0,229,255,.6)}
.head .en{position:absolute;top:44px;font-size:10px;letter-spacing:4px;color:var(--mut)}
.head .clock{position:absolute;right:24px;text-align:right;font-size:20px;font-variant-numeric:tabular-nums;color:var(--cyan)}
.head .clock small{display:block;font-size:11px;color:var(--mut);letter-spacing:1px}
.head .link{position:absolute;left:24px;font-size:12px;color:var(--mut)}.head .link a{color:var(--cyan);text-decoration:none}
.grid{flex:1;display:grid;grid-template-columns:300px 1fr 300px;grid-template-rows:1fr 240px;gap:12px;padding:14px 16px;min-height:0}
.panel{background:var(--panel);border:1px solid var(--bd);border-radius:6px;position:relative;padding:12px 14px;overflow:hidden;backdrop-filter:blur(4px)}
.panel::before,.panel::after{content:"";position:absolute;width:14px;height:14px;border-color:var(--cyan);border-style:solid}.panel::before{left:-1px;top:-1px;border-width:2px 0 0 2px}.panel::after{right:-1px;bottom:-1px;border-width:0 2px 2px 0}
.ttl{font-size:13px;color:var(--cyan);letter-spacing:2px;margin-bottom:10px;padding-left:10px;border-left:3px solid var(--cyan)}
.ttl small{float:right;color:var(--mut);font-size:10px;letter-spacing:0}
/* KPI */
.kpis{grid-column:2;grid-row:1;display:grid;grid-template-columns:repeat(4,1fr);grid-template-rows:110px 1fr;gap:12px;min-height:0}
.kpi{display:flex;flex-direction:column;align-items:center;justify-content:center;background:var(--panel);border:1px solid var(--bd);border-radius:6px;position:relative}
.kpi .num{font-size:46px;font-weight:700;font-variant-numeric:tabular-nums;line-height:1;text-shadow:0 0 16px currentColor}
.kpi .lbl{font-size:12px;color:var(--mut);margin-top:8px;letter-spacing:1px}
.kpi .unit{font-size:16px;color:var(--mut);margin-left:2px}
.chart{grid-column:2;grid-row:2;display:grid;grid-template-columns:1fr 1fr;gap:12px;min-height:0}
.chart .panel{display:flex;flex-direction:column}
.chart svg{width:100%;height:100%;flex:1}
/* left / right */
.left{grid-column:1;grid-row:1/3;display:flex;flex-direction:column;gap:12px;min-height:0}
.right{grid-column:3;grid-row:1/3;display:flex;flex-direction:column;gap:12px;min-height:0}
.donut-wrap{display:flex;align-items:center;gap:10px;flex:1}
.donut{width:120px;height:120px;flex:0 0 120px}
.legend{flex:1;font-size:12px}.legend div{display:flex;justify-content:space-between;padding:3px 0;color:var(--mut)}
.legend b{color:var(--fg);font-variant-numeric:tabular-nums}
.dot{display:inline-block;width:8px;height:8px;border-radius:2px;margin-right:6px}
.bars{flex:1;display:flex;flex-direction:column;justify-content:space-around}
.brow{font-size:11px}.brow .t{display:flex;justify-content:space-between;color:var(--mut);margin-bottom:3px}
.btrack{height:8px;background:#0c1e33;border-radius:4px;overflow:hidden}.bfill{height:100%;border-radius:4px;transition:width .6s}
.alerts{flex:1;overflow:hidden;font-size:12px}.alert{padding:7px 8px;margin-bottom:6px;border-left:3px solid var(--org);background:rgba(255,176,32,.08);border-radius:3px;color:#ffd98a}
.alert.crit{border-color:var(--red);background:rgba(255,77,94,.1);color:#ffb3ba}
.alert .tm{color:var(--mut);font-size:10px;margin-right:6px}
.ok-empty{color:var(--grn);font-size:12px;text-align:center;padding:20px 0}
.rank{flex:1;overflow:hidden;font-size:12px}.rk{display:flex;align-items:center;gap:8px;padding:5px 0;border-bottom:1px solid rgba(29,58,99,.5)}
.rk .n{width:18px;color:var(--mut);text-align:center}.rk .nm{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rk .mini{width:70px;height:6px;background:#0c1e33;border-radius:3px;overflow:hidden}.rk .mini i{display:block;height:100%}.rk .v{width:40px;text-align:right;font-variant-numeric:tabular-nums;color:var(--cyan)}
.matrix{grid-column:2;grid-row:1;display:none}
.archbar{display:flex;flex-wrap:wrap;gap:6px}.ach{font-size:11px;padding:3px 9px;border:1px solid var(--bd);border-radius:12px;color:var(--mut)}.ach b{color:var(--cyan);margin-left:4px}
</style></head><body>
<div class="head">
 <div class="link">控制台 <a href="/">/ 返回</a> · <a href="/#install">/ 接入命令</a></div>
 <h1>TINYPROBE 服务器监控中心</h1><div class="en">GLOBAL INFRASTRUCTURE MONITORING CENTER</div>
 <div class="clock"><span id="clock">--:--:--</span><small id="date">----</small></div>
</div>
<div class="grid">
 <!-- LEFT -->
 <div class="left">
  <div class="panel" style="flex:0 0 190px"><div class="ttl">在线状态 <small id="onlint">ONLINE / TOTAL</small></div><div class="donut-wrap"><svg class="donut" viewBox="0 0 42 42"><circle cx="21" cy="21" r="15.9" fill="none" stroke="#0c1e33" stroke-width="4"></circle><circle id="donutArc" cx="21" cy="21" r="15.9" fill="none" stroke="#00e59a" stroke-width="4" stroke-dasharray="0 100" stroke-linecap="round" transform="rotate(-90 21 21)"></circle></svg><div class="legend" id="onlLegend"></div></div></div>
  <div class="panel" style="flex:0 0 200px"><div class="ttl">集群资源 <small>CLUSTER LOAD</small></div><div class="bars" id="resBars"></div></div>
  <div class="panel" style="flex:1"><div class="ttl">架构分布 <small>ARCH</small></div><div class="archbar" id="archBar"></div></div>
 </div>
 <!-- CENTER -->
 <div class="kpis">
  <div class="kpi" style="color:var(--cyan)"><div class="num" id="kHosts">0</div><div class="lbl">主机总数 HOSTS</div></div>
  <div class="kpi" style="color:var(--grn)"><div class="num" id="kOnline">0</div><div class="lbl">在线节点 ONLINE</div></div>
  <div class="kpi" style="color:var(--org)"><div class="num" id="kCpu">0<span class="unit">%</span></div><div class="lbl">平均 CPU</div></div>
  <div class="kpi" style="color:var(--blue)"><div class="num" id="kMem">0<span class="unit">%</span></div><div class="lbl">平均内存</div></div>
  <div class="chart" style="grid-column:1/5;grid-row:2">
   <div class="panel"><div class="ttl">CPU 使用趋势 <small>ALL NODES AVG</small></div><svg id="cpuChart" viewBox="0 0 100 40" preserveAspectRatio="none"></svg></div>
   <div class="panel"><div class="ttl">内存使用趋势 <small>ALL NODES AVG</small></div><svg id="memChart" viewBox="0 0 100 40" preserveAspectRatio="none"></svg></div>
  </div>
 </div>
 <!-- RIGHT -->
 <div class="right">
  <div class="panel" style="flex:0 0 230px"><div class="ttl">实时告警 <small id="alertCount">0</small></div><div class="alerts" id="alerts"></div></div>
  <div class="panel" style="flex:1"><div class="ttl">CPU 负载 TOP <small>TOP NODES</small></div><div class="rank" id="rank"></div></div>
 </div>
</div>
<script>
const H=v=>String(v==null?'':v).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const human=b=>{if(b==null)return '-';const u=['B','K','M','G','T'];let i=0;while(b>=1024&&i<u.length-1){b/=1024;i++}return b.toFixed(i?1:0)+u[i]};
const cls=v=>v>=85?'#ff4d5e':v>=65?'#ffb020':'#00e59a';
function tickClock(){const d=new Date();document.getElementById('clock').textContent=d.toLocaleTimeString('zh-CN',{hour12:false});document.getElementById('date').textContent=d.toLocaleDateString('zh-CN',{year:'numeric',month:'2-digit',day:'2-digit',weekday:'long'})}
setInterval(tickClock,1000);tickClock();
function line(svgId,vals,color){const el=document.getElementById(svgId);if(!vals.length){el.innerHTML='';return}const n=vals.length,w=100,h=40;const pts=vals.map((v,i)=>(i/(n-1||1)*w).toFixed(2)+','+(h-Math.min(100,v)/100*h).toFixed(2)).join(' ');const area='0,'+h+' '+pts+' '+w+','+h;el.innerHTML='<defs><linearGradient id="g'+svgId+'" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="'+color+'" stop-opacity=".35"/><stop offset="1" stop-color="'+color+'" stop-opacity="0"/></linearGradient></defs><polygon points="'+area+'" fill="url(#g'+svgId+')"/><polyline points="'+pts+'" fill="none" stroke="'+color+'" stroke-width="1"/>';}
function load(){
 try{fetch('/api/data',{cache:'no-store'}).then(r=>r.json()).then(s=>render(s)).catch(e=>{}) }catch(e){}
}
let cpuTrend=[],memTrend=[];
function render(s){
 const hs=s.hosts||[],total=hs.length,onl=hs.filter(h=>h.online).length;
 document.getElementById('kHosts').textContent=total;
 document.getElementById('kOnline').textContent=onl;
 const avg=(key)=>total?hs.reduce((a,h)=>a+(Number(h[key])||0),0)/total:0;
 const ac=avg('cpu'),am=hs.length?hs.reduce((a,h)=>a+(h.mem?.percent||0),0)/hs.length:0;
 document.getElementById('kCpu').innerHTML=ac.toFixed(1)+'<span class="unit">%</span>';
 document.getElementById('kMem').innerHTML=am.toFixed(1)+'<span class="unit">%</span>';
 // donut
 const pct=total?onl/total*100:0;document.getElementById('donutArc').setAttribute('stroke-dasharray',pct.toFixed(1)+' '+(100-pct).toFixed(1));
 document.getElementById('onlint').textContent=onl+' / '+total;
 document.getElementById('onlLegend').innerHTML='<div><span><i class="dot" style="background:#00e59a"></i>在线</span><b>'+onl+'</b></div><div><span><i class="dot" style="background:#ff4d5e"></i>离线</span><b>'+(total-onl)+'</b></div><div><span><i class="dot" style="background:#2f8fff"></i>在线率</span><b>'+pct.toFixed(0)+'%</b></div>';
 // cluster resources bars
 const sum=(f)=>hs.reduce((a,h)=>a+(f(h)||0),0);
 const memP=hs.length?hs.reduce((a,h)=>a+(h.mem?.percent||0),0)/hs.length:0;
 const diskP=hs.length?hs.reduce((a,h)=>a+(h.disk?.percent||0),0)/hs.length:0;
 const netRx=hs.reduce((a,h)=>a+(h.net?.rx||0),0),netTx=hs.reduce((a,h)=>a+(h.net?.tx||0),0);
 document.getElementById('resBars').innerHTML=[['CPU 平均',ac,'#00e5ff',ac.toFixed(1)+'%'],['内存平均',memP,'#2f8fff',memP.toFixed(1)+'%'],['磁盘平均',diskP,'#ffb020',diskP.toFixed(1)+'%'],['网络下行',Math.min(100,netRx/1e7*100),'#00e59a',human(netRx)+'/s'],['网络上行',Math.min(100,netTx/1e7*100),'#8b7cff',human(netTx)+'/s']].map(x=>'<div class="brow"><div class="t"><span>'+x[0]+'</span><span>'+x[3]+'</span></div><div class="btrack"><div class="bfill" style="width:'+Math.min(100,Math.max(0,x[1]))+'%;background:'+x[2]+'"></div></div></div>').join('');
 // arch distribution
 const ac2={};hs.forEach(h=>{const a=h.arch||'?';ac2[a]=(ac2[a]||0)+1});
 document.getElementById('archBar').innerHTML=Object.entries(ac2).sort((a,b)=>b[1]-a[1]).map(([k,v])=>'<span class="ach">'+H(k)+'<b>'+v+'</b></span>').join('')||'<span class="ach">无数据</span>';
 // trends
 cpuTrend.push(ac);memTrend.push(am);if(cpuTrend.length>60)cpuTrend.shift();if(memTrend.length>60)memTrend.shift();
 line('cpuChart',cpuTrend,'#00e5ff');line('memChart',memTrend,'#2f8fff');
 // alerts
 const al=[];hs.forEach(h=>{const m=h.mem?.percent||0,d=h.disk?.percent||0;
  if(!h.online)al.push({c:1,t:h.name+' 节点离线'});
  if(m>=85)al.push({c:1,t:h.name+' 内存 '+m.toFixed(0)+'%'});
  else if(m>=70)al.push({c:0,t:h.name+' 内存偏高 '+m.toFixed(0)+'%'});
  if(d>=85)al.push({c:1,t:h.name+' 磁盘 '+d.toFixed(0)+'%'});
  else if(d>=70)al.push({c:0,t:h.name+' 磁盘偏高 '+d.toFixed(0)+'%'});
  if(h.cpu>=85)al.push({c:1,t:h.name+' CPU '+h.cpu+'%'});
 });
 document.getElementById('alertCount').textContent=al.length+' 条';
 document.getElementById('alerts').innerHTML=al.length?al.slice(0,8).map(a=>'<div class="alert '+(a.c?'crit':'')+'"><span class="tm">'+new Date().toLocaleTimeString('zh-CN',{hour12:false}).slice(0,5)+'</span>'+H(a.t)+'</div>').join(''):'<div class="ok-empty">✓ 一切正常，无告警</div>';
 // rank top cpu
 const top=[...hs].sort((a,b)=>(b.cpu||0)-(a.cpu||0)).slice(0,8);
 document.getElementById('rank').innerHTML=top.map((h,i)=>'<div class="rk"><span class="n">'+(i+1)+'</span><span class="nm">'+H(h.name)+'</span><span class="mini"><i style="width:'+(h.cpu||0)+'%;background:'+cls(h.cpu)+'"></i></span><span class="v">'+(h.cpu||0)+'%</span></div>').join('')||'<span class="ach">无数据</span>';
}
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
  if (u.pathname === '/screen') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(SCREEN_HTML);
  }
  res.writeHead(404); res.end('not found');
});

server.listen(PORT, () => {
  console.log(`tinyprobe hub on http://0.0.0.0:${PORT}`);
  console.log(`console:  http://127.0.0.1:${PORT}`);
  console.log(`screen:   http://127.0.0.1:${PORT}/screen`);
  console.log(`state:    ${STATE_FILE}`);
  console.log(`admin:    ${ADMIN_TOKEN ? 'token set' : 'no token'}`);
});
