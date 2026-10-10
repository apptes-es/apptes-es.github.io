'use strict';
/* ---------------- RACHA, RANGOS, CALENDARIO, EFECTOS Y DUELOS ----------------
   Todo lo que hace la app más "de juego". Usa funciones de app.js y cloud.js
   solo cuando se llaman (no al cargar), así que el orden de los scripts no importa. */

/* ---------- ESTADÍSTICAS PERSISTENTES ----------
   El historial solo guarda los 80 últimos tests; aquí se acumula lo que no debe perderse:
   puntos de experiencia (XP), días estudiados, medallas ya ganadas y duelos ganados. */
const STATS_KEY = 'tes_stats_v1';
const PENDING_DUEL_KEY = 'tes_pending_duel_v1';

function dayKey(ts){
  const d = new Date(ts);
  return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
}
function pointsForEntry(h){
  const total = h.total || 0;
  return (h.score || 0) + ((h.mode === 'subject' && total && h.score >= passScoreFor(total)) ? 10 : 0);
}
function normalizeStats(st){
  st = (st && typeof st === 'object') ? st : {};
  st.xp = Math.max(0, Number(st.xp) || 0);
  st.days = (st.days && typeof st.days === 'object') ? st.days : {};
  st.badges = Array.isArray(st.badges) ? st.badges : [];
  st.duelsWon = Array.isArray(st.duelsWon) ? st.duelsWon : [];
  st.bestStreak = Math.max(0, Number(st.bestStreak) || 0);
  return st;
}
function backfillStats(){
  const st = normalizeStats({});
  loadHistory().forEach(h=>{
    if(!h || !h.date) return;
    const d = st.days[dayKey(h.date)] || (st.days[dayKey(h.date)] = {t:0, c:0});
    d.t++; d.c += h.score || 0;
    st.xp += pointsForEntry(h);
  });
  st.bestStreak = streakInfo(st.days).best;
  return st;
}
function loadStats(){
  const raw = Store.get(STATS_KEY, null);
  if(!raw){ const st = backfillStats(); Store.set(STATS_KEY, st); return st; }
  return normalizeStats(raw);
}
function saveStats(st){ Store.set(STATS_KEY, st); }
// Une las estadísticas de dos dispositivos sin perder nada
function mergeStats(a, b){
  a = normalizeStats(a); b = normalizeStats(b);
  const days = Object.assign({}, a.days);
  Object.keys(b.days).forEach(k=>{
    const x = days[k], y = b.days[k];
    days[k] = !x ? y : { t: Math.max(x.t||0, y.t||0), c: Math.max(x.c||0, y.c||0) };
  });
  return {
    xp: Math.max(a.xp, b.xp), days,
    badges: Array.from(new Set(a.badges.concat(b.badges))),
    duelsWon: Array.from(new Set(a.duelsWon.concat(b.duelsWon))),
    bestStreak: Math.max(a.bestStreak, b.bestStreak)
  };
}
// Se llama al terminar cada test
function recordTestStats(entry){
  const st = loadStats();
  const before = { xp: st.xp, streak: streakInfo(st.days).current, studiedToday: !!(st.days[dayKey(Date.now())]) };
  const k = dayKey(entry.date);
  const d = st.days[k] || (st.days[k] = {t:0, c:0});
  d.t++; d.c += entry.score || 0;
  const gained = pointsForEntry(entry);
  st.xp += gained;
  const si = streakInfo(st.days);
  st.bestStreak = Math.max(st.bestStreak, si.best);
  saveStats(st);
  return { gained, xpBefore: before.xp, xpAfter: st.xp, streakBefore: before.streak, streakAfter: si.current,
    firstToday: !before.studiedToday };
}

