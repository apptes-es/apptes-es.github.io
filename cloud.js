'use strict';
/* ---------------- CUENTA Y NUBE (Supabase) ----------------
   Login opcional con email y contraseña. Si hay sesión, el progreso guardado en Store
   se sube a la nube y se descarga en cualquier dispositivo. Sin librerías: solo fetch. */
const SUPABASE_URL = 'https://mqdzwszearfsbracdybq.supabase.co';
const SUPABASE_KEY = 'sb_publishable_xvIkndYAPPAwVbIjMdk5ag_BeEYkTMs'; // clave pública (segura en el navegador gracias a RLS)
const SESSION_KEY = 'tes_session_v1';      // no se sincroniza
const DEVICE_MODE_KEY = 'tes_device_mode_v1'; // 'user' si alguna vez entró con cuenta aquí, 'guest' si eligió invitado
const LOCAL_STAMP_KEY = 'tes_local_updated_v1';
const DATA_OWNER_KEY = 'tes_data_owner_v1';   // de qué cuenta son los datos guardados en este dispositivo
const SYNC_KEYS = [
  'tes_test_history_v1', 'tes_failed_ids_v1', 'tes_mastered_ids_v1',
  'tes_seen_v1', 'tes_recent_tests_v1', 'tes_test_progress_v1', 'tes_stats_v1',
  'tes_qstreak_v1', 'tes_fav_v1', 'tes_srs_v1'
];
const SCORE_QUEUE_KEY = 'tes_score_queue_v1'; // puntos pendientes de subir al ranking
const ACCESS_KEY = 'tes_access_v1';          // {uid, ok, admin}: si la cuenta tiene acceso (no se sincroniza)
const ADMIN_NAME = 'Abraham';

