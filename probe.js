#!/usr/bin/env node
'use strict';
// tinyprobe agent — zero dependencies, Node.js built-ins only.
// Usage: node probe.js [--hub http://127.0.0.1:8090] [--name my-server] [--interval 1] [--token SECRET]

const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');

function arg(key, def) {
  const i = process.argv.indexOf('--' + key);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const HUB = arg('hub', 'http://127.0.0.1:8090');
const NAME = arg('name', os.hostname());
const INTERVAL = Math.max(1, parseInt(arg('interval', '1'), 10) || 1);
const TOKEN = arg('token', '');
const DISK_PATH = arg('disk', process.platform === 'win32' ? process.cwd().split(path.sep)[0] + path.sep : '/');

let prevCpu = cpuSample();
let prevNet = netSample();
let prevAt = Date.now();

function cpuSample() {
  const cpus = os.cpus();
  let idle = 0, total = 0;
  for (const c of cpus) {
    const t = c.times;
    idle += t.idle;
    total += t.idle + t.user + t.nice + t.sys + t.irq;
  }
  return { idle, total };
}

function cpuPercent() {
  const cur = cpuSample();
  const dt = cur.total - prevCpu.total;
  const di = cur.idle - prevCpu.idle;
  prevCpu = cur;
  if (dt <= 0) return 0;
  return Math.max(0, Math.min(100, (1 - di / dt) * 100));
}

function netSample() {
  if (process.platform !== 'linux') return null;
  try {
    const lines = fs.readFileSync('/proc/net/dev', 'utf8').split('\n').slice(2);
    let rx = 0, tx = 0;
    for (const line of lines) {
      const p = line.trim().split(/\s+/);
      if (p.length < 17) continue;
      const iface = p[0].replace(':', '');
      if (iface === 'lo') continue;
      rx += parseInt(p[1], 10) || 0;
      tx += parseInt(p[9], 10) || 0;
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
    const total = s.blocks * s.bsize;
    const avail = s.bavail * s.bsize;
    const used = total - avail;
    return {
      path: DISK_PATH,
      total,
      used,
      percent: total > 0 ? +(used / total * 100).toFixed(1) : 0,
    };
  } catch (_) { return null; }
}

function humanBytes(b) {
  if (b == null) return '-';
  const u = ['B', 'K', 'M', 'G', 'T'];
  let i = 0;
  while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return b.toFixed(i ? 1 : 0) + u[i];
}

function collect() {
  const now = Date.now();
  const memTotal = os.totalmem();
  const memFree = os.freemem();
  const memUsed = memTotal - memFree;
  const net = netRates();
  prevAt = now;
  return {
    name: NAME,
    host: os.hostname(),
    platform: process.platform,
    arch: os.arch(),
    node: process.version,
    time: now,
    uptime: Math.round(os.uptime()),
    cpu: +cpuPercent().toFixed(1),
    cpus: os.cpus().length,
    load: os.loadavg().map(x => +x.toFixed(2)),
    mem: {
      total: memTotal,
      used: memUsed,
      percent: +(memUsed / memTotal * 100).toFixed(1),
    },
    disk: diskInfo(),
    net,
  };
}

function report() {
  const data = collect();
  const body = JSON.stringify(data);
  let url;
  try { url = new URL('/report', HUB); } catch (_) { console.error('bad hub url'); return; }
  const req = http.request({
    hostname: url.hostname,
    port: url.port || 80,
    path: url.pathname,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      ...(TOKEN ? { 'X-Token': TOKEN } : {}),
    },
  }, res => {
    res.resume();
    const m = data.mem, d = data.disk, n = data.net;
    console.log(
      `[${new Date().toLocaleTimeString()}] ${data.name} ` +
      `CPU ${data.cpu}% MEM ${m.percent}% (${humanBytes(m.used)}/${humanBytes(m.total)}) ` +
      `DISK ${d ? d.percent + '%' : '-'} NET ↓${humanBytes(n.rx)}/s ↑${humanBytes(n.tx)}/s -> ${res.statusCode}`
    );
  });
  req.on('error', e => console.error('report failed:', e.message));
  req.write(body);
  req.end();
}

console.log(`tinyprobe agent -> ${HUB} as "${NAME}" every ${INTERVAL}s (disk ${DISK_PATH})`);
collect(); // prime cpu/net baseline
setInterval(report, INTERVAL * 1000);
report();