/* ---------- RACHA ---------- */
function streakInfo(days){
  days = days || loadStats().days;
  const keys = Object.keys(days).filter(k=>days[k] && days[k].t > 0).sort();
  const set = new Set(keys);
  // mejor racha
  let best = 0, run = 0, prev = null;
  keys.forEach(k=>{
    const d = parseDay(k);
    run = (prev && Math.round((d - prev) / 86400000) === 1) ? run + 1 : 1;
    if(run > best) best = run;
    prev = d;
  });
  // racha actual: cuenta hacia atrás desde hoy (o desde ayer, si hoy aún no se ha estudiado)
  const today = todayStart();
  const cursor = new Date(today);
  const studiedToday = set.has(dayKey(cursor));
  if(!studiedToday) cursor.setDate(cursor.getDate() - 1);
  let current = 0;
  while(set.has(dayKey(cursor))){ current++; cursor.setDate(cursor.getDate() - 1); }
  return { current, best, studiedToday, atRisk: current > 0 && !studiedToday };
}

/* ---------- RANGOS ---------- */
const RANKS = [
  { min: 0,    name: 'Alumno en prácticas',      icon: 'book' },
  { min: 100,  name: 'Técnico novato',           icon: 'pulse' },
  { min: 300,  name: 'Técnico',                  icon: 'heart' },
  { min: 700,  name: 'Técnico veterano',         icon: 'shield' },
  { min: 1300, name: 'Jefe de dotación',         icon: 'truck' },
  { min: 2200, name: 'Coordinador 112',          icon: 'siren' },
  { min: 3500, name: 'Leyenda de la ambulancia', icon: 'medal' }
];
function rankFor(xp){
  let idx = 0;
  RANKS.forEach((r,i)=>{ if(xp >= r.min) idx = i; });
  const rank = RANKS[idx], next = RANKS[idx+1] || null;
  const pct = next ? Math.round((xp - rank.min) / (next.min - rank.min) * 100) : 100;
  return { idx, rank, next, pct, toNext: next ? next.min - xp : 0 };
}

/* ---------- TARJETA DEL JUGADOR (portada) ---------- */
function playerCardHtml(){
  const st = loadStats();
  const si = streakInfo(st.days);
  const r = rankFor(st.xp);
  const streakTxt = si.current
    ? (si.atRisk ? `¡Haz un test hoy o pierdes la racha de ${si.current} ${si.current===1?'día':'días'}!` : '¡Hoy ya has estudiado! Vuelve mañana para seguir.')
    : 'Haz un test hoy para empezar una racha.';
  return `
    <button type="button" class="player-card" data-action="switchHomeTab" data-args='["progreso"]' aria-label="Ver tu progreso">
      <div class="pc-rank rank-${r.idx}">${icon(r.rank.icon, 24)}</div>
      <div class="pc-body">
        <div class="pc-top"><b>${escapeHtml(r.rank.name)}</b><span>${st.xp} XP</span></div>
        <div class="pc-bar"><div style="width:${r.pct}%"></div></div>
        <div class="pc-next">${r.next ? `${r.toNext} XP para <b>${escapeHtml(r.next.name)}</b>` : '¡Rango máximo alcanzado!'}</div>
      </div>
      <div class="pc-streak ${si.current ? (si.atRisk ? 'risk' : 'on') : 'off'}" title="${escapeHtml(streakTxt)}">
        <span class="flame">${icon('flame', 22)}</span><b>${si.current}</b><small>${si.current===1?'día':'días'}</small>
      </div>
    </button>
    <p class="pc-hint">${icon('flame',13)} ${escapeHtml(streakTxt)}</p>`;
}

