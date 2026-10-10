'use strict';
/* ---------------- CUENTA Y NUBE (Supabase) ----------------
   Login opcional con email y contraseña. Si hay sesión, el progreso guardado en Store
   se sube a la nube y se descarga en cualquier dispositivo. Sin librerías: solo fetch. */
const SUPABASE_URL = 'https://mqdzwszearfsbracdybq.supabase.co';
const SUPABASE_KEY = 'sb_publishable_xvIkndYAPPAwVbIjMdk5ag_BeEYkTMs'; // clave pública (segura en el navegador gracias a RLS)
const SESSION_KEY = 'tes_session_v1';      // no se sincroniza
const DEVICE_MODE_KEY = 'tes_device_mode_v1'; // 'user' si alguna vez entró con cuenta aquí, 'guest' si eligió invitado
const LOCAL_STAMP_KEY = 'tes_local_updated_v1';
const SYNC_KEYS = [
  'tes_test_history_v1', 'tes_failed_ids_v1', 'tes_mastered_ids_v1',
  'tes_seen_v1', 'tes_recent_tests_v1', 'tes_test_progress_v1'
];
const SCORE_QUEUE_KEY = 'tes_score_queue_v1'; // puntos pendientes de subir al ranking

const Cloud = (function(){
  let session = null;        // {access_token, refresh_token, expires_at, user:{id,email,user_metadata}}
  let status = 'idle';       // idle | syncing | ok | error | offline
  let lastSync = null;
  let pushTimer = null;
  let applyingRemote = false;
  let accountMsg = null;     // {type:'ok'|'error', text}
  let accountView = 'login'; // login | signup

  /* ---------- HTTP ---------- */
  async function api(path, opts){
    opts = opts || {};
    const headers = Object.assign({ apikey: SUPABASE_KEY, 'Content-Type': 'application/json' }, opts.headers || {});
    if(opts.auth !== false && session) headers.Authorization = 'Bearer ' + session.access_token;
    const res = await fetch(SUPABASE_URL + path, { method: opts.method || 'GET', headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
    const text = await res.text();
    let data = null; try{ data = text ? JSON.parse(text) : null; }catch(e){ data = text; }
    if(!res.ok){
      const msg = (data && (data.msg || data.error_description || data.message || data.error)) || ('Error ' + res.status);
      const err = new Error(msg); err.status = res.status; err.code = data && (data.error_code || data.code); throw err;
    }
    return data;
  }

  /* ---------- SESIÓN ---------- */
  function saveSession(s){
    session = s;
    if(s){ Store.setRaw(SESSION_KEY, JSON.stringify(s)); Store.setRaw(DEVICE_MODE_KEY, 'user'); }
    else Store.remove(SESSION_KEY);
  }
  function fromTokenResponse(d){
    return { access_token: d.access_token, refresh_token: d.refresh_token,
      expires_at: d.expires_at || (Math.floor(Date.now()/1000) + (d.expires_in || 3600)), user: d.user };
  }
  async function ensureFreshToken(){
    if(!session) return false;
    if(session.expires_at - 60 > Date.now()/1000) return true;
    try{
      const d = await api('/auth/v1/token?grant_type=refresh_token', { method:'POST', auth:false, body:{ refresh_token: session.refresh_token } });
      saveSession(fromTokenResponse(d));
      return true;
    }catch(e){
      if(e.status === 400 || e.status === 401){ saveSession(null); }
      return false;
    }
  }
  function displayName(){
    if(!session || !session.user) return '';
    const m = session.user.user_metadata || {};
    return m.display_name || (session.user.email || '').split('@')[0];
  }

  /* ---------- SINCRONIZACIÓN ---------- */
  function localSnapshot(){ return Store.snapshot(SYNC_KEYS); }
  function parse(raw, fb){ try{ const v = JSON.parse(raw); return v == null ? fb : v; }catch(e){ return fb; } }
  // Une local y nube sin perder nada importante
  function merge(local, remote, localNewer){
    const out = Object.assign({}, localNewer ? remote : local, localNewer ? local : remote);
    // Historial: unión de los dos, sin duplicados, el más reciente primero
    const hist = parse(local['tes_test_history_v1'], []).concat(parse(remote['tes_test_history_v1'], []));
    const seen = new Set(); const histMerged = [];
    hist.sort((a,b)=>(b.date||0)-(a.date||0)).forEach(h=>{
      const k = (h.date||0) + '|' + h.score + '|' + h.total + '|' + h.mode;
      if(!seen.has(k)){ seen.add(k); histMerged.push(h); }
    });
    out['tes_test_history_v1'] = JSON.stringify(histMerged.slice(0,80));
    // Preguntas dominadas: unión
    const mastered = new Set(parse(local['tes_mastered_ids_v1'], []).concat(parse(remote['tes_mastered_ids_v1'], [])));
    out['tes_mastered_ids_v1'] = JSON.stringify(Array.from(mastered));
    return out;
  }
  function isEmptySnapshot(s){
    return !s || !Object.keys(s).some(k=>{ const v = parse(s[k], null); return v && (Array.isArray(v) ? v.length : Object.keys(v).length); });
  }
  function setStatus(s){ status = s; if(s === 'ok') lastSync = Date.now(); updateBadge(); refreshAccountIfOpen(); }

  async function pull(){
    if(!(await ensureFreshToken())) return;
    setStatus('syncing');
    try{
      const rows = await api('/rest/v1/user_data?select=data,updated_at&user_id=eq.' + session.user.id);
      const row = rows && rows[0];
      const remote = (row && row.data && row.data.keys) || {};
      const remoteStamp = (row && row.data && row.data.stamp) || 0;
      const local = localSnapshot();
      const localStamp = Number(Store.getRaw(LOCAL_STAMP_KEY) || 0);
      let final;
      if(isEmptySnapshot(remote)) final = local;
      else if(isEmptySnapshot(local)) final = remote;
      else final = merge(local, remote, localStamp > remoteStamp);
      applyingRemote = true;
      SYNC_KEYS.forEach(k=>{ if(final[k] === undefined) Store.remove(k); });
      Store.restore(final);
      applyingRemote = false;
      await push(true);
      flushScores();
      if(typeof onRemoteApplied === 'function') onRemoteApplied();
    }catch(e){
      applyingRemote = false;
      setStatus(navigator.onLine === false ? 'offline' : 'error');
    }
  }
  async function push(immediate){
    if(pushTimer){ clearTimeout(pushTimer); pushTimer = null; }
    if(!immediate){ pushTimer = setTimeout(()=>push(true), 2500); return; }
    if(!(await ensureFreshToken())) return;
    setStatus('syncing');
    try{
      const stamp = Number(Store.getRaw(LOCAL_STAMP_KEY) || Date.now());
      await api('/rest/v1/user_data?on_conflict=user_id', {
        method:'POST', headers:{ Prefer:'resolution=merge-duplicates,return=minimal' },
        body:{ user_id: session.user.id, data:{ keys: localSnapshot(), stamp }, updated_at: new Date().toISOString() }
      });
      setStatus('ok');
    }catch(e){ setStatus(navigator.onLine === false ? 'offline' : 'error'); }
  }
  Store.onChange(key=>{
    if(applyingRemote || SYNC_KEYS.indexOf(key) === -1) return;
    Store.setRaw(LOCAL_STAMP_KEY, String(Date.now()));
    if(session) push(false);
  });
  window.addEventListener('pagehide', ()=>{ if(pushTimer && session){ push(true); } });
  window.addEventListener('online', ()=>{ if(session) pull(); });

  /* ---------- RANKING SEMANAL ---------- */
  function recordScore(entry){
    if(!session) return;   // los invitados no puntúan
    const q = Store.get(SCORE_QUEUE_KEY, []);
    q.push(Object.assign({ at: new Date().toISOString() }, entry));
    Store.set(SCORE_QUEUE_KEY, q.slice(-50));
    flushScores();
  }
  let flushing = false;
  async function flushScores(){
    if(flushing || !session) return;
    flushing = true;
    try{
      if(!(await ensureFreshToken())) return;
      let q = Store.get(SCORE_QUEUE_KEY, []);
      while(q.length){
        const e = q[0];
        try{
        await api('/rest/v1/scores', { method:'POST', headers:{ Prefer:'return=minimal' }, body:{
          user_id: session.user.id, subject: e.subject || null, mode: e.mode || null,
          correct: Math.max(0, Math.min(200, e.correct|0)), total: Math.max(1, Math.min(200, e.total|0)),
          points: Math.max(0, Math.min(260, e.points|0)) } });
        }catch(err){
          // Rechazado por la base de datos (límite diario, datos no válidos): se descarta para no reintentarlo siempre
          if(!(err.status >= 400 && err.status < 500) || err.status === 401) throw err;
        }
        q = q.slice(1);
        Store.set(SCORE_QUEUE_KEY, q);
      }
    }catch(e){ /* se reintenta en la próxima sincronización */ }
    finally{ flushing = false; }
  }
  function weekRangeText(){
    const now = new Date();
    const day = (now.getDay() + 6) % 7;      // lunes = 0
    const mon = new Date(now); mon.setDate(now.getDate() - day);
    const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
    const f = d=>d.toLocaleDateString('es-ES', { day:'numeric', month:'short' });
    return f(mon) + ' – ' + f(sun);
  }
  let rankingProfile = null;
  async function renderRanking(box){
    if(!box) return;
    if(!session){
      box.innerHTML = `
        <div class="rank-empty">
          <div class="rank-trophy">${icon('medal', 30)}</div>
          <b>Ranking semanal de la clase</b>
          <p class="empty-hint">Suma puntos con cada test y compite con tus compañeros. Para entrar necesitas una cuenta.</p>
          <button class="btn-primary" data-action="cloudView" data-args='["signup"]'>Crear cuenta</button>
          <button class="acc-link" data-action="cloudView" data-args='["login"]'>Ya tengo cuenta · Iniciar sesión</button>
        </div>`;
      return;
    }
    try{
      await ensureFreshToken();
      await flushScores();
      const [prof, rows] = await Promise.all([
        api('/rest/v1/profiles?select=display_name&id=eq.' + session.user.id),
        api('/rest/v1/rpc/weekly_ranking', { method:'POST', body:{} })
      ]);
      rankingProfile = (prof && prof[0]) || { display_name: displayName() };
      if(!box.isConnected) return;
      const me = rows.find(r=>r.is_me);
      const list = rows.length ? rows.map(r=>{
        const medal = (r.rank <= 3 && r.points > 0) ? `<span class="rank-medal m${r.rank}">${r.rank}</span>` : `<span class="rank-pos">${r.rank}</span>`;
        return `<li class="${r.is_me ? 'me' : ''}">${medal}<span class="rank-name">${escapeHtml(r.display_name)}${r.is_me ? ' <em>(tú)</em>' : ''}</span>
          <span class="rank-tests">${r.tests} ${r.tests == 1 ? 'test' : 'tests'}</span><b class="rank-pts">${r.points}</b></li>`;
      }).join('') : '';
      box.innerHTML = `
        <div class="rank-head">
          <div><b>Ranking de la semana</b><span>${escapeHtml(weekRangeText())} · se reinicia el lunes</span></div>
          ${me ? `<div class="rank-mine"><b>${me.points}</b><span>tus puntos · ${me.rank}º</span></div>` : ''}
        </div>
        <div class="rank-settings">
          <span class="rank-toggle">${icon('user',16)} Todos los alumnos con cuenta aparecen</span>
          <label class="rank-namefield" for="rankName">Nombre visible
            <input type="text" id="rankName" maxlength="24" value="${escapeHtml(rankingProfile.display_name || '')}" data-change="cloudSetRankName">
          </label>
        </div>
        ${list ? `<ol class="rank-list">${list}</ol>` : `<p class="empty-hint">Todavía no hay nadie en el ranking.</p>`}
        <p class="rank-rules">1 punto por cada acierto · +10 por aprobar un simulacro de examen. Solo cuentan los tests hechos con la sesión iniciada.</p>`;
    }catch(e){
      if(box.isConnected) box.innerHTML = `<p class="empty-hint">No se pudo cargar el ranking. ${escapeHtml(friendlyError(e))}</p>`;
    }
  }
  async function updateProfile(fields){
    if(!session) return;
    try{
      await ensureFreshToken();
      await api('/rest/v1/profiles?id=eq.' + session.user.id, { method:'PATCH', headers:{ Prefer:'return=minimal' }, body: fields });
    }catch(e){}
    const box = document.getElementById('rankingBox');
    if(box) renderRanking(box);
  }

  /* ---------- ACCIONES DE CUENTA ---------- */
  function friendlyError(e){
    const m = (e.message || '').toLowerCase();
    if(m.includes('invalid login')) return 'Email o contraseña incorrectos.';
    if(m.includes('email not confirmed')) return 'Tienes que confirmar tu email antes de entrar. Revisa tu correo (y la carpeta de spam).';
    if(m.includes('already registered') || m.includes('already been registered')) return 'Ese email ya tiene cuenta. Prueba a iniciar sesión.';
    if(m.includes('password') && m.includes('6')) return 'La contraseña debe tener al menos 6 caracteres.';
    if(m.includes('rate limit') || e.status === 429) return 'Demasiados intentos. Espera unos minutos y vuelve a probar.';
    if(m.includes('failed to fetch') || m.includes('network')) return 'Sin conexión. Revisa tu internet.';
    return 'No se pudo completar: ' + e.message;
  }
  async function login(email, password){
    const d = await api('/auth/v1/token?grant_type=password', { method:'POST', auth:false, body:{ email, password } });
    saveSession(fromTokenResponse(d));
    await pull();
  }
  async function signup(email, password, name){
    const d = await api('/auth/v1/signup', { method:'POST', auth:false,
      body:{ email, password, data:{ display_name: name } } });
    if(d && d.access_token){ saveSession(fromTokenResponse(d)); await pull(); return 'in'; }
    // Sin confirmación por email, si no llega sesión es que ese email ya estaba registrado
    return 'exists';
  }
  async function logout(){
    if(pushTimer) await push(true);
    try{ await api('/auth/v1/logout', { method:'POST' }); }catch(e){}
    saveSession(null);
    setStatus('idle');
  }

  /* ---------- UI ---------- */
  function updateBadge(){
    const el = document.getElementById('accountIcon');
    if(!el) return;
    el.innerHTML = icon('user', 18);
    const btn = document.getElementById('accountBtn');
    if(btn){
      btn.classList.toggle('logged', !!session);
      btn.classList.toggle('sync-error', status === 'error' || status === 'offline');
      btn.setAttribute('aria-label', session ? 'Mi cuenta (' + displayName() + ')' : 'Iniciar sesión');
    }
  }
  function refreshAccountIfOpen(){ if(document.getElementById('accountScreen')) renderAccount(); }
  function statusText(){
    if(status === 'syncing') return 'Sincronizando…';
    if(status === 'error') return 'No se pudo sincronizar. Se reintentará.';
    if(status === 'offline') return 'Sin conexión. Se guardará al volver internet.';
    if(lastSync) return 'Guardado en la nube · ' + new Date(lastSync).toLocaleTimeString('es-ES', {hour:'2-digit', minute:'2-digit'});
    return 'Listo';
  }
  function msgHtml(){
    if(!accountMsg) return '';
    return `<div class="acc-msg ${accountMsg.type}">${escapeHtml(accountMsg.text)}</div>`;
  }
  function renderAccount(){
    if(typeof clearTimer === 'function') clearTimer();
    document.getElementById('topbarSub').textContent = 'Mi cuenta';
    let inner;
    if(session){
      inner = `
        <div class="acc-card">
          <div class="acc-avatar">${icon('user', 26)}</div>
          <div class="acc-name">${escapeHtml(displayName())}</div>
          <div class="acc-email">${escapeHtml(session.user.email || '')}</div>
          <div class="acc-status ${status}">${escapeHtml(statusText())}</div>
        </div>
        ${msgHtml()}
        <p class="empty-hint">Tu historial, falladas, logros y el test a medias se guardan en tu cuenta. Entra con el mismo email en otro móvil u ordenador y lo tendrás todo.</p>
        <button class="btn-primary" data-action="cloudSyncNow">${icon('route',18)} Sincronizar ahora</button>
        <button class="btn-secondary acc-full" data-action="cloudLogout">Cerrar sesión</button>`;
    } else if(accountView === 'signup'){
      inner = `
        <div class="section-label">Crear cuenta</div>
        ${msgHtml()}
        <form data-form="signup" class="acc-form">
          <label>Nombre<input name="name" type="text" maxlength="60" autocomplete="nickname" required></label>
          <label>Email<input name="email" type="email" autocomplete="email" required></label>
          <label>Contraseña<input name="password" type="password" minlength="6" autocomplete="new-password" required></label>
          <button class="btn-primary" type="submit">Crear cuenta</button>
        </form>
        <button class="acc-link" data-action="cloudView" data-args='["login"]'>Ya tengo cuenta · Iniciar sesión</button>`;
    } else {
      inner = `
        <div class="section-label">Iniciar sesión</div>
        <p class="empty-hint">Es opcional: la app funciona igual sin cuenta. Con cuenta, tu progreso se guarda en la nube y lo ves en cualquier dispositivo.</p>
        ${msgHtml()}
        <form data-form="login" class="acc-form">
          <label>Email<input name="email" type="email" autocomplete="email" required></label>
          <label>Contraseña<input name="password" type="password" autocomplete="current-password" required></label>
          <button class="btn-primary" type="submit">Entrar</button>
        </form>
        <p class="empty-hint acc-forgot">¿Has olvidado la contraseña? Pide al administrador de la app que te la restablezca.</p>
        <button class="btn-secondary acc-full" data-action="cloudView" data-args='["signup"]'>Crear cuenta nueva</button>
        <button class="acc-link welcome-guest" data-action="renderHome" data-guest="1">Continuar como invitado</button>`;
    }
    document.getElementById('screen').innerHTML = `
      <div class="home" id="accountScreen">
        <button class="back-link" data-action="renderHome">${icon('chevronLeft',16)} Inicio</button>
        ${inner}
      </div>`;
  }
  function setBusy(form, busy){
    form.querySelectorAll('input,button').forEach(el=>{ el.disabled = busy; });
    const b = form.querySelector('button[type=submit]');
    if(b){ if(busy){ b.dataset.label = b.textContent; b.textContent = 'Un momento…'; } else if(b.dataset.label){ b.textContent = b.dataset.label; } }
  }
  const FORMS = {
    async login(f){
      await login(f.email.value.trim(), f.password.value);
      accountMsg = { type:'ok', text:'¡Dentro! Tu progreso ya está sincronizado.' };
    },
    async signup(f){
      const r = await signup(f.email.value.trim(), f.password.value, f.name.value.trim());
      if(r === 'exists'){ accountView = 'login'; accountMsg = { type:'error', text:'Ese email ya tiene cuenta. Inicia sesión con tu contraseña.' }; }
      else accountMsg = { type:'ok', text:'¡Cuenta creada! Tu progreso ya se guarda en la nube.' };
    }
  };
  document.addEventListener('submit', async e=>{
    const f = e.target.closest('form[data-form]');
    if(!f || !FORMS[f.dataset.form]) return;
    e.preventDefault();
    accountMsg = null;
    setBusy(f, true);
    try{ await FORMS[f.dataset.form](f); renderAccount(); updateBadge(); }
    catch(err){ accountMsg = { type:'error', text: friendlyError(err) }; renderAccount(); }
  });

  // Recordar que en este dispositivo se eligió entrar como invitado
  document.addEventListener('click', e=>{ if(e.target.closest('[data-guest]')) Store.setRaw(DEVICE_MODE_KEY, 'guest'); });

  let onRemoteApplied = null;
  async function init(onApplied){
    onRemoteApplied = onApplied;
    session = parse(Store.getRaw(SESSION_KEY), null);
    updateBadge();
    if(session){ pull(); return; }
    // Sin sesión: el dispositivo recuerda si ya tuvo cuenta, si entró como invitado o si es nuevo
    const mode = Store.getRaw(DEVICE_MODE_KEY);
    if(mode === 'guest') return;                       // invitado: directo al inicio
    if(mode === 'user'){                               // ya tiene cuenta: directo a iniciar sesión
      accountView = 'login';
      accountMsg = { type:'ok', text:'¡Hola de nuevo! Inicia sesión para recuperar tu progreso.' };
      renderAccount();
      return;
    }
    renderWelcome();                                   // nuevo: pantalla de bienvenida
  }

  // Pantalla de bienvenida al abrir la app sin sesión
  function renderWelcome(){
    document.getElementById('topbarSub').textContent = 'Técnico en Emergencias Sanitarias';
    document.getElementById('screen').innerHTML = `
      <div class="home welcome" id="welcomeScreen">
        <div class="welcome-card">
          <div class="welcome-mascot mascot-idle">${mascotSVG('happy', 84)}</div>
          <h2 class="welcome-title">¡Bienvenido a TES Test!</h2>
          <p class="welcome-text">Crea una cuenta para guardar tu progreso en la nube y verlo en cualquier móvil u ordenador, o entra como invitado y se guardará solo en este dispositivo.</p>
          <button class="btn-primary" data-action="cloudView" data-args='["signup"]'>${icon('user',18)} Crear cuenta nueva</button>
          <button class="btn-secondary acc-full" data-action="cloudView" data-args='["login"]'>Iniciar sesión</button>
          <button class="acc-link welcome-guest" data-action="renderHome" data-guest="1">Continuar como invitado</button>
        </div>
      </div>`;
  }

  return {
    init, renderAccount, renderRanking, recordScore,
    setRankName(name){ const n = String(name || '').trim().slice(0, 24); if(n) updateProfile({ display_name: n }); },
    view(v){ accountView = v; accountMsg = null; renderAccount(); },
    syncNow(){ pull(); },
    async logout(){ await logout(); accountView = 'login'; accountMsg = { type:'ok', text:'Sesión cerrada. Tu progreso sigue guardado en este dispositivo.' }; renderAccount(); updateBadge(); },
    isLogged(){ return !!session; }
  };
})();

function openAccount(){ Cloud.renderAccount(); window.scrollTo(0,0); }
function cloudView(v){ Cloud.view(v); }
function cloudSyncNow(){ Cloud.syncNow(); }
function cloudLogout(){ Cloud.logout(); }
function cloudSetRankName(name){ Cloud.setRankName(name); }