const Cloud = (function(){
  let session = null;        // {access_token, refresh_token, expires_at, user:{id,email,user_metadata}}
  let status = 'idle';       // idle | syncing | ok | error | offline
  let lastSync = null;
  let pushTimer = null;
  let applyingRemote = false;
  let accountMsg = null;     // {type:'ok'|'error', text}
  let accountView = 'login'; // login | signup
  let access = parse(Store.getRaw(ACCESS_KEY), null);

  /* ---------- ACCESO: solo cuentas aprobadas por el administrador ---------- */
  function canUse(){ return !!(session && access && access.uid === session.user.id && access.ok); }
  function isAdmin(){ return canUse() && !!access.admin; }
  async function checkAccess(){
    if(!session) return false;
    try{
      const rows = await api('/rest/v1/profiles?select=approved,is_admin&id=eq.' + session.user.id);
      const r = (rows && rows[0]) || {};
      access = { uid: session.user.id, ok: !!(r.approved || r.is_admin), admin: !!r.is_admin };
      Store.setRaw(ACCESS_KEY, JSON.stringify(access));
    }catch(e){ /* sin red: se queda lo último que se supo */ }
    return canUse();
  }

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
  // Si varias peticiones necesitan renovar la sesión a la vez, se renueva una sola vez
  // (renovar dos veces con el mismo código puede hacer que Supabase cierre la sesión)
  let refreshing = null;
  async function ensureFreshToken(){
    if(!session) return false;
    if(session.expires_at - 60 > Date.now()/1000) return true;
    if(!refreshing){
      refreshing = (async()=>{
        try{
          const d = await api('/auth/v1/token?grant_type=refresh_token', { method:'POST', auth:false, body:{ refresh_token: session.refresh_token } });
          saveSession(fromTokenResponse(d));
          return true;
        }catch(e){
          if(e.status === 400 || e.status === 401){ saveSession(null); }
          return false;
        }finally{ setTimeout(()=>{ refreshing = null; }, 0); }
      })();
    }
    return refreshing;
  }
  // Borra del dispositivo el progreso de la cuenta (al cerrar sesión o si entra otra cuenta),
  // para que nunca se mezclen los datos de dos personas que usan el mismo móvil
  function clearLocalData(){
    applyingRemote = true;
    SYNC_KEYS.concat([LOCAL_STAMP_KEY, SCORE_QUEUE_KEY, 'tes_duel_submit_v1', DATA_OWNER_KEY]).forEach(k=>Store.remove(k));
    applyingRemote = false;
    if(typeof onLocalDataCleared === 'function') onLocalDataCleared();
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
    const newer = localNewer ? local : remote, older = localNewer ? remote : local;
    const out = Object.assign({}, older, newer);
    // Test a medias: manda el lado más reciente. Si allí ya se terminó o descartó, no se resucita.
    if(newer['tes_test_progress_v1'] === undefined) delete out['tes_test_progress_v1'];
    // Historial: unión de los dos, sin duplicados, el más reciente primero
    const hist = parse(local['tes_test_history_v1'], []).concat(parse(remote['tes_test_history_v1'], []));
    const seen = new Set(); const histMerged = [];
    hist.sort((a,b)=>(b.date||0)-(a.date||0)).forEach(h=>{
      const k = (h.date||0) + '|' + h.score + '|' + h.total + '|' + h.mode;
      if(!seen.has(k)){ seen.add(k); histMerged.push(h); }
    });
    out['tes_test_history_v1'] = JSON.stringify(histMerged.slice(0,80));
    // Preguntas dominadas: unión de los dos, menos las que están falladas ahora (al fallar se deja de dominar)
    const failedNow = new Set(parse(out['tes_failed_ids_v1'], []));
    const mastered = new Set(parse(local['tes_mastered_ids_v1'], []).concat(parse(remote['tes_mastered_ids_v1'], [])));
    out['tes_mastered_ids_v1'] = JSON.stringify(Array.from(mastered).filter(id=>!failedNow.has(id)));
    // Racha, XP y medallas: se combinan los dos lados
    const sl = parse(local['tes_stats_v1'], null), sr = parse(remote['tes_stats_v1'], null);
    if(sl && sr && typeof mergeStats === 'function') out['tes_stats_v1'] = JSON.stringify(mergeStats(sl, sr));
    return out;
  }
  function isEmptySnapshot(s){
    return !s || !Object.keys(s).some(k=>{ const v = parse(s[k], null); return v && (Array.isArray(v) ? v.length : Object.keys(v).length); });
  }
  function setStatus(s){ status = s; if(s === 'ok') lastSync = Date.now(); updateBadge(); refreshAccountIfOpen(); }

  async function pull(){
    if(!(await ensureFreshToken())) return;
    const wasOk = canUse();
    if(!(await checkAccess())){ setStatus('idle'); if(!document.getElementById('accountScreen') || accountView !== 'newpass') renderGate(); return; }
    if(!wasOk && !(document.getElementById('accountScreen') && accountView === 'newpass')) renderHome();
    const owner = Store.getRaw(DATA_OWNER_KEY);
    if(owner && owner !== session.user.id) clearLocalData();
    Store.setRaw(DATA_OWNER_KEY, session.user.id);
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
      // Solo se sube si lo de este dispositivo aporta algo que la nube no tenía
      const same = SYNC_KEYS.every(k=>final[k] === remote[k]);
      if(same) setStatus('ok'); else await push(true);
      flushScores();
      if(typeof onRemoteApplied === 'function') onRemoteApplied();
      if(typeof announceProgress === 'function') announceProgress();
      if(typeof refreshDuelInbox === 'function') refreshDuelInbox();
      if(typeof afterSync === 'function') afterSync();
    }catch(e){
      applyingRemote = false;
      setStatus(navigator.onLine === false ? 'offline' : 'error');
    }
  }
  async function push(immediate){
    if(pushTimer){ clearTimeout(pushTimer); pushTimer = null; }
    if(!immediate){ pushTimer = setTimeout(()=>push(true), 2500); return; }
    if(!canUse()) return false;
    if(!(await ensureFreshToken())) return false;
    setStatus('syncing');
    try{
      const stamp = Number(Store.getRaw(LOCAL_STAMP_KEY) || Date.now());
      await api('/rest/v1/user_data?on_conflict=user_id', {
        method:'POST', headers:{ Prefer:'resolution=merge-duplicates,return=minimal' },
        body:{ user_id: session.user.id, data:{ keys: localSnapshot(), stamp }, updated_at: new Date().toISOString() }
      });
      setStatus('ok');
      return true;
    }catch(e){ setStatus(navigator.onLine === false ? 'offline' : 'error'); return false; }
  }
  Store.onChange(key=>{
    if(applyingRemote || SYNC_KEYS.indexOf(key) === -1) return;
    Store.setRaw(LOCAL_STAMP_KEY, String(Date.now()));
    if(canUse()) push(false);
  });
  window.addEventListener('pagehide', ()=>{ if(pushTimer && session){ push(true); } });
  window.addEventListener('online', ()=>{ if(session) pull(); });

  /* ---------- RANKING SEMANAL ---------- */
  function recordScore(entry){
    if(!canUse()) return;   // sin acceso no se puntúa
    const q = Store.get(SCORE_QUEUE_KEY, []);
    q.push(Object.assign({ at: new Date().toISOString() }, entry));
    Store.set(SCORE_QUEUE_KEY, q.slice(-50));
    flushScores();
  }
  let flushing = false;
  async function flushScores(){
    if(flushing || !canUse()) return;
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
  let rankView = 'week';   // week: puntos de esta semana · all: experiencia total
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
        api('/rest/v1/rpc/weekly_ranking_v3', { method:'POST', body:{} })
          .catch(()=>api('/rest/v1/rpc/weekly_ranking_v2', { method:'POST', body:{} }))
      ]);
      rankingProfile = (prof && prof[0]) || { display_name: displayName() };
      if(!box.isConnected) return;
      const me = rows.find(r=>r.is_me);
      const allTime = rankView === 'all' && rows.length && rows[0].xp != null;
      const shown = allTime
        ? rows.slice().sort((a,b)=>(b.xp||0) - (a.xp||0)).map((r,i)=>Object.assign({}, r, { rank: i + 1, points: r.xp || 0 }))
        : rows;
      const list = shown.length ? shown.map(r=>{
        // Número de posición dentro de un círculo con el color y la medalla del rango de cada uno
        const top = (r.rank <= 3 && r.points > 0) ? ' top' + r.rank : '';
        const medal = (r.xp != null && typeof rankFor === 'function')
          ? (ri => `<button type="button" class="rank-orb pc-rank rank-${ri.idx}${top}" data-action="showRankInfo" data-args="${escapeHtml(JSON.stringify([r.display_name, ri.rank.name, r.xp]))}" aria-label="${escapeHtml(r.display_name + ': ' + ri.rank.name)}">${r.rank}<i class="rank-orb-icon">${icon(ri.rank.icon, 10)}</i></button>`)(rankFor(r.xp))
          : (top ? `<span class="rank-medal m${r.rank}">${r.rank}</span>` : `<span class="rank-pos">${r.rank}</span>`);
        const streak = r.streak > 0 ? ` <span class="rank-streak" title="Racha de ${r.streak} ${r.streak == 1 ? 'día' : 'días'}">${icon('flame',12)}${r.streak}</span>` : '';
        return `<li class="${r.is_me ? 'me' : ''}">${medal}<span class="rank-name">${escapeHtml(r.display_name)}${r.is_me ? ' <em>(tú)</em>' : ''}${streak}</span>
          <span class="rank-tests">${allTime ? 'XP' : r.tests + ' ' + (r.tests == 1 ? 'test' : 'tests')}</span><b class="rank-pts">${r.points}</b></li>`;
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
        <div class="rank-views" role="tablist">
          <button type="button" class="${allTime ? '' : 'on'}" data-action="cloudRankView" data-args='["week"]'>Esta semana</button>
          <button type="button" class="${allTime ? 'on' : ''}" data-action="cloudRankView" data-args='["all"]'>De siempre</button>
        </div>
        ${list ? `<ol class="rank-list">${list}</ol>` : `<p class="empty-hint">Todavía no hay nadie en el ranking.</p>`}
        <p class="rank-rules">1 punto por cada acierto (las preguntas que ya dominas valen la mitad) · +10 por aprobar un simulacro de 20 preguntas o más. Solo cuentan los tests hechos con la sesión iniciada. ${icon('flame',12)} = días seguidos estudiando.</p>`;
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
  // Recuperar contraseña: Supabase envía un email con un enlace que vuelve a la app
  function recover(email){
    const back = location.origin + location.pathname;
    return api('/auth/v1/recover?redirect_to=' + encodeURIComponent(back), { method:'POST', auth:false, body:{ email } });
  }
  async function setNewPassword(password){
    if(!(await ensureFreshToken())) throw new Error('Sesión caducada. Pide otro enlace.');
    await api('/auth/v1/user', { method:'PUT', body:{ password } });
  }
  // Al volver del enlace del email, la dirección trae #access_token=...&type=recovery
  async function captureRecoveryFromUrl(){
    if(!location.hash || location.hash.length < 2) return false;
    let p;
    try{ p = new URLSearchParams(location.hash.slice(1)); }catch(e){ return false; }
    const clean = ()=>{ try{ history.replaceState(null, '', location.pathname + location.search); }catch(e){} };
    if(p.get('error_description')){
      clean();
      accountView = 'recover';
      accountMsg = { type:'error', text:'El enlace no es válido o ha caducado. Pide uno nuevo.' };
      renderAccount();
      return true;
    }
    if(p.get('type') !== 'recovery' || !p.get('access_token')) return false;
    clean();
    try{
      const token = p.get('access_token');
      const user = await api('/auth/v1/user', { auth:false, headers:{ Authorization: 'Bearer ' + token } });
      saveSession({ access_token: token, refresh_token: p.get('refresh_token'),
        expires_at: Number(p.get('expires_at')) || (Math.floor(Date.now()/1000) + (Number(p.get('expires_in')) || 3600)), user });
      accountView = 'newpass'; accountMsg = null;
    }catch(e){
      accountView = 'recover';
      accountMsg = { type:'error', text:'El enlace no es válido o ha caducado. Pide uno nuevo.' };
    }
    updateBadge(); renderAccount();
    return true;
  }
  // Aviso de pregunta con error: lo puede mandar cualquiera, con o sin cuenta
  async function report(questionId, note){
    if(session) await ensureFreshToken();
    return api('/rest/v1/question_reports', { method:'POST', headers:{ Prefer:'return=minimal' },
      body:{ question_id: String(questionId).slice(0, 40), note: note ? String(note).slice(0, 500) : null } });
  }
  async function logout(){
    if(typeof beforeLogout === 'function'){ try{ await beforeLogout(); }catch(e){} }
    // Antes de salir se sube todo lo pendiente; después se borra del dispositivo
    let synced = false;
    if(canUse()){ try{ await flushScores(); synced = await push(true); }catch(e){} }
    try{ await api('/auth/v1/logout', { method:'POST' }); }catch(e){}
    saveSession(null);
    access = null; Store.remove(ACCESS_KEY);
    // Si no se pudo subir (sin internet), se deja en el dispositivo: se sube al volver a entrar con esa cuenta,
    // y si entra otra cuenta se borra antes de mezclar nada (DATA_OWNER_KEY)
    if(synced) clearLocalData();
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
    if(session && accountView !== 'newpass' && !canUse()){ renderBlocked(); return; }
    if(session && accountView === 'newpass'){
      inner = `
        <div class="section-label">Nueva contraseña</div>
        <p class="empty-hint">Escribe la contraseña nueva para ${escapeHtml(session.user.email || 'tu cuenta')}.</p>
        ${msgHtml()}
        <form data-form="newpass" class="acc-form">
          <label>Contraseña nueva<input name="password" type="password" minlength="6" autocomplete="new-password" required></label>
          <button class="btn-primary" type="submit">Guardar contraseña</button>
        </form>`;
    } else if(session){
      inner = `
        <div class="acc-card">
          <div class="acc-avatar">${icon('user', 26)}</div>
          <div class="acc-name">${escapeHtml(displayName())}</div>
          <div class="acc-email">${escapeHtml(session.user.email || '')}</div>
          <div class="acc-status ${status}">${escapeHtml(statusText())}</div>
        </div>
        ${msgHtml()}
        <div id="duelInboxBox">${typeof duelInboxHtml === 'function' ? duelInboxHtml() : ''}</div>
        ${typeof pushCardHtml === 'function' ? pushCardHtml() : ''}
        <p class="empty-hint">Tu historial, falladas, logros y el test a medias se guardan en tu cuenta. Entra con el mismo email en otro móvil u ordenador y lo tendrás todo.</p>
        <button class="btn-primary" data-action="cloudSyncNow">${icon('route',18)} Sincronizar ahora</button>
        ${isAdmin() ? `<button class="btn-secondary acc-full" data-action="openAdmin">${icon('shield',18)} Gestionar accesos</button>` : ''}
        ${typeof coffeeCardHtml === 'function' ? coffeeCardHtml() : ''}
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
    } else if(accountView === 'recover'){
      inner = `
        <div class="section-label">Recuperar contraseña</div>
        <p class="empty-hint">Escribe el email de tu cuenta y te mandamos un enlace para poner una contraseña nueva.</p>
        ${msgHtml()}
        <form data-form="recover" class="acc-form">
          <label>Email<input name="email" type="email" autocomplete="email" required></label>
          <button class="btn-primary" type="submit">Enviar enlace</button>
        </form>
        <p class="empty-hint acc-forgot">Si no te llega en unos minutos (mira también en spam), pide al administrador de la app que te la restablezca.</p>
        <button class="acc-link" data-action="cloudView" data-args='["login"]'>Volver a iniciar sesión</button>`;
    } else {
      inner = `
        <div class="section-label">Iniciar sesión</div>
        <p class="empty-hint">Entra con tu cuenta para usar la app. Si no tienes acceso, contacta con el administrador (${ADMIN_NAME}).</p>
        ${msgHtml()}
        <form data-form="login" class="acc-form">
          <label>Email<input name="email" type="email" autocomplete="email" required></label>
          <label>Contraseña<input name="password" type="password" autocomplete="current-password" required></label>
          <button class="btn-primary" type="submit">Entrar</button>
        </form>
        <button class="acc-link" data-action="cloudView" data-args='["recover"]'>¿Has olvidado la contraseña?</button>
        <button class="btn-secondary acc-full" data-action="cloudView" data-args='["signup"]'>Crear cuenta nueva</button>`;
    }
    document.getElementById('screen').innerHTML = `
      <div class="home" id="accountScreen">
        ${canUse() ? `<button class="back-link" data-action="renderHome">${icon('chevronLeft',16)} Inicio</button>` : ''}
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
    },
    async recover(f){
      await recover(f.email.value.trim());
      accountMsg = { type:'ok', text:'Si ese email tiene cuenta, te hemos mandado un enlace. Ábrelo desde este mismo dispositivo.' };
    },
    async newpass(f){
      await setNewPassword(f.password.value);
      accountView = 'login';
      accountMsg = { type:'ok', text:'Contraseña cambiada. Ya estás dentro.' };
      pull();
    }
  };
  document.addEventListener('submit', async e=>{
    const f = e.target.closest('form[data-form]');
    if(!f || !FORMS[f.dataset.form]) return;
    e.preventDefault();
    accountMsg = null;
    setBusy(f, true);
    try{
      await FORMS[f.dataset.form](f);
      updateBadge();
      if(canUse() && (f.dataset.form === 'login' || f.dataset.form === 'signup')){ accountMsg = null; renderHome(); toast('¡Dentro! Tu progreso ya está sincronizado.'); }
      else renderAccount();
    }
    catch(err){ accountMsg = { type:'error', text: friendlyError(err) }; renderAccount(); }
  });


  let onRemoteApplied = null;
  async function init(onApplied){
    onRemoteApplied = onApplied;
    session = parse(Store.getRaw(SESSION_KEY), null);
    updateBadge();
    if(await captureRecoveryFromUrl()) return;
    if(session){ if(!canUse()) renderGate(); pull(); return; }
    renderGate();
  }

  // Lo que ve quien no puede usar la app: entrar/crear cuenta, o el aviso de cuenta sin acceso
  function renderGate(){
    if(typeof clearTimer === 'function') clearTimer();
    if(session){ renderBlocked(); return; }
    if(Store.getRaw(DEVICE_MODE_KEY) === 'user'){
      accountView = 'login';
      if(!accountMsg) accountMsg = { type:'ok', text:'¡Hola de nuevo! Inicia sesión para entrar.' };
      renderAccount();
      return;
    }
    renderWelcome();
  }
  function renderBlocked(){
    document.getElementById('topbarSub').textContent = 'Acceso restringido';
    const checking = !access || access.uid !== session.user.id;
    document.getElementById('screen').innerHTML = `
      <div class="home welcome" id="gateScreen">
        <div class="welcome-card">
          <div class="welcome-mascot">${mascotSVG('sad', 84)}</div>
          <h2 class="welcome-title">${checking ? 'Comprobando acceso…' : 'Sin acceso'}</h2>
          <p class="welcome-text">${checking ? 'Un momento, estamos comprobando tu cuenta.' : `Contacta con el administrador para seguir usando la app (${ADMIN_NAME}).`}</p>
          <div class="acc-email">${escapeHtml(session.user.email || '')}</div>
          <button class="btn-primary" data-action="cloudSyncNow">Comprobar de nuevo</button>
          <button class="btn-secondary acc-full" data-action="cloudLogout">Cerrar sesión</button>
        </div>
      </div>`;
  }

  /* ---------- PANEL DEL ADMINISTRADOR ---------- */
  async function renderAdmin(){
    if(!isAdmin()){ renderGate(); return; }
    if(typeof clearTimer === 'function') clearTimer();
    document.getElementById('topbarSub').textContent = 'Gestionar accesos';
    document.getElementById('screen').innerHTML = `
      <div class="home" id="adminScreen">
        <button class="back-link" data-action="openAccount">${icon('chevronLeft',16)} Mi cuenta</button>
        <div class="section-label">Accesos a la app</div>
        <p class="empty-hint">Las cuentas sin acceso no pueden usar la app, pero su progreso sigue guardado. Si les das acceso, lo recuperan todo.</p>
        <div id="adminBox"><p class="empty-hint">Cargando…</p></div>
        <div class="section-label">Avisos de error en preguntas</div>
        <div id="reportsBox"><p class="empty-hint">Cargando…</p></div>
      </div>`;
    renderReports();
    const box = document.getElementById('adminBox');
    try{
      await ensureFreshToken();
      const users = await api('/rest/v1/rpc/admin_users', { method:'POST', body:{} });
      const n = users.filter(u=>u.approved || u.is_admin).length;
      if(!box.isConnected) return;
      box.innerHTML = `<p class="admin-count">${n} con acceso · ${users.length - n} sin acceso</p><ul class="admin-list">` + users.map(u=>{
        const ok = u.approved || u.is_admin;
        const last = u.last_sign_in_at ? new Date(u.last_sign_in_at).toLocaleDateString('es-ES') : '—';
        return `<li class="admin-row ${ok ? 'ok' : 'off'}">
          <div class="admin-info"><b>${escapeHtml(u.display_name || 'Sin nombre')}</b>
            <span>${escapeHtml(u.email || '')}</span>
            <span>${u.tests} tests · último acceso ${last}</span></div>
          ${u.is_admin ? '<span class="admin-tag">Admin</span>'
            : `<button class="${ok ? 'btn-secondary' : 'btn-primary'} admin-btn" data-action="adminSetAccess" data-args='${JSON.stringify([u.id, !ok])}'>${ok ? 'Quitar' : 'Dar acceso'}</button>`}
        </li>`;
      }).join('') + '</ul>';
    }catch(e){
      if(box.isConnected) box.innerHTML = `<p class="empty-hint">No se pudo cargar la lista. ${escapeHtml(friendlyError(e))}</p>`;
    }
  }
  async function renderReports(){
    const box = document.getElementById('reportsBox');
    if(!box) return;
    try{
      await ensureFreshToken();
      const reps = await api('/rest/v1/rpc/admin_reports', { method:'POST', body:{} });
      if(!box.isConnected) return;
      if(!reps.length){ box.innerHTML = '<p class="empty-hint">No hay avisos pendientes. 👌</p>'; return; }
      box.innerHTML = '<ul class="report-list">' + reps.map(r=>{
        const q = typeof findQuestionById === 'function' ? findQuestionById(r.question_id) : null;
        const subj = q ? getSubject(q.subject).short : '';
        const right = q ? q.options[q.correct] : '';
        return `<li class="report-row">
          <div class="report-q"><span>${escapeHtml(r.question_id)}${subj ? ' · ' + escapeHtml(subj) : ''}</span>
            <b>${escapeHtml(q ? q.text : 'Pregunta que ya no está en el banco')}</b>
            ${q ? `<small>Respuesta marcada como correcta: ${escapeHtml(right)}</small>` : ''}</div>
          <p class="report-note">${r.note ? '«' + escapeHtml(r.note) + '»' : '<em>Sin comentario</em>'}</p>
          <div class="report-foot"><span>${escapeHtml(r.reporter)} · ${new Date(r.created_at).toLocaleDateString('es-ES')}</span>
            <button class="btn-mini" data-action="adminResolveReport" data-args='${JSON.stringify([r.id])}'>Revisado</button></div>
        </li>`;
      }).join('') + '</ul>';
    }catch(e){
      if(box.isConnected) box.innerHTML = `<p class="empty-hint">No se pudieron cargar los avisos. ${escapeHtml(friendlyError(e))}</p>`;
    }
  }
  async function resolveReport(id){
    try{ await ensureFreshToken(); await api('/rest/v1/rpc/admin_resolve_report', { method:'POST', body:{ p_id: id } }); toast('Aviso marcado como revisado'); }
    catch(e){ toast('No se pudo marcar: ' + friendlyError(e)); }
    renderReports();
  }
  async function adminSet(id, ok){
    try{
      await ensureFreshToken();
      await api('/rest/v1/rpc/admin_set_access', { method:'POST', body:{ p_id: id, p_ok: !!ok } });
      toast(ok ? 'Acceso concedido' : 'Acceso retirado');
    }catch(e){ toast('No se pudo cambiar: ' + friendlyError(e)); }
    renderAdmin();
  }

  // Pantalla de bienvenida al abrir la app sin sesión
  function renderWelcome(){
    document.getElementById('topbarSub').textContent = 'Técnico en Emergencias Sanitarias';
    document.getElementById('screen').innerHTML = `
      <div class="home welcome" id="welcomeScreen">
        <div class="welcome-card">
          <div class="welcome-mascot mascot-idle">${mascotSVG('happy', 84)}</div>
          <h2 class="welcome-title">¡Bienvenido a TES Test!</h2>
          <p class="welcome-text">Inicia sesión con tu cuenta para usar la app. Si no tienes acceso, contacta con el administrador (${ADMIN_NAME}).</p>
          <button class="btn-primary" data-action="cloudView" data-args='["login"]'>${icon('user',18)} Iniciar sesión</button>
          <button class="btn-secondary acc-full" data-action="cloudView" data-args='["signup"]'>Crear cuenta nueva</button>
        </div>
      </div>`;
  }

  return {
    // Carga la sesión guardada sin red (para pintar la portada ya sabiendo si hay cuenta)
    loadSession(){ session = parse(Store.getRaw(SESSION_KEY), null); },
    init, renderAccount, renderRanking, recordScore, report, canUse, renderGate, renderAdmin, adminSet, resolveReport,
    setRankView(v){ rankView = v === 'all' ? 'all' : 'week'; renderRanking(document.getElementById('rankingBox')); },
    async freshToken(){ return (await ensureFreshToken()) && session ? session.access_token : null; },
    setRankName(name){ const n = String(name || '').trim().slice(0, 24); if(n) updateProfile({ display_name: n }); },
    view(v){ accountView = v; accountMsg = null; renderAccount(); },
    syncNow(){ pull(); },
    async rpc(name, body){
      if(!session) throw new Error('not_logged');
      const fresh = await ensureFreshToken();
      if(!session) throw new Error('not_logged');
      if(!fresh) throw new Error('network');
      return api('/rest/v1/rpc/' + name, { method:'POST', body: body || {} });
    },
    async logout(){ await logout(); accountView = 'login'; accountMsg = { type:'ok', text:'Sesión cerrada. Tu progreso está guardado en tu cuenta.' }; renderAccount(); updateBadge(); },
    isLogged(){ return !!session; },
    isAdmin, userId(){ return session && session.user ? session.user.id : null; }
  };
})();

function openAccount(){ Cloud.renderAccount(); window.scrollTo(0,0); }
function cloudView(v){ Cloud.view(v); }
function cloudSyncNow(){ Cloud.syncNow(); }
function cloudLogout(){ Cloud.logout(); }
function cloudSetRankName(name){ Cloud.setRankName(name); }
function openAdmin(){ Cloud.renderAdmin(); window.scrollTo(0,0); }
function adminSetAccess(id, ok){ Cloud.adminSet(id, ok); }
function adminResolveReport(id){ Cloud.resolveReport(id); }
function cloudRankView(v){ Cloud.setRankView(v); }