/* ---------- CALENDARIO DE ESTUDIO ---------- */
let calOffset = 0;
function calendarHtml(){
  const st = loadStats();
  const si = streakInfo(st.days);
  const base = todayStart();
  const first = new Date(base.getFullYear(), base.getMonth() + calOffset, 1);
  const daysInMonth = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
  const lead = (first.getDay() + 6) % 7; // lunes primero
  const todayK = dayKey(base);
  let cells = '', studied = 0, tests = 0;
  for(let i=0;i<lead;i++) cells += '<span class="cal-cell empty"></span>';
  for(let d=1; d<=daysInMonth; d++){
    const k = dayKey(new Date(first.getFullYear(), first.getMonth(), d));
    const info = st.days[k];
    const t = info ? info.t : 0;
    if(t){ studied++; tests += t; }
    const lvl = t >= 4 ? 3 : t >= 2 ? 2 : t >= 1 ? 1 : 0;
    const label = `${d}: ${t ? t + (t===1?' test':' tests') + ', ' + (info.c||0) + ' aciertos' : 'sin estudiar'}`;
    cells += `<span class="cal-cell l${lvl} ${k===todayK?'today':''}" title="${label}" aria-label="${label}">${d}</span>`;
  }
  const monthName = first.toLocaleDateString('es-ES', { month:'long', year:'numeric' });
  return `
    <div class="cal-card">
      <div class="cal-head">
        <button class="cal-nav" data-action="calMove" data-args='[-1]' aria-label="Mes anterior">${icon('chevronLeft',16)}</button>
        <b>${escapeHtml(monthName)}</b>
        <button class="cal-nav" data-action="calMove" data-args='[1]' ${calOffset>=0?'disabled':''} aria-label="Mes siguiente">${icon('chevronRight',16)}</button>
      </div>
      <div class="cal-grid cal-dow"><span>L</span><span>M</span><span>X</span><span>J</span><span>V</span><span>S</span><span>D</span></div>
      <div class="cal-grid">${cells}</div>
      <div class="cal-stats">
        <div><b>${si.current}</b><span>racha actual</span></div>
        <div><b>${Math.max(si.best, st.bestStreak)}</b><span>mejor racha</span></div>
        <div><b>${studied}</b><span>días este mes</span></div>
        <div><b>${tests}</b><span>tests este mes</span></div>
      </div>
      <div class="cal-legend"><span>Menos</span><i class="l0"></i><i class="l1"></i><i class="l2"></i><i class="l3"></i><span>Más</span></div>
    </div>`;
}
function calMove(delta){ calOffset = Math.min(0, calOffset + delta); renderHome(); }
function ranksListHtml(){
  const xp = loadStats().xp;
  const cur = rankFor(xp).idx;
  return '<div class="ranks-list">' + RANKS.map((r,i)=>`
    <div class="rank-step ${i<=cur?'done':''} ${i===cur?'current':''}">
      <div class="pc-rank rank-${i}">${icon(r.icon, 18)}</div>
      <div><b>${escapeHtml(r.name)}</b><span>${r.min} XP</span></div>
    </div>`).join('') + '</div>';
}

