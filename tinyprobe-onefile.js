#!/usr/bin/env node
'use strict';
// tinyprobe one-file build: node tinyprobe-onefile.js hub [--port 47821]
//                          node tinyprobe-onefile.js probe [--hub URL] [--name NAME]
// Both roles in one file. Zero dependencies, Node.js built-ins only.

const role = process.argv[2];
if (role === 'hub') requireHub();
else if (role === 'probe') requireProbe();
else {
  console.error('Usage: node tinyprobe-onefile.js hub [--port 47821] [--token S]\n' +
                '       node tinyprobe-onefile.js probe [--hub URL] [--name N] [--interval 1] [--token S]');
  process.exit(1);
}

function arg(key, def) {
  const a = process.argv.slice(3);
  const i = a.indexOf('--' + key);
  return i >= 0 && a[i + 1] ? a[i + 1] : def;
}

/* ------------------------------- PROBE ------------------------------- */
function requireProbe() {
  const http = require('http');
  const os = require('os');
  const fs = require('fs');
  const path = require('path');

  const HUB = arg('hub', 'http://127.0.0.1:47821');
  const NAME = arg('name', os.hostname());
  const INTERVAL = Math.max(1, parseInt(arg('interval', '1'), 10) || 1);
  const TOKEN = arg('token', '');
  const DISK_PATH = arg('disk', process.platform === 'win32' ? process.cwd().split(path.sep)[0] + path.sep : '/');

  let prevCpu = cpuSample(), prevNet = netSample(), prevAt = Date.now();
  function cpuSample() {
    let idle = 0, total = 0;
    for (const c of os.cpus()) {
      const t = c.times;
      idle += t.idle; total += t.idle + t.user + t.nice + t.sys + t.irq;
    }
    return { idle, total };
  }
  function cpuPercent() {
    const cur = cpuSample(), dt = cur.total - prevCpu.total, di = cur.idle - prevCpu.idle;
    prevCpu = cur;
    return dt <= 0 ? 0 : Math.max(0, Math.min(100, (1 - di / dt) * 100));
  }
  function netSample() {
    if (process.platform !== 'linux') return null;
    try {
      let rx = 0, tx = 0;
      for (const line of fs.readFileSync('/proc/net/dev', 'utf8').split('\n').slice(2)) {
        const p = line.trim().split(/\s+/);
        if (p.length < 17 || p[0].replace(':', '') === 'lo') continue;
        rx += parseInt(p[1], 10) || 0; tx += parseInt(p[9], 10) || 0;
      }
      return { rx, tx };
    } catch (_) { return null; }
  }
  function netRates() {
    const cur = netSample();
    if (!cur || !prevNet) { prevNet = cur; return { rx: 0, tx: 0 }; }
    const dt = (Date.now() - prevAt) / 1000;
    const rx = dt > 0 ? Math.max(0, (cur.rx - prevNet.rx) / dt) : 0;
    const tx = dt > 0 ? Math.max(0, (cur.tx - prevNet.tx) / dt) : 0;
    prevNet = cur;
    return { rx: Math.round(rx), tx: Math.round(tx) };
  }
  function diskInfo() {
    try {
      const s = fs.statfsSync(DISK_PATH);
      const total = s.blocks * s.bsize, avail = s.bavail * s.bsize, used = total - avail;
      return { path: DISK_PATH, total, used, percent: total > 0 ? +(used / total * 100).toFixed(1) : 0 };
    } catch (_) { return null; }
  }
  function collect() {
    const memTotal = os.totalmem(), memFree = os.freemem(), memUsed = memTotal - memFree;
    const net = netRates(); prevAt = Date.now();
    return {
      name: NAME, host: os.hostname(), platform: process.platform, arch: os.arch(),
      node: process.version, time: Date.now(), uptime: Math.round(os.uptime()),
      cpu: +cpuPercent().toFixed(1), cpus: os.cpus().length,
      load: os.loadavg().map(x => +x.toFixed(2)),
      mem: { total: memTotal, used: memUsed, percent: +(memUsed / memTotal * 100).toFixed(1) },
      disk: diskInfo(), net,
    };
  }
  function report() {
    const data = collect(), body = JSON.stringify(data);
    let url;
    try { url = new URL('/report', HUB); } catch (_) { console.error('bad hub url'); return; }
    const req = http.request({
      hostname: url.hostname, port: url.port || 80, path: '/report', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body),
                 ...(TOKEN ? { 'X-Token': TOKEN } : {}) },
    }, res => {
      res.resume();
      console.log(`[${new Date().toLocaleTimeString()}] ${data.name} CPU ${data.cpu}% MEM ${data.mem.percent}% -> ${res.statusCode}`);
    });
    req.on('error', e => console.error('report failed:', e.message));
    req.write(body); req.end();
  }
  console.log(`tinyprobe probe -> ${HUB} "${NAME}" every ${INTERVAL}s`);
  collect();
  setInterval(report, INTERVAL * 1000);
  report();
}

