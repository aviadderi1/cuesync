// remote.js
// Runs a small local HTTP + WebSocket server so a phone on the same WiFi
// network can open a web page and remote-control the app (switch which
// song/track is active, basic transport). Nothing here talks to the
// internet — it only listens on the local network.

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
let WebSocketServer = null;
try {
  WebSocketServer = require('ws').Server;
} catch (e) {
  console.error('The "ws" package is not installed — remote control is unavailable.', e);
}

const PORT = 8790;

let httpServer = null;
let wss = null;
let latestState = { songs: [], activeTrackId: null };
let onCommandCallback = null;

function getLocalIPs() {
  const nets = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) ips.push(net.address);
    }
  }
  return ips;
}

function buildRemotePageHtml() {
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
<title>Cue Sync — Remote</title>
<link rel="manifest" href="/manifest.webmanifest">
<link rel="apple-touch-icon" href="/icon.png">
<link rel="icon" type="image/png" href="/icon.png">
<meta name="theme-color" content="#08090b">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="Cue Sync">
<style>
  :root{
    --bg:#08090b; --panel:#12151a; --panel-2:#171b21; --line:#242a33;
    --cyan:#45d6c0; --cyan-dim:#1f4a44; --amber:#f2a94e; --text:#ece9e2; --muted:#8891a0;
  }
  *{box-sizing:border-box;-webkit-tap-highlight-color:transparent;}
  html,body{margin:0;height:100%;background:var(--bg);color:var(--text);
    font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;overscroll-behavior:none;}
  header{padding:16px 18px 10px;border-bottom:1px solid var(--line);}
  h1{font-size:17px;margin:0 0 2px;font-weight:800;}
  #status{font-size:11px;font-family:monospace;letter-spacing:.5px;}
  #status.ok{color:var(--cyan);} #status.bad{color:#ff6161;}
  .led-meter{display:flex;gap:2px;padding:10px 18px;border-bottom:1px solid var(--line);}
  .led-meter .led{flex:1;height:14px;border-radius:1px;background:#1c2027;box-shadow:inset 0 0 0 1px #262b33;}
  .led-meter .led.lit-green{background:#3ecf5e;box-shadow:0 0 5px rgba(62,207,94,.7);}
  .led-meter .led.lit-yellow{background:#f2d24e;box-shadow:0 0 5px rgba(242,210,78,.7);}
  .led-meter .led.lit-red{background:#ff6161;box-shadow:0 0 6px rgba(255,97,97,.8);}
  .transport{display:flex;gap:10px;padding:14px 18px;border-bottom:1px solid var(--line);}
  .tbtn{flex:1;padding:16px 0;border-radius:10px;border:1px solid var(--line);background:var(--panel-2);
    color:var(--text);font-size:15px;font-weight:700;text-align:center;transition:.15s ease;}
  .tbtn.play{border-color:var(--cyan-dim);color:var(--cyan);}
  .tbtn.play.active{background:var(--cyan-dim);border-color:var(--cyan);box-shadow:0 0 16px rgba(69,214,192,.6);}
  .tbtn.stop.active{background:#3a1a1a;border-color:#ff6161;color:#ff6161;box-shadow:0 0 16px rgba(255,97,97,.5);}
  .tbtn.cuelock{font-size:12px;letter-spacing:.5px;}
  /* Optically balanced glyphs: the triangle and square are drawn to the same
     visual weight inside the button rather than relying on text characters. */
  .ticon{width:26px;height:26px;display:block;margin:0 auto;fill:currentColor;}
  .tbtn.cuelock.locked{background:repeating-linear-gradient(45deg,#c23333,#c23333 8px,#a02222 8px,#a02222 16px);
    border-color:#ff6161;color:#fff;box-shadow:0 0 16px rgba(200,40,40,.55);}
  /* Instant feedback on tap, before the desktop confirms the new state. */
  .tbtn.cuelock:active{background:#c23333;border-color:#ff6161;color:#fff;}
  #list{padding:12px;}
  .song-btn{
    display:flex;align-items:center;justify-content:space-between;gap:10px;
    padding:16px 16px;margin-bottom:10px;border-radius:12px;border:1px solid var(--line);
    background:var(--panel-2);font-size:15px;font-weight:600;
  }
  .song-btn.active{border-color:var(--cyan);background:rgba(69,214,192,.12);color:var(--cyan);}
  .song-btn .dot{width:9px;height:9px;border-radius:50%;background:var(--muted);flex-shrink:0;}
  .now-playing{
    display:inline-block; margin-inline-start:8px; font-size:10px; font-weight:800;
    letter-spacing:.5px; color:var(--cyan); text-transform:uppercase;
    animation: nowPlayingBlink 1.1s ease-in-out infinite;
  }
  @keyframes nowPlayingBlink{
    0%,100%{ opacity:1; } 50%{ opacity:.25; }
  }
  .song-btn.active .dot{background:var(--cyan);box-shadow:0 0 8px var(--cyan);}
  .song-btn{align-items:flex-start;}
  .sb-main{display:flex;flex-direction:column;gap:3px;min-width:0;flex:1;}
  .sb-title{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
  .sb-cue{font-size:11px;font-weight:700;color:var(--amber);letter-spacing:.3px;
    white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
  .sb-right{display:flex;flex-direction:column;align-items:flex-end;gap:3px;flex-shrink:0;}
  .sb-time{font-family:monospace;font-size:11px;color:var(--muted);}
  .sb-left{font-family:monospace;font-size:12px;font-weight:700;color:var(--cyan);}
  .empty{padding:40px 20px;text-align:center;color:var(--muted);font-size:13px;line-height:1.7;}
</style>
</head><body>
<header>
  <h1>Cue Sync — Remote</h1>
  <div id="status" class="bad">Connecting…</div>
</header>
<div class="led-meter" id="ledMeter"></div>
<div class="transport">
  <div class="tbtn play" id="playBtn"><svg class="ticon" viewBox="0 0 24 24" aria-hidden="true"><polygon points="7,4 20,12 7,20"/></svg></div>
  <div class="tbtn stop" id="stopBtn"><svg class="ticon" viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="1.5"/></svg></div>
  <div class="tbtn cuelock" id="cueLockBtn">🔓<br>CUE LOCK</div>
</div>
<div id="list"><div class="empty">Waiting for song list from the app…</div></div>
<script>
  let ws;
  const statusEl = document.getElementById('status');
  const listEl = document.getElementById('list');
  const playBtn = document.getElementById('playBtn');
  const stopBtn = document.getElementById('stopBtn');
  const ledMeterEl = document.getElementById('ledMeter');
  const LED_COUNT = 20;
  const ledEls = [];
  for(let i=0;i<LED_COUNT;i++){
    const led = document.createElement('div');
    led.className = 'led';
    ledMeterEl.appendChild(led);
    ledEls.push(led);
  }

  function connect(){
    ws = new WebSocket('ws://' + location.host + '/ws');
    ws.onopen = () => { statusEl.textContent = 'Connected'; statusEl.className = 'ok'; };
    ws.onclose = () => { statusEl.textContent = 'Disconnected — retrying…'; statusEl.className = 'bad'; setTimeout(connect, 1500); };
    ws.onerror = () => { try{ ws.close(); }catch(e){} };
    ws.onmessage = (ev) => {
      try{
        const msg = JSON.parse(ev.data);
        if(msg.type === 'state'){ renderState(msg.state); applyCueLockFromState(msg.state); }
        else if(msg.type === 'level') renderLevel(msg.level);
      }catch(e){}
    };
  }
  function applyCueLockFromState(st){
    if(st && typeof st.cueLocked !== 'undefined') paintCueLock(st.cueLocked);
  }
  function fmtClock(sec){
    sec = Math.max(0, Math.floor(sec || 0));
    const m = Math.floor(sec/60), r = sec%60;
    return m + ':' + String(r).padStart(2,'0');
  }
  function send(obj){
    if(ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  }
  function renderState(state){
    const songs = state.songs || [];
    playBtn.classList.toggle('active', !!state.isPlaying);
    stopBtn.classList.toggle('active', !state.isPlaying);
    if(songs.length === 0){
      listEl.innerHTML = '<div class="empty">No songs in the project yet.</div>';
      return;
    }
    listEl.innerHTML = songs.map(s => {
      const isCur = s.id === state.activeTrackId;
      const dur = s.duration || 0;
      // Only the song actually playing counts down; the rest show full length.
      const elapsed = (isCur && state.isPlaying) ? (state.elapsed || 0) : 0;
      const left = Math.max(0, dur - elapsed);
      const cueLine = (isCur && state.currentCue)
        ? '<span class="sb-cue">▶ ' + escapeHtml(state.currentCue) + '</span>' : '';
      return '<div class="song-btn' + (isCur ? ' active' : '') + '" data-id="' + s.id + '">' +
        '<span class="sb-main">' +
          '<span class="sb-title">' + escapeHtml(s.name) +
            (isCur && state.isPlaying ? '<span class="now-playing">Now Playing</span>' : '') +
          '</span>' + cueLine +
        '</span>' +
        '<span class="sb-right">' +
          '<span class="sb-time">' + fmtClock(dur) + '</span>' +
          '<span class="sb-left">-' + fmtClock(left) + '</span>' +
        '</span>' +
        '<span class="dot"></span>' +
      '</div>';
    }).join('');
    listEl.querySelectorAll('.song-btn').forEach(el=>{
      el.addEventListener('click', ()=> send({type:'selectTrack', songId: el.dataset.id}));
    });
  }
  function renderLevel(level){
    const litCount = Math.round(Math.max(0, Math.min(1, level)) * LED_COUNT);
    for(let i=0;i<LED_COUNT;i++){
      const led = ledEls[i];
      if(i < litCount){
        if(i < LED_COUNT*0.6) led.className = 'led lit-green';
        else if(i < LED_COUNT*0.85) led.className = 'led lit-yellow';
        else led.className = 'led lit-red';
      } else {
        led.className = 'led';
      }
    }
  }
  function escapeHtml(s){
    const d = document.createElement('div'); d.textContent = s; return d.innerHTML;
  }
  playBtn.addEventListener('click', ()=> send({type:'play'}));
  stopBtn.addEventListener('click', ()=> send({type:'stop'}));
  const cueLockBtn = document.getElementById('cueLockBtn');
  cueLockBtn.addEventListener('click', ()=>{
    paintCueLock(!cueLockBtn.classList.contains('locked'));
    send({type:'cueLock'});
  });
  function paintCueLock(locked){
    cueLockBtn.classList.toggle('locked', !!locked);
    cueLockBtn.innerHTML = (locked ? '🔒' : '🔓') + '<br>CUE LOCK';
  }

  connect();
</script>
</body></html>`;
}

function startServer(onCommand) {
  if (!WebSocketServer) return { urls: [], port: PORT };
  onCommandCallback = onCommand;
  if (httpServer) return { urls: getLocalIPs().map(ip => `http://${ip}:${PORT}`), port: PORT };

  httpServer = http.createServer((req, res) => {
    if (req.url === '/' || req.url === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(buildRemotePageHtml());
    } else if (req.url === '/icon.png') {
      // The same artwork as the desktop icon, so "Add to Home Screen" on the
      // phone shows the real Cue Sync icon rather than a screenshot.
      try {
        const buf = fs.readFileSync(path.join(__dirname, 'icon.png'));
        res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' });
        res.end(buf);
      } catch (e) { res.writeHead(404); res.end('no icon'); }
    } else if (req.url === '/manifest.webmanifest') {
      res.writeHead(200, { 'Content-Type': 'application/manifest+json; charset=utf-8' });
      res.end(JSON.stringify({
        name: 'Cue Sync Remote',
        short_name: 'Cue Sync',
        start_url: '/',
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#08090b',
        theme_color: '#08090b',
        icons: [
          { src: '/icon.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: '/icon.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
        ]
      }));
    } else {
      res.writeHead(404);
      res.end('Not found');
    }
  });

  wss = new WebSocketServer({ server: httpServer, path: '/ws' });
  wss.on('connection', (socket) => {
    socket.send(JSON.stringify({ type: 'state', state: latestState }));
    socket.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (onCommandCallback) onCommandCallback(msg);
      } catch (e) { /* ignore malformed message */ }
    });
  });

  httpServer.listen(PORT, '0.0.0.0');

  return { urls: getLocalIPs().map(ip => `http://${ip}:${PORT}`), port: PORT };
}

function broadcastState(state) {
  latestState = state || latestState;
  if (!wss) return;
  const payload = JSON.stringify({ type: 'state', state: latestState });
  wss.clients.forEach((client) => {
    if (client.readyState === 1) client.send(payload);
  });
}

function broadcastLevel(level) {
  if (!wss || !wss.clients || wss.clients.size === 0) return;
  const payload = JSON.stringify({ type: 'level', level });
  wss.clients.forEach((client) => {
    if (client.readyState === 1) client.send(payload);
  });
}

function stopServer() {
  if (wss) { wss.close(); wss = null; }
  if (httpServer) { httpServer.close(); httpServer = null; }
}

module.exports = { startServer, broadcastState, broadcastLevel, stopServer, getLocalIPs, PORT };