/* ---------- EFECTOS ---------- */
function prefersReducedMotion(){ return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); }
function vibrate(pattern){ try{ if(navigator.vibrate) navigator.vibrate(pattern); }catch(e){} }
function burstConfetti(count){
  if(prefersReducedMotion() || typeof requestAnimationFrame === 'undefined') return;
  const c = document.createElement('canvas');
  c.className = 'confetti-canvas';
  document.body.appendChild(c);
  const ctx = c.getContext('2d');
  if(!ctx){ c.remove(); return; }
  const dpr = window.devicePixelRatio || 1, W = window.innerWidth, H = window.innerHeight;
  c.width = W * dpr; c.height = H * dpr; ctx.scale(dpr, dpr);
  const colors = ['#F5C518','#2FA35B','#2F8CFF','#E0312B','#FFFFFF','#FF8A3D'];
  const parts = [];
  count = count || 140;
  for(let i=0;i<count;i++){
    const fromLeft = i % 2 === 0;
    parts.push({
      x: fromLeft ? -10 : W + 10, y: H * (0.55 + Math.random()*0.25),
      vx: (fromLeft ? 1 : -1) * (5 + Math.random()*9), vy: -(9 + Math.random()*11),
      w: 6 + Math.random()*7, h: 4 + Math.random()*5, r: Math.random()*6, vr: (Math.random()-0.5)*0.35,
      col: colors[i % colors.length]
    });
  }
  const start = performance.now(), LIFE = 2800;
  function frame(now){
    const el = now - start;
    ctx.clearRect(0, 0, W, H);
    parts.forEach(p=>{
      p.vy += 0.32; p.vx *= 0.985; p.x += p.vx; p.y += p.vy; p.r += p.vr;
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.r);
      ctx.globalAlpha = Math.max(0, 1 - el / LIFE);
      ctx.fillStyle = p.col; ctx.fillRect(-p.w/2, -p.h/2, p.w, p.h);
      ctx.restore();
    });
    if(el < LIFE) requestAnimationFrame(frame); else c.remove();
  }
  requestAnimationFrame(frame);
}
function comboHtml(combo){
  if(combo < 3) return '';
  let cls = 'c3', txt = `¡${combo} seguidas! Ritmo constante`, ic = 'pulse';
  if(combo >= 10){ cls = 'c10'; txt = `x${combo} · ¡Imparable!`; ic = 'flame'; }
  else if(combo >= 5){ cls = 'c5'; txt = `x${combo} · ¡En racha!`; ic = 'flame'; }
  return `<div class="combo-badge ${cls}">${icon(ic,15)} ${txt}</div>`;
}

/* ---------- DUELOS 1 CONTRA 1 ---------- */
const DUEL_SIZE = 10;
const DUEL_ERRORS = {
  not_found: 'No existe ningún duelo con ese código.',
  full: 'Ese duelo ya tiene dos jugadores.',
  expired: 'Ese duelo ha caducado (duran 14 días).',
  too_many: 'Has creado muchos duelos hoy. Prueba mañana.',
  not_logged: 'Necesitas iniciar sesión para jugar duelos.',
  bad_questions: 'No se pudo preparar el duelo.'
};
function duelError(e){
  const m = (e && e.message) || '';
  const key = Object.keys(DUEL_ERRORS).find(k=>m.includes(k));
  if(key) return DUEL_ERRORS[key];
  if(/fetch|network/i.test(m)) return 'Sin conexión. Revisa tu internet.';
  return 'No se pudo completar. Inténtalo de nuevo.';
}
function duelLink(code){ return location.origin + location.pathname.replace(/index\.html$/, '') + '?duelo=' + code; }
function duelOutcome(s){
  if(s.my_score == null || s.their_score == null) return null;
  if(s.my_score !== s.their_score) return s.my_score > s.their_score ? 'win' : 'lose';
  if(s.my_ms != null && s.their_ms != null && s.my_ms !== s.their_ms) return s.my_ms < s.their_ms ? 'win' : 'lose';
  return 'tie';
}
function fmtMs(ms){ if(ms == null) return ''; const s = Math.round(ms/1000); return Math.floor(s/60) + ':' + String(s%60).padStart(2,'0'); }
function duelSubjects(){ return SUBJECTS.filter(s=>questionsOf(s.id).filter(q=>!q.u).length >= DUEL_SIZE); }
let duelMsg = null;