/* -------------------------------- HUB -------------------------------- */
function requireHub() {
  const http = require('http');
  const PORT = parseInt(arg('port', '47821'), 10) || 47821;
  const TOKEN = arg('token', '');
  const KEEP = Math.max(10, parseInt(arg('keep', '180'), 10) || 180);
  const hosts = new Map();

  function readBody(req, cb) {
    const chunks = []; let size = 0;
    req.on('data', c => { size += c.length; if (size > 1e6) { req.destroy(); return; } chunks.push(c); });
    req.on('end', () => cb(Buffer.concat(chunks).toString('utf8')));
  }
  function handleReport(req, res) {
    if (TOKEN && req.headers['x-token'] !== TOKEN) { res.writeHead(403); return res.end('forbidden'); }
    readBody(req, body => {
      let d; try { d = JSON.parse(body); } catch (_) { res.writeHead(400); return res.end('bad json'); }
      if (!d || !d.name) { res.writeHead(400); return res.end('missing name'); }
      d.time = Date.now();
      let h = hosts.get(d.name);
      if (!h) { h = { latest: null, history: [] }; hosts.set(d.name, h); }
      h.latest = d; h.history.push(d);
      if (h.history.length > KEEP) h.history.splice(0, h.history.length - KEEP);
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}');
    });
  }
  function snapshot() {
    const now = Date.now(), list = [];
    for (const [name, h] of hosts) {
      if (!h.latest) continue;
      const l = h.latest;
      list.push({ name, online: now - l.time < 15000, time: l.time, cpu: l.cpu, mem: l.mem,
        disk: l.disk, net: l.net, platform: l.platform, arch: l.arch, cpus: l.cpus,
        load: l.load, uptime: l.uptime,
        history: h.history.map(x => ({ t: x.time, cpu: x.cpu, m: x.mem && x.mem.percent })) });
    }
    list.sort((a, b) => a.name.localeCompare(b.name));
    return { now, hosts: list };
  }
  const HTML = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>tinyprobe</title><style>
