// Modawaa patient page (static). Connects to the doctor's open room through the PeerJS broker.
// The link looks like https://<site>/#<token>; the part after "#" never reaches the web server.
// No patient data is stored here: the date of birth is checked by the clinic's system.
'use strict';
(function () {
  const C = window.MODAWAA_CONFIG;
  const $ = id => document.getElementById(id);
  const steps = ['s-connect', 's-msg', 's-verify', 's-consent', 's-device', 's-wait', 's-call'];
  const go = id => steps.forEach(s => $(s).hidden = s !== id);
  const token = decodeURIComponent((location.hash || '').slice(1));
  let lang = new URLSearchParams(location.search).get('lang') || null;
  let T = C.T[lang || 'ar'];
  let peer = null, conn = null, stream = null, call = null;
  let dob = null, phase = 'connect', ended = false, mic = true, cam = true, retryTimer = null;

  function applyLang(l) {
    lang = l === 'en' ? 'en' : 'ar'; T = C.T[lang];
    document.documentElement.lang = lang; document.documentElement.dir = T.dir;
    document.querySelectorAll('[data-t]').forEach(el => { el.textContent = T[el.dataset.t] || ''; });
    $('chatin').placeholder = T.chat_placeholder;
    $('langbtn').textContent = T.other_label;
    $('brand').textContent = lang === 'ar' ? 'مداواة' : 'Modawaa';
    $('mic').textContent = mic ? T.mute : T.unmute; $('cam').textContent = cam ? T.cam_off : T.cam_on;
  }
  $('langbtn').onclick = e => { e.preventDefault(); applyLang(lang === 'ar' ? 'en' : 'ar'); };
  applyLang(lang || 'ar');

  const overlay = $('overlay');
  const show = t => { overlay.textContent = t || ''; overlay.style.display = t ? 'grid' : 'none'; };
  function message(text) { ended = true; go('s-msg'); $('msg').textContent = text; cleanup(); }
  function cleanup() {
    try { call && call.close(); } catch (e) {}
    try { conn && conn.close(); } catch (e) {}
    try { peer && peer.destroy(); } catch (e) {}
    if (stream) stream.getTracks().forEach(t => t.stop());
  }
  const send = m => { if (conn && conn.open) conn.send(m); };

  async function roomId(tok) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('modawaa:' + tok));
    return 'mdw-' + Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
  }

  // ---- connection to the doctor's room
  function scheduleRetry(ms) { clearTimeout(retryTimer); if (!ended) retryTimer = setTimeout(connect, ms); }

  let ROOM = null;
  function connect() {
    if (ended || !peer || peer.destroyed) return;
    if (peer.disconnected) { try { peer.reconnect(); } catch (e) {} scheduleRetry(3000); return; }
    const c = peer.connect(ROOM, {reliable: true, serialization: 'json'});
    const timer = setTimeout(() => {
      if (!c.open) {                         // the room exists but no direct/relayed path was found
        try { c.close(); } catch (e) {}
        if (phase === 'connect') $('connectmsg').textContent = T.net_blocked;
        scheduleRetry(1000);
      }
    }, 15000);
    c.on('open', () => { clearTimeout(timer); conn = c; send({type: 'hello'}); });
    c.on('data', m => onData(c, m));
    c.on('close', () => {
      if (conn !== c || ended) return;
      conn = null;
      if (phase === 'call') show(T.doctor_left); else if (phase !== 'verify') { go('s-connect'); $('connectmsg').textContent = T.reconnecting; }
      scheduleRetry(2000);
    });
  }

  function onData(c, m) {
    if (c !== conn || !m || typeof m !== 'object') return;
    switch (m.type) {
      case 'info': {
        if (!lang) applyLang(m.lang);
        $('docname').textContent = m.doctor_name || ''; $('docspec').textContent = m.specialty || '';
        $('when').textContent = m.scheduled_at || ''; $('appt').hidden = false;
        if (m.state === 'early') return message(T.early.replace('{t}', m.opens));
        if (m.state === 'expired' || m.state === 'locked') return message(T[m.state]);
        if (m.state === 'cancelled') return message(T.cancelled);
        if (m.state === 'completed' || m.state === 'no_show') return message(T.completed);
        if (dob) send({type: 'verify', dob});            // reconnect: verify again automatically
        else { phase = 'verify'; go('s-verify'); }
        break;
      }
      case 'verify_result': {
        $('vbtn').disabled = false;
        if (m.ok) {
          if (phase === 'call' || phase === 'wait') { send({type: 'consent'}); send({type: 'waiting'}); return; }
          if (m.consented) { startDevice(); } else { phase = 'consent'; go('s-consent'); }
        } else if (m.state === 'locked') { message(T.locked); }
        else if (m.state && m.state !== 'open') { message(T.expired); }
        else { dob = null; phase = 'verify'; go('s-verify'); $('verr').hidden = false;
               $('verr').textContent = T.verify_wrong.replace('{n}', m.left); }
        break;
      }
      case 'admitted': phase = 'call'; go('s-call'); show(T.connecting); break;
      case 'chat': $('chatbox').hidden = false; addChat(lang === 'ar' ? 'الطبيب' : 'Doctor', m.text, false); break;
      case 'ended': message(T.ended); break;
    }
  }

  // ---- steps
  [['dd', 'mm', 2], ['mm', 'yy', 2]].forEach(([a, b, n]) => {
    const el = $(a); el.addEventListener('input', () => { if (el.value.length >= n) $(b).focus(); });
  });
  $('s-verify').addEventListener('submit', e => {
    e.preventDefault();
    const d = +$('dd').value, mo = +$('mm').value, y = +$('yy').value;
    const dt = new Date(Date.UTC(y, mo - 1, d));
    if (!y || dt.getUTCDate() !== d || dt.getUTCMonth() !== mo - 1) { $('verr').hidden = false; $('verr').textContent = T.dob_hint; return; }
    dob = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    $('vbtn').disabled = true; send({type: 'verify', dob});
  });
  $('agree').onclick = () => { send({type: 'consent'}); startDevice(); };

  async function startDevice() {
    phase = 'device'; go('s-device');
    $('devmsg').textContent = ''; $('retry').hidden = true; $('enter').disabled = true;
    try {
      if (!stream) stream = await navigator.mediaDevices.getUserMedia({
        audio: {echoCancellation: true, noiseSuppression: true}, video: {facingMode: 'user', width: {ideal: 1280}}});
      $('preview').srcObject = stream; $('preview').play().catch(() => {}); $('local').srcObject = stream;
      $('devmsg').textContent = '✓ ' + T.device_ok; $('enter').disabled = false;
    } catch (e) { $('devmsg').textContent = T.device_fail; $('retry').hidden = false; }
  }
  $('retry').onclick = startDevice;
  $('enter').onclick = () => { phase = 'wait'; go('s-wait'); send({type: 'waiting'}); };

  // ---- call
  function answer(incoming) {
    if (call) { try { call.close(); } catch (e) {} }
    call = incoming; const mine = incoming;
    phase = 'call'; go('s-call'); show(T.connecting);
    incoming.answer(stream);
    incoming.on('stream', s => { if (call !== mine) return; $('remote').srcObject = s; show(''); });
    incoming.on('close', () => { if (call === mine && !ended) show(T.reconnecting); });
  }
  function addChat(who, text, mine) {
    const d = document.createElement('div'); d.className = 'msg' + (mine ? ' me' : '');
    const b = document.createElement('strong'); b.textContent = who + ': ';
    d.appendChild(b); d.appendChild(document.createTextNode(String(text || '').slice(0, 1000)));
    $('chatlog').appendChild(d); $('chatlog').scrollTop = $('chatlog').scrollHeight;
  }
  $('chatform').addEventListener('submit', e => {
    e.preventDefault(); const t = $('chatin').value.trim(); if (!t) return;
    send({type: 'chat', text: t.slice(0, 1000)}); addChat(lang === 'ar' ? 'أنت' : 'You', t, true); $('chatin').value = '';
  });
  $('chatbtn').onclick = () => { $('chatbox').hidden = !$('chatbox').hidden; };
  $('mic').onclick = () => { mic = !mic; stream && stream.getAudioTracks().forEach(t => t.enabled = mic);
                             $('mic').textContent = mic ? T.mute : T.unmute; send({type: 'media', mic}); };
  $('cam').onclick = () => { cam = !cam; stream && stream.getVideoTracks().forEach(t => t.enabled = cam);
                             $('cam').textContent = cam ? T.cam_off : T.cam_on; send({type: 'media', cam}); };
  $('leave').onclick = () => { send({type: 'leave'}); setTimeout(() => message(T.ended), 200); };

  // ---- start
  if (!/^[A-Za-z0-9_-]{10,64}$/.test(token)) { message(T.not_found); return; }
  if (!window.Peer || !window.isSecureContext) { message(T.not_found); return; }
  roomId(token).then(id => {
    ROOM = id;
    peer = new Peer({config: {iceServers: C.ICE}, debug: 1});
    peer.on('open', () => connect());
    peer.on('call', incoming => answer(incoming));
    peer.on('disconnected', () => { if (!ended) setTimeout(() => { try { peer.reconnect(); } catch (e) {} }, 2000); });
    peer.on('error', e => {
      if (e.type === 'peer-unavailable') {            // doctor's room not open yet
        if (phase === 'connect') $('connectmsg').textContent = T.connect_help;
        scheduleRetry(4000);
      } else if (['network', 'server-error', 'socket-error', 'disconnected'].includes(e.type)) {
        scheduleRetry(4000);
      } else console.warn('peer', e.type);
    });
  });
})();