function renderDuelsTab(box){
  if(!box) return;
  if(!Cloud.isLogged()){
    box.innerHTML = `
      <div class="rank-empty">
        <div class="rank-trophy">${icon('award', 30)}</div>
        <b>Duelos 1 contra 1</b>
        <p class="empty-hint">Reta a un compañero a las mismas ${DUEL_SIZE} preguntas y a ver quién saca más. Para jugar necesitas una cuenta.</p>
        <button class="btn-primary" data-action="cloudView" data-args='["signup"]'>Crear cuenta</button>
        <button class="acc-link" data-action="cloudView" data-args='["login"]'>Ya tengo cuenta · Iniciar sesión</button>
      </div>`;
    return;
  }
  const pending = Store.getRaw(PENDING_DUEL_KEY);
  const subs = duelSubjects();
  box.innerHTML = `
    ${duelMsg ? `<div class="acc-msg ${duelMsg.type}">${escapeHtml(duelMsg.text)}</div>` : ''}
    ${pending ? `
      <div class="duel-invite">
        <div>${icon('award',20)} <b>¡Te han retado!</b><span>Duelo ${escapeHtml(pending)}</span></div>
        <button class="btn-mini" data-action="acceptPendingDuel">Aceptar reto</button>
      </div>` : ''}
    <div class="duel-new">
      <div class="section-label">Nuevo duelo</div>
      <p class="empty-hint">Juegas ${DUEL_SIZE} preguntas y luego mandas el enlace a tu rival. Gana quien acierte más; si empatáis, el más rápido.</p>
      <label class="duel-field">Asignatura
        <select id="duelSubject">${subs.map(s=>`<option value="${s.id}">${escapeHtml(s.name)}</option>`).join('')}</select>
      </label>
      <button class="btn-primary" data-action="createDuel" ${subs.length?'':'disabled'}>${icon('award',18)} Crear duelo y jugar</button>
    </div>
    <div class="duel-join">
      <div class="section-label">Unirme con un código</div>
      <div class="duel-join-row">
        <input type="text" id="duelCode" maxlength="6" placeholder="Ej. K7P2QX" autocomplete="off" autocapitalize="characters">
        <button class="btn-mini" data-action="joinDuelFromInput">Unirme</button>
      </div>
    </div>
    <div class="section-label">Mis duelos</div>
    <div id="duelList"><p class="empty-hint">Cargando duelos…</p></div>`;
  duelMsg = null;
  loadDuelList();
}
async function loadDuelList(){
  const el = document.getElementById('duelList');
  if(!el) return;
  try{
    const list = await Cloud.rpc('my_duels', {});
    if(!el.isConnected) return;
    (list || []).forEach(noteDuelWin);
    if(!list || !list.length){ el.innerHTML = '<p class="empty-hint">Todavía no has jugado ningún duelo. ¡Reta a alguien!</p>'; return; }
    el.innerHTML = '<div class="duel-list">' + list.map(duelRowHtml).join('') + '</div>';
  }catch(e){
    if(el.isConnected) el.innerHTML = `<p class="empty-hint">No se pudieron cargar los duelos. ${escapeHtml(duelError(e))}</p>`;
  }
}
function duelRowHtml(s){
  const subj = getSubject(s.subject);
  const rival = s.has_opponent ? (s.their_name || 'Rival') : 'Sin rival todavía';
  const out = duelOutcome(s);
  let status, cls, action = '';
  if(s.my_score == null){
    status = s.expired ? 'Caducado' : '¡Te toca jugar!'; cls = 'turn';
    if(!s.expired) action = `<button class="btn-mini" data-action="playDuel" data-args='["${s.id}"]'>Jugar</button>`;
  } else if(!s.has_opponent){
    status = 'Esperando rival'; cls = 'wait';
    action = `<button class="btn-mini" data-action="shareDuel" data-args='["${s.id}", "${escapeHtml(subj.short)}"]'>Compartir</button>`;
  } else if(s.their_score == null){
    status = `Esperando a ${escapeHtml(rival)}`; cls = 'wait';
  } else {
    status = out === 'win' ? '¡Ganado!' : out === 'lose' ? 'Perdido' : 'Empate'; cls = out;
  }
  const score = `${s.my_score == null ? '–' : s.my_score} : ${s.their_score == null ? '–' : s.their_score}`;
  return `
    <div class="duel-row ${cls}" style="--sc:${subj.color}">
      <div class="dr-main">
        <b>${escapeHtml(rival)}</b>
        <span>${escapeHtml(subj.short)} · ${escapeHtml(s.id)} · ${escapeHtml(status)}</span>
      </div>
      <div class="dr-score">${score}</div>
      ${action}
    </div>`;
}
function noteDuelWin(s){
  if(duelOutcome(s) !== 'win') return false;
  const st = loadStats();
  if(st.duelsWon.includes(s.id)) return false;
  st.duelsWon.push(s.id);
  saveStats(st);
  return true;
}
function startDuelTest(state){
  const qs = (state.question_ids || []).map(findQuestionById).filter(Boolean).map(shuffleQuestionOptions);
  if(!qs.length){ duelMsg = { type:'error', text:'Las preguntas de este duelo ya no están en el banco.' }; homeTab = 'duelos'; renderHome(); return; }
  const test = makeTestShell('duel', state.subject, null, qs);
  test.duel = { id: state.id };
  test.startedAt = Date.now();
  launch(test, false);
}
async function createDuel(){
  const sel = document.getElementById('duelSubject');
  const subjectId = sel && sel.value;
  if(!subjectId) return;
  const pool = shuffle(dedupe(questionsOf(subjectId).filter(q=>!q.u))).slice(0, DUEL_SIZE);
  try{
    const state = await Cloud.rpc('create_duel', { p_subject: subjectId, p_ids: pool.map(q=>q.id) });
    startDuelTest(state);
  }catch(e){ duelMsg = { type:'error', text: duelError(e) }; homeTab = 'duelos'; renderHome(); }
}
async function joinDuel(code){
  code = String(code || '').trim().toUpperCase();
  if(!/^[A-Z0-9]{6}$/.test(code)){ duelMsg = { type:'error', text:'El código tiene 6 letras y números.' }; homeTab = 'duelos'; renderHome(); return; }
  try{
    const state = await Cloud.rpc('join_duel', { p_id: code });
    if(Store.getRaw(PENDING_DUEL_KEY) === code) Store.remove(PENDING_DUEL_KEY);
    if(state.my_score == null && !state.expired) startDuelTest(state);
    else { duelMsg = { type:'ok', text:'Ya habías jugado este duelo.' }; homeTab = 'duelos'; renderHome(); }
  }catch(e){
    if(Store.getRaw(PENDING_DUEL_KEY) === code) Store.remove(PENDING_DUEL_KEY);
    duelMsg = { type:'error', text: duelError(e) }; homeTab = 'duelos'; renderHome();
  }
}
function joinDuelFromInput(){ const el = document.getElementById('duelCode'); joinDuel(el ? el.value : ''); }
function acceptPendingDuel(){ joinDuel(Store.getRaw(PENDING_DUEL_KEY)); }
async function playDuel(id){
  try{ startDuelTest(await Cloud.rpc('duel_state', { p_id: id })); }
  catch(e){ duelMsg = { type:'error', text: duelError(e) }; homeTab = 'duelos'; renderHome(); }
}
function shareDuel(code, subjShort){
  const text = `🚑 Te reto a un duelo en TES Test${subjShort ? ' (' + subjShort + ')' : ''}. ¿A que no me ganas? Código ${code}: ${duelLink(code)}`;
  if(navigator.share){ navigator.share({ title:'Duelo TES Test', text }).catch(()=>{}); return; }
  window.open('https://wa.me/?text=' + encodeURIComponent(text), '_blank', 'noopener');
}
function shareDuelWhatsApp(code, subjShort){
  const text = `🚑 Te reto a un duelo en TES Test${subjShort ? ' (' + subjShort + ')' : ''}. ¿A que no me ganas? Código ${code}: ${duelLink(code)}`;
  window.open('https://wa.me/?text=' + encodeURIComponent(text), '_blank', 'noopener');
}
function copyDuelLink(code){
  const link = duelLink(code);
  const done = ()=>{ const b = document.getElementById('copyDuelBtn'); if(b) b.textContent = '¡Enlace copiado!'; };
  if(navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(link).then(done).catch(()=>{});
}
function openDuels(){ homeTab = 'duelos'; renderHome(); }
// Tras terminar un duelo: envía la puntuación y muestra el marcador
async function submitAndShowDuel(test, score){
  const box = document.getElementById('duelResult');
  const ms = Math.max(0, (test.finishedAt || Date.now()) - (test.startedAt || Date.now()));
  let state = null;
  try{ state = await Cloud.rpc('submit_duel', { p_id: test.duel.id, p_score: score, p_ms: ms }); }
  catch(e){ if(box && box.isConnected) box.innerHTML = `<p class="empty-hint">No se pudo enviar el resultado del duelo. ${escapeHtml(duelError(e))}</p>`; return; }
  if(!box || !box.isConnected) return;
  const subj = getSubject(state.subject);
  const out = duelOutcome(state);
  const rival = state.their_name || 'tu rival';
  let head;
  if(out === 'win') head = `<b class="duel-verdict win">${icon('award',20)} ¡Has ganado el duelo!</b>`;
  else if(out === 'lose') head = `<b class="duel-verdict lose">${escapeHtml(rival)} gana esta vez</b>`;
  else if(out === 'tie') head = `<b class="duel-verdict tie">¡Empate total!</b>`;
  else head = `<b class="duel-verdict wait">${state.has_opponent ? 'Esperando a que juegue ' + escapeHtml(rival) : 'Ahora reta a alguien'}</b>`;
  box.innerHTML = `
    <div class="duel-card">
      ${head}
      <div class="duel-score">
        <div><span>Tú</span><b>${state.my_score}</b><small>${fmtMs(state.my_ms)}</small></div>
        <div class="vs">VS</div>
        <div><span>${escapeHtml(state.has_opponent ? rival : '¿?')}</span><b>${state.their_score == null ? '–' : state.their_score}</b><small>${fmtMs(state.their_ms)}</small></div>
      </div>
      ${!state.has_opponent ? `
        <p class="empty-hint">Manda este enlace a tu compañero. Código del duelo: <b class="duel-code">${escapeHtml(state.id)}</b></p>
        <button class="btn-primary" data-action="shareDuelWhatsApp" data-args='["${state.id}", "${escapeHtml(subj.short)}"]'>${icon('chat',18)} Enviar por WhatsApp</button>
        <button class="btn-secondary acc-full" id="copyDuelBtn" data-action="copyDuelLink" data-args='["${state.id}"]'>Copiar enlace</button>` : ''}
    </div>`;
  if(out === 'win' && noteDuelWin(state)){
    burstConfetti(160); vibrate([30,40,30]);
    const st = loadStats();
    const earnedNow = getAchievements(loadHistory()).filter(a=>a.earned && !st.badges.includes(a.id));
    if(earnedNow.length){ persistBadges(); box.insertAdjacentHTML('beforeend', earnedNow.map(a=>`<div class="celebrate-banner pop">${icon(a.icon||'award',17)} Logro desbloqueado: ${escapeHtml(a.title)}</div>`).join('')); }
  }
}
function persistBadges(){
  const st = loadStats();
  const earned = getAchievements(loadHistory()).filter(a=>a.earned).map(a=>a.id);
  const merged = Array.from(new Set(st.badges.concat(earned)));
  if(merged.length !== st.badges.length){ st.badges = merged; saveStats(st); }
}
// Enlace ?duelo=CODIGO: se guarda el reto para aceptarlo (también tras crear cuenta o iniciar sesión)
function captureDuelFromUrl(){
  try{
    const p = new URLSearchParams(location.search);
    const code = (p.get('duelo') || '').trim().toUpperCase();
    if(/^[A-Z0-9]{6}$/.test(code)){
      Store.setRaw(PENDING_DUEL_KEY, code);
      homeTab = 'duelos';
      history.replaceState(null, '', location.pathname);
    }
  }catch(e){}
}