:root{--bg:#0d1117;--card:#161b22;--bd:#30363d;--fg:#e6edf3;--mut:#8b949e;--ok:#3fb950;--bad:#f85149;--acc:#58a6ff}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 -apple-system,"Segoe UI",Arial,sans-serif}
header{padding:14px 20px;border-bottom:1px solid var(--bd);display:flex;align-items:center;gap:12px}
header h1{font-size:16px;margin:0}.dot{width:8px;height:8px;border-radius:50%;background:var(--ok);box-shadow:0 0 8px var(--ok)}
.meta{margin-left:auto;color:var(--mut);font-size:12px}.wrap{padding:16px;display:grid;grid-template-columns:repeat(auto-fill,minmax(420px,1fr));gap:14px}
.card{background:var(--card);border:1px solid var(--bd);border-radius:8px;padding:14px}.card.off{opacity:.6}
.top{display:flex;align-items:center;gap:8px;margin-bottom:10px}.nm{font-weight:600;font-size:15px}
.badge{font-size:11px;padding:1px 7px;border-radius:10px;background:#1f6feb22;color:var(--acc);border:1px solid var(--acc)}
.badge.off{background:#f8514922;color:var(--bad);border-color:var(--bad)}.sub{color:var(--mut);font-size:11px;margin-left:auto}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:8px 14px}.k{color:var(--mut);font-size:12px}.v{font-variant-numeric:tabular-nums}
.bar{height:6px;border-radius:4px;background:#21262d;overflow:hidden;margin-top:3px}.bar>i{display:block;height:100%;background:var(--ok);border-radius:4px}
.bar.warn>i{background:#d29922}.bar.crit>i{background:var(--bad)}svg{width:100%;height:46px;display:block;margin-top:10px}
polyline{fill:none;stroke-width:1.5}.cpu{stroke:var(--acc)}.mem{stroke:#d29922}.empty{color:var(--mut);padding:40px;text-align:center;grid-column:1/-1}
</style></head><body><header><span class="dot"></span><h1>tinyprobe</h1><span class="meta" id="meta">连接中…</span></header><div class="wrap" id="wrap"></div>
<script>
const H=(v)=>String(v).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
function bar(v){const c=v>=85?'crit':v>=65?'warn':'';return '<div class="bar '+c+'"><i style="width:'+Math.max(0,Math.min(100,v||0))+'%"></i></div>'}
function human(b){if(b==null)return '-';const u=['B','K','M','G','T'];let i=0;while(b>=1024&&i<u.length-1){b/=1024;i++}return b.toFixed(i?1:0)+u[i]}
function spark(h){if(!h||!h.length)return '';const w=100,hh=46,n=h.length;const mk=k=>h.map((p,i)=>(i/(n-1||1)*w).toFixed(1)+','+(hh-(p[k]||0)/100*hh).toFixed(1)).join(' ');return '<svg viewBox="0 0 '+w+' '+hh+'" preserveAspectRatio="none"><polyline class="cpu" points="'+mk('cpu')+'"/><polyline class="mem" points="'+mk('m')+'"/></svg>'}
async function load(){try{const s=await(await fetch('/api/data',{cache:'no-store'})).json();document.getElementById('meta').textContent='主机 '+s.hosts.length+' · 更新 '+new Date(s.now).toLocaleTimeString();const w=document.getElementById('wrap');if(!s.hosts.length){w.innerHTML='<div class="empty">等待探针上报… 启动：<code>node tinyprobe-onefile.js probe</code></div>';return}w.innerHTML=s.hosts.map(h=>{const l=h.online?'<span class="badge">在线</span>':'<span class="badge off">离线</span>';const m=h.mem||{},d=h.disk||{},n=h.net||{};return '<div class="card '+(h.online?'':'off')+'"><div class="top"><span class="nm">'+H(h.name)+'</span>'+l+'<span class="sub">'+H(h.platform||'')+' '+H(h.arch||'')+' · '+H(h.cpus||'')+' 核</span></div><div class="grid"><div><div class="k">CPU</div><div class="v">'+h.cpu+'%</div>'+bar(h.cpu)+'</div><div><div class="k">内存</div><div class="v">'+m.percent+'% · '+human(m.used)+'/'+human(m.total)+'</div>'+bar(m.percent)+'</div><div><div class="k">磁盘 '+H(d.path||'')+'</div><div class="v">'+d.percent+'% · '+human(d.used)+'/'+human(d.total)+'</div>'+bar(d.percent)+'</div><div><div class="k">网络</div><div class="v">↓'+human(n.rx)+'/s ↑'+human(n.tx)+'/s</div></div></div>'+spark(h.history)+'</div>'}).join('')}catch(e){document.getElementById('meta').textContent='连接失败: '+e.message}}
load();setInterval(load,2000);
</script></body></html>`;
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (req.method === 'POST' && u.pathname === '/report') return handleReport(req, res);
    if (u.pathname === '/api/data') { res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }); return res.end(JSON.stringify(snapshot())); }
    if (u.pathname === '/' || u.pathname === '/index.html') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(HTML); }
    res.writeHead(404); res.end('not found');
  });
  server.listen(PORT, () => console.log(`tinyprobe hub on http://0.0.0.0:${PORT}`));
}
