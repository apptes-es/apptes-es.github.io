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
// XP y días se guardan por dispositivo (dev) más una base heredada de versiones anteriores (base).
// Así, al sincronizar dos móviles, se suman sus puntos en vez de quedarse con el mayor.
const DEVICE_ID_KEY = 'tes_device_id_v1';   // no se sincroniza: identifica este dispositivo
function deviceId(){
  let id = Store.getRaw(DEVICE_ID_KEY);
  if(!id){ id = 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); try{ localStorage.setItem(DEVICE_ID_KEY, id); }catch(e){} }
  return id;
}
function cleanDays(days){
  const out = {};
  if(days && typeof days === 'object') Object.keys(days).forEach(k=>{ const d = days[k]; if(d && /^\d{4}-\d{2}-\d{2}$/.test(k)) out[k] = { t: Math.max(0, d.t|0), c: Math.max(0, d.c|0) }; });
  return out;
}
// Aciertos acumulados por asignatura ('s:id') y por tema ('t:id::tema'): { clave: {c: aciertos, t: total} }
function cleanAgg(agg){
  const out = {};
  if(agg && typeof agg === 'object') Object.keys(agg).forEach(k=>{ const a = agg[k]; if(a && typeof a === 'object') out[k] = { c: Math.max(0, a.c|0), t: Math.max(0, a.t|0) }; });
  return out;
}
function maxAgg(a, b){
  const out = Object.assign({}, a);
  Object.keys(b).forEach(k=>{ const x = out[k], y = b[k]; out[k] = !x ? y : { c: Math.max(x.c, y.c), t: Math.max(x.t, y.t) }; });
  return out;
}
function addBreakdown(agg, prefix, breakdown){
  Object.keys(breakdown || {}).forEach(k=>{
    const b = breakdown[k]; if(!b) return;
    const a = agg[prefix + k] || (agg[prefix + k] = { c:0, t:0 });
    a.c += b.correct|0; a.t += b.total|0;
  });
}
function cleanPart(p){ p = (p && typeof p === 'object') ? p : {}; return { xp: Math.max(0, Number(p.xp) || 0), days: cleanDays(p.days), agg: cleanAgg(p.agg) }; }
function maxPart(a, b){
  const days = Object.assign({}, a.days);
  Object.keys(b.days).forEach(k=>{ const x = days[k], y = b.days[k]; days[k] = !x ? y : { t: Math.max(x.t, y.t), c: Math.max(x.c, y.c) }; });
  return { xp: Math.max(a.xp, b.xp), days, agg: maxAgg(a.agg, b.agg) };
}
// Recalcula los totales (xp, days) sumando la base y todos los dispositivos
function recomputeTotals(st){
  const parts = [st.base].concat(Object.keys(st.dev).map(k=>st.dev[k]));
  st.xp = 0; st.days = {}; st.agg = {};
  parts.forEach(p=>{
    st.xp += p.xp;
    Object.keys(p.days).forEach(k=>{ const d = st.days[k] || (st.days[k] = {t:0, c:0}); d.t += p.days[k].t; d.c += p.days[k].c; });
    Object.keys(p.agg).forEach(k=>{ const a = st.agg[k] || (st.agg[k] = {c:0, t:0}); a.c += p.agg[k].c; a.t += p.agg[k].t; });
  });
  return st;
}
function normalizeStats(st){
  st = (st && typeof st === 'object') ? st : {};
  if(!st.base || !st.dev){            // formato antiguo: lo que había pasa a ser la base
    st.base = cleanPart({ xp: st.xp, days: st.days });
    st.dev = {};
  } else {
    st.base = cleanPart(st.base);
    const dev = {};
    Object.keys(st.dev || {}).forEach(k=>{ dev[k] = cleanPart(st.dev[k]); });
    st.dev = dev;
  }
  st.badges = Array.isArray(st.badges) ? st.badges : [];
  st.duelsWon = Array.isArray(st.duelsWon) ? st.duelsWon : [];
  st.bestStreak = Math.max(0, Number(st.bestStreak) || 0);
  // El rendimiento por asignatura y tema antes se calculaba con los últimos 80 tests;
  // la primera vez se copia de ese historial a la base y a partir de ahí se acumula para siempre.
  if(!st.aggInit){
    const fromHistory = {};
    loadHistory().forEach(h=>{ if(h){ addBreakdown(fromHistory, 's:', h.subjBreakdown); addBreakdown(fromHistory, 't:', h.temaBreakdown); } });
    st.base.agg = maxAgg(st.base.agg, fromHistory);
    st.aggInit = true;
    st.migrated = true;   // aviso para loadStats: hay que guardarlo
  }
  return recomputeTotals(st);
}
function backfillStats(){
  const st = normalizeStats({});
  loadHistory().forEach(h=>{
    if(!h || !h.date) return;
    const d = st.base.days[dayKey(h.date)] || (st.base.days[dayKey(h.date)] = {t:0, c:0});
    d.t++; d.c += h.score || 0;
    st.base.xp += pointsForEntry(h);
  });
  recomputeTotals(st);
  st.bestStreak = streakInfo(st.days).best;
  delete st.migrated;
  return st;
}
function loadStats(){
  const raw = Store.get(STATS_KEY, null);
  if(!raw){
    // Primera vez con esta versión: se calcula desde el historial y se guarda SIN marcar cambio,
    // para que la primera sincronización no pise datos más nuevos de la nube.
    const st = backfillStats();
    Store.restore({ [STATS_KEY]: JSON.stringify(st) });
    return st;
  }
  const st = normalizeStats(raw);
  if(st.migrated){ delete st.migrated; Store.restore({ [STATS_KEY]: JSON.stringify(st) }); }
  return st;
}
function saveStats(st){ delete st.migrated; Store.set(STATS_KEY, st); }
// Une las estadísticas de dos dispositivos sin perder nada
function mergeStats(a, b){
  a = normalizeStats(a); b = normalizeStats(b);
  const dev = Object.assign({}, a.dev);
  Object.keys(b.dev).forEach(k=>{ dev[k] = dev[k] ? maxPart(dev[k], b.dev[k]) : b.dev[k]; });
  return recomputeTotals({
    aggInit: true,
    base: maxPart(a.base, b.base), dev,
    badges: Array.from(new Set(a.badges.concat(b.badges))),
    duelsWon: Array.from(new Set(a.duelsWon.concat(b.duelsWon))),
    bestStreak: Math.max(a.bestStreak, b.bestStreak)
  });
}
// Se llama al terminar cada test
function recordTestStats(entry){
  const st = loadStats();
  const before = { xp: st.xp, streak: streakInfo(st.days).current, studiedToday: !!(st.days[dayKey(Date.now())]) };
  const id = deviceId();
  const mine = st.dev[id] || (st.dev[id] = { xp: 0, days: {}, agg: {} });
  const k = dayKey(entry.date);
  const d = mine.days[k] || (mine.days[k] = {t:0, c:0});
  d.t++; d.c += entry.score || 0;
  addBreakdown(mine.agg, 's:', entry.subjBreakdown);
  addBreakdown(mine.agg, 't:', entry.temaBreakdown);
  const gained = pointsForEntry(entry);
  mine.xp += gained;
  recomputeTotals(st);
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
  { min: 3500, name: 'Leyenda de la ambulancia', icon: 'medal' },
  { min: 6000, name: 'Instructor de emergencias', icon: 'award' },
  { min: 12000, name: 'Héroe del 061',           icon: 'star' },
  { min: 20000, name: 'Mito de las emergencias',  icon: 'flame' }
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
// Exámenes por día: { 'YYYY-MM-DD': [asignatura, ...] }
function examsByDay(){
  const map = {};
  SUBJECTS.forEach(s=>{ if(s.exam_date && parseDay(s.exam_date)) (map[s.exam_date] = map[s.exam_date] || []).push(s); });
  return map;
}
// Hasta qué mes se puede avanzar: el del último examen pendiente (mínimo el actual)
function calMaxOffset(){
  const base = todayStart();
  let max = 0;
  Object.keys(examsByDay()).forEach(k=>{
    const d = parseDay(k);
    if(d >= base) max = Math.max(max, (d.getFullYear() - base.getFullYear()) * 12 + d.getMonth() - base.getMonth());
  });
  return max;
}
function calendarHtml(){
  const st = loadStats();
  const si = streakInfo(st.days);
  const base = todayStart();
  const maxOff = calMaxOffset();
  if(calOffset > maxOff) calOffset = maxOff;
  const first = new Date(base.getFullYear(), base.getMonth() + calOffset, 1);
  const daysInMonth = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
  const lead = (first.getDay() + 6) % 7; // lunes primero
  const todayK = dayKey(base);
  const exams = examsByDay();
  const monthExams = [];
  let cells = '', studied = 0, tests = 0;
  for(let i=0;i<lead;i++) cells += '<span class="cal-cell empty"></span>';
  for(let d=1; d<=daysInMonth; d++){
    const k = dayKey(new Date(first.getFullYear(), first.getMonth(), d));
    const info = st.days[k];
    const t = info ? info.t : 0;
    if(t){ studied++; tests += t; }
    const lvl = t >= 4 ? 3 : t >= 2 ? 2 : t >= 1 ? 1 : 0;
    const ex = exams[k] || [];
    if(ex.length) monthExams.push({ k, ex });
    let label = `${d}: ${t ? t + (t===1?' test':' tests') + ', ' + (info.c||0) + ' aciertos' : 'sin estudiar'}`;
    if(ex.length) label += ' · Examen: ' + ex.map(s=>s.short || s.name).join(', ');
    const past = k < todayK;
    cells += `<span class="cal-cell l${lvl} ${k===todayK?'today':''} ${ex.length?'exam':''} ${ex.length&&past?'past':''}" title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}"${ex.length?` style="--ec:${ex[0].color}"`:''}>${d}</span>`;
  }
  const monthName = first.toLocaleDateString('es-ES', { month:'long', year:'numeric' });
  const examList = monthExams.length ? `<div class="cal-exams">` + monthExams.map(({k, ex})=>{
      const days = daysUntil(k);
      const when = days < 0 ? 'ya celebrado' : days === 0 ? '¡hoy!' : days === 1 ? 'mañana' : `en ${days} días`;
      return ex.map(s=>`<div class="cal-exam" style="--ec:${s.color}">
          <span class="ce-day">${parseDay(k).getDate()}</span>
          <span class="ce-name">${escapeHtml(s.short || s.name)}</span>
          <span class="ce-when ${days>=0&&days<=7?'soon':''}">${when}</span>
        </div>`).join('');
    }).join('') + `</div>` : (()=>{
      // Mes sin exámenes: se avisa del siguiente y se puede saltar a él
      const next = Object.keys(exams).filter(k=>k >= todayK).sort()[0];
      if(!next) return '';
      const nd = parseDay(next);
      const off = (nd.getFullYear() - base.getFullYear()) * 12 + nd.getMonth() - base.getMonth();
      if(off === calOffset) return '';
      const names = exams[next].map(s=>s.short || s.name).join(', ');
      return `<button type="button" class="cal-next-exam" data-action="calGoTo" data-args="${escapeHtml(JSON.stringify([off]))}">
          ${icon('clock',14)} <span>Próximo examen: <b>${escapeHtml(formatDay(next))}</b> · ${escapeHtml(names)}</span>${icon('chevronRight',14)}
        </button>`;
    })();
  return `
    <div class="cal-card">
      <div class="cal-head">
        <button class="cal-nav" data-action="calMove" data-args='[-1]' aria-label="Mes anterior">${icon('chevronLeft',16)}</button>
        <b>${escapeHtml(monthName)}</b>
        <button class="cal-nav" data-action="calMove" data-args='[1]' ${calOffset>=maxOff?'disabled':''} aria-label="Mes siguiente">${icon('chevronRight',16)}</button>
      </div>
      <div class="cal-grid cal-dow"><span>L</span><span>M</span><span>X</span><span>J</span><span>V</span><span>S</span><span>D</span></div>
      <div class="cal-grid">${cells}</div>
      ${examList}
      <div class="cal-stats">
        <div><b>${si.current}</b><span>racha actual</span></div>
        <div><b>${Math.max(si.best, st.bestStreak)}</b><span>mejor racha</span></div>
        <div><b>${studied}</b><span>días este mes</span></div>
        <div><b>${tests}</b><span>tests este mes</span></div>
      </div>
      <div class="cal-legend"><span>Menos</span><i class="l0"></i><i class="l1"></i><i class="l2"></i><i class="l3"></i><span>Más</span><span class="cl-exam"><i class="ex"></i>Examen</span></div>
    </div>`;
}
function calGoTo(off){ calOffset = Math.max(-24, Math.min(calMaxOffset(), off|0)); renderHome(); }
function calMove(delta){ calOffset = Math.max(-24, Math.min(calMaxOffset(), calOffset + delta)); renderHome(); }
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
  const colors = (document.documentElement.getAttribute('data-theme') === 'pink')
    ? ['#FF6FB5','#FFB3D9','#C9A7F5','#FFFFFF','#FF9EC7','#F7C6FF']
    : ['#F5C518','#2FA35B','#2F8CFF','#E0312B','#FFFFFF','#FF8A3D'];
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
function toast(text){
  document.querySelectorAll('.toast').forEach(t=>t.remove());
  const t = document.createElement('div');
  t.className = 'toast'; t.setAttribute('role', 'status'); t.textContent = text;
  document.body.appendChild(t);
  setTimeout(()=>t.remove(), 2800);
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
  bad_questions: 'No se pudo preparar el duelo.',
  not_participant: 'No participas en este duelo.',
  self: 'No puedes retarte a ti mismo.',
  no_target: 'Ese compañero ya no tiene acceso a la app.'
};
function duelError(e){
  const m = String((e && e.message) || '').trim();
  const key = Object.prototype.hasOwnProperty.call(DUEL_ERRORS, m) ? m : null;
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
// Atributo data-args seguro (JSON escapado para HTML)
function argsAttr(arr){ return escapeHtml(JSON.stringify(arr)); }
// Resultados de duelo pendientes de enviar: se guardan ANTES de enviarlos para no perderlos nunca
const DUEL_SUBMIT_KEY = 'tes_duel_submit_v1';
function pendingDuelSubmits(){ const q = Store.get(DUEL_SUBMIT_KEY, []); return Array.isArray(q) ? q : []; }
function setPendingDuelSubmits(q){ if(q.length) Store.set(DUEL_SUBMIT_KEY, q); else Store.remove(DUEL_SUBMIT_KEY); }
function queueDuelSubmit(item){ setPendingDuelSubmits(pendingDuelSubmits().filter(x=>x.id !== item.id).concat([item])); }
function unqueueDuelSubmit(id){ setPendingDuelSubmits(pendingDuelSubmits().filter(x=>x.id !== id)); }
async function flushDuelSubmits(){
  for(const it of pendingDuelSubmits()){
    try{ await Cloud.rpc('submit_duel', { p_id: it.id, p_score: it.score, p_ms: it.ms }); unqueueDuelSubmit(it.id); }
    catch(e){ if(e && e.status >= 400 && e.status < 500 && e.status !== 401) unqueueDuelSubmit(it.id); }
  }
}
// ¿Hay un duelo a medias guardado en este dispositivo?
function savedDuelProgress(id){
  const p = typeof loadProgress === 'function' ? loadProgress() : null;
  return (p && p.currentTest && p.currentTest.mode === 'duel' && p.currentTest.duel && p.currentTest.duel.id === id) ? p : null;
}

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
    <div id="duelInboxBox">${duelInboxHtml()}</div>
    <div class="duel-new">
      <div class="section-label">Nuevo duelo</div>
      <p class="empty-hint">Elige asignatura y a quién retas. Juegas tus ${DUEL_SIZE} preguntas y a tu rival le llega el reto en la app. Gana quien acierte más; si empatáis, el más rápido.</p>
      <label class="duel-field">Asignatura
        <select id="duelSubject">${subs.map(s=>`<option value="${escapeHtml(s.id)}">${escapeHtml(s.name)}</option>`).join('')}</select>
      </label>
      <div class="duel-field-label">¿A quién retas?</div>
      <div id="rivalList" class="rival-list"><p class="empty-hint">Cargando compañeros…</p></div>
      <button class="acc-link" data-action="createDuel" ${subs.length?'':'disabled'}>O crear un duelo con enlace para compartir</button>
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
  loadRivals();
}
async function loadDuelList(){
  const el = document.getElementById('duelList');
  if(!el) return;
  try{
    await flushDuelSubmits();
    const list = await Cloud.rpc('my_duels', {});
    if(!el.isConnected) return;
    (list || []).forEach(noteDuelWin);
    setDuelInbox(list);
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
  const sending = s.my_score == null && pendingDuelSubmits().some(x=>x.id === s.id);
  if(sending){
    status = 'Enviando tu resultado…'; cls = 'wait';
  } else if(s.my_score == null){
    status = s.expired ? 'Caducado' : savedDuelProgress(s.id) ? 'A medias' : '¡Te toca jugar!'; cls = 'turn';
    if(!s.expired) action = `<button class="btn-mini" data-action="playDuel" data-args="${argsAttr([s.id])}">${savedDuelProgress(s.id) ? 'Seguir' : 'Jugar'}</button>`;
  } else if(!s.has_opponent){
    status = 'Esperando rival'; cls = 'wait';
    action = `<button class="btn-mini" data-action="shareDuel" data-args="${argsAttr([s.id, subj.short])}">Compartir</button>`;
  } else if(s.their_score == null){
    status = `Esperando a ${rival}`; cls = 'wait';
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
  const ids = state.question_ids || [];
  const qs = ids.map(findQuestionById).filter(Boolean).map(shuffleQuestionOptions);
  if(!qs.length || qs.length !== ids.length){
    duelMsg = { type:'error', text:'Faltan preguntas de este duelo en tu app. Cierra y vuelve a abrir la app para actualizar las preguntas e inténtalo otra vez.' };
    if(typeof Bank !== 'undefined') Bank.refresh(onBankUpdated);
    homeTab = 'duelos'; renderHome(); return;
  }
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
  // Si ya lo empezaste en este dispositivo, se sigue donde lo dejaste (mismo cronómetro)
  if(savedDuelProgress(id)){ continueTest(); return; }
  try{ startDuelTest(await Cloud.rpc('duel_state', { p_id: id })); }
  catch(e){ duelMsg = { type:'error', text: duelError(e) }; homeTab = 'duelos'; renderHome(); }
}
function duelShareText(code, subjShort){
  return `🚑 Te reto a un duelo en TES Test${subjShort ? ' (' + subjShort + ')' : ''}. ¿A que no me ganas? Código ${code}: ${duelLink(code)}`;
}
function shareDuelWhatsApp(code, subjShort){
  window.open('https://wa.me/?text=' + encodeURIComponent(duelShareText(code, subjShort)), '_blank', 'noopener');
}
function shareDuel(code, subjShort){
  if(navigator.share){ navigator.share({ title:'Duelo TES Test', text: duelShareText(code, subjShort) }).catch(()=>{}); return; }
  shareDuelWhatsApp(code, subjShort);
}
function copyDuelLink(code){
  const link = duelLink(code);
  const done = ()=>{ const b = document.getElementById('copyDuelBtn'); if(b) b.textContent = '¡Enlace copiado!'; };
  const fallback = ()=>{ window.prompt('Copia el enlace del duelo:', link); };
  if(navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(link).then(done).catch(fallback);
  else fallback();
}
function openDuels(){ homeTab = 'duelos'; renderHome(); }
// Tras terminar un duelo: envía la puntuación y muestra el marcador
async function submitAndShowDuel(test, score){
  const box = document.getElementById('duelResult');
  const ms = Math.max(0, (test.finishedAt || Date.now()) - (test.startedAt || Date.now()));
  let state = null;
  queueDuelSubmit({ id: test.duel.id, score, ms });
  try{ state = await Cloud.rpc('submit_duel', { p_id: test.duel.id, p_score: score, p_ms: ms }); unqueueDuelSubmit(test.duel.id); }
  catch(e){
    if(e && e.status >= 400 && e.status < 500 && e.status !== 401) unqueueDuelSubmit(test.duel.id);
    if(box && box.isConnected) box.innerHTML = `<p class="empty-hint">No se pudo enviar el resultado del duelo ahora. ${escapeHtml(duelError(e))} Tu resultado está guardado y se enviará solo cuando vuelvas a Duelos.</p>`;
    return;
  }
  if(!box || !box.isConnected) return;
  const subj = getSubject(state.subject);
  const out = duelOutcome(state);
  const rival = state.their_name || 'tu rival';
  let head;
  if(out === 'win') head = `<b class="duel-verdict win">${icon('award',20)} ¡Has ganado el duelo!</b>`;
  else if(out === 'lose') head = `<b class="duel-verdict lose">${escapeHtml(rival)} gana esta vez</b>`;
  else if(out === 'tie') head = `<b class="duel-verdict tie">¡Empate total!</b>`;
  else head = `<b class="duel-verdict wait">${state.has_opponent ? 'Esperando a que juegue ' + escapeHtml(rival) : 'Ahora reta a alguien'}</b>`
    + (state.has_opponent && state.their_score == null ? `<p class="empty-hint">A ${escapeHtml(rival)} le ha llegado el reto en la app.</p>` : '');
  refreshDuelInbox();
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
        <button class="btn-primary" data-action="shareDuelWhatsApp" data-args="${argsAttr([state.id, subj.short])}">${icon('chat',18)} Enviar por WhatsApp</button>
        <button class="btn-secondary acc-full" id="copyDuelBtn" data-action="copyDuelLink" data-args="${argsAttr([state.id])}">Copiar enlace</button>` : ''}
    </div>`;
  if(out === 'win' && noteDuelWin(state)){
    burstConfetti(160); vibrate([30,40,30]);
    const st = loadStats();
    const earnedNow = getAchievements(loadHistory()).filter(a=>a.earned && !st.badges.includes(a.id));
    if(earnedNow.length){ persistBadges(); announceProgress(); box.insertAdjacentHTML('beforeend', earnedNow.map(a=>`<div class="celebrate-banner pop">${icon(a.icon||'award',17)} Logro desbloqueado: ${escapeHtml(a.title)}</div>`).join('')); }
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

/* ---------- MURO DE LOGROS DE LA CLASE ---------- */
// Al subir de rango, desbloquear un logro o alcanzar una racha, se publica en el muro y los compañeros reaccionan.
const FEED_BASE_KEY = 'tes_feed_base_v1';   // lo ya anunciado por cuenta (no se sincroniza; el servidor evita duplicados)
const FEED_EMOJIS = ['👏', '🔥', '💪', '❤️'];
const STREAK_MILESTONES = [3, 7, 14, 30, 60, 100];
let feedCache = null;
function feedNow(){
  const st = loadStats();
  return { rankIdx: rankFor(st.xp).idx, streak: streakInfo(st.days).current,
    badges: getAchievements(loadHistory()).filter(a=>a.earned).map(a=>a.id) };
}
function announceProgress(){
  const uid = Cloud.userId();
  if(!uid || !Cloud.canUse()) return;
  const all = Store.get(FEED_BASE_KEY, {}) || {};
  const base = all[uid], now = feedNow();
  all[uid] = { rankIdx: Math.max(now.rankIdx, base ? base.rankIdx : 0), streak: now.streak,
    badges: Array.from(new Set((base ? base.badges : []).concat(now.badges))) };
  Store.set(FEED_BASE_KEY, all);
  if(!base) return;   // primera vez en este dispositivo: se apunta dónde está, sin publicar lo antiguo
  const events = [];
  if(now.rankIdx > base.rankIdx){ const r = RANKS[now.rankIdx]; events.push(['rank', r.name, r.name, r.icon]); }
  const ach = getAchievements(loadHistory());
  now.badges.filter(id=>!base.badges.includes(id)).forEach(id=>{
    const a = ach.find(x=>x.id === id);
    if(a) events.push(['badge', id, a.title, a.icon || 'award']);
  });
  STREAK_MILESTONES.forEach(m=>{ if(now.streak >= m && base.streak < m) events.push(['streak', m + '@' + dayKey(Date.now()), String(m), 'flame']); });
  events.forEach(([kind, key, label, ic])=>{
    Cloud.rpc('post_feed_event', { p_kind: kind, p_key: key, p_label: label, p_icon: ic }).catch(()=>{});
  });
}
function timeAgo(iso){
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if(s < 60) return 'ahora mismo';
  if(s < 3600) return 'hace ' + Math.floor(s/60) + ' min';
  if(s < 86400) return 'hace ' + Math.floor(s/3600) + ' h';
  const d = Math.floor(s/86400);
  return d === 1 ? 'ayer' : 'hace ' + d + ' días';
}
function feedText(e){
  const L = escapeHtml(e.label);
  if(e.kind === 'rank') return e.is_me ? `Has llegado a <b>${L}</b>` : `ha llegado a <b>${L}</b>`;
  if(e.kind === 'streak') return e.is_me ? `Llevas <b>${L} días</b> seguidos estudiando` : `lleva <b>${L} días</b> seguidos estudiando`;
  return e.is_me ? `Has conseguido el logro <b>«${L}»</b>` : `ha conseguido el logro <b>«${L}»</b>`;
}
function feedItemHtml(e){
  const reacts = FEED_EMOJIS.map(em=>{
    const n = (e.reactions && e.reactions[em]) || 0;
    const on = (e.mine || []).includes(em);
    if(e.is_me) return n ? `<span class="react-chip">${em} <span>${n}</span></span>` : '';
    return `<button type="button" class="react-btn ${on ? 'on' : ''}" data-action="reactFeed" data-args="${argsAttr([e.id, em])}" aria-pressed="${on}">${em}${n ? ` <span>${n}</span>` : ''}</button>`;
  }).join('');
  const who = e.who && e.who.length
    ? `<div class="feed-who">${icon('heart',11)} ${escapeHtml(e.who.slice(0,4).join(', '))}${e.who.length > 4 ? ' y ' + (e.who.length - 4) + ' más' : ''}</div>` : '';
  const del = Cloud.isAdmin() ? `<button type="button" class="feed-del" data-action="adminDeleteFeed" data-args="${argsAttr([e.id])}" aria-label="Borrar del muro">×</button>` : '';
  return `<li class="feed-item ${e.is_me ? 'me' : ''} k-${escapeHtml(e.kind)}">
    <div class="feed-icon">${icon(e.icon || 'award', 18)}</div>
    <div class="feed-body">
      <p>${e.is_me ? '' : `<b>${escapeHtml(e.name)}</b> `}${feedText(e)}</p>
      <small>${timeAgo(e.created_at)}</small>
      ${reacts ? `<div class="feed-reacts">${reacts}</div>` : (e.is_me ? '<div class="feed-wait">Aún sin reacciones</div>' : '')}
      ${who}
    </div>${del}
  </li>`;
}
function paintFeed(box){
  if(!box || !box.isConnected) return;
  box.innerHTML = `<div class="section-label">Muro de la clase</div>` + (feedCache && feedCache.length
    ? `<ul class="feed-list">${feedCache.map(feedItemHtml).join('')}</ul>`
    : `<p class="empty-hint">Aquí aparecerán las subidas de rango, rachas y logros de la clase. ¡Reacciona para animar a tus compañeros!</p>`);
}
async function renderFeed(box){
  if(!box) return;
  if(feedCache) paintFeed(box);
  else box.innerHTML = `<div class="section-label">Muro de la clase</div><p class="empty-hint">Cargando…</p>`;
  try{ feedCache = await Cloud.rpc('class_feed'); paintFeed(box); }
  catch(e){ if(!feedCache && box.isConnected) box.innerHTML = `<div class="section-label">Muro de la clase</div><p class="empty-hint">No se pudo cargar el muro.</p>`; }
}
async function reactFeed(id, emoji){
  const e = feedCache && feedCache.find(x=>x.id === id);
  if(!e || e.is_me) return;
  // Se pinta al momento y luego se confirma con el servidor
  e.mine = e.mine || []; e.reactions = e.reactions || {};
  const on = e.mine.includes(emoji);
  e.mine = on ? e.mine.filter(x=>x !== emoji) : e.mine.concat([emoji]);
  e.reactions[emoji] = Math.max(0, (e.reactions[emoji] || 0) + (on ? -1 : 1));
  if(!on) vibrate(15);
  const box = document.getElementById('feedBox');
  paintFeed(box);
  try{ await Cloud.rpc('toggle_reaction', { p_event: id, p_emoji: emoji }); }
  catch(err){ toast('No se pudo guardar la reacción'); }
  renderFeed(box);
}
async function adminDeleteFeed(id){
  if(!confirm('¿Borrar esta publicación del muro?')) return;
  try{ await Cloud.rpc('admin_delete_feed_event', { p_event: id }); feedCache = (feedCache || []).filter(x=>x.id !== id); }
  catch(e){ toast('No se pudo borrar'); }
  renderFeed(document.getElementById('feedBox'));
}

// Al tocar el círculo de un compañero en el ranking: un bocadillo al lado con su rango y su experiencia
let lastTapEl = null;
document.addEventListener('click', e=>{ lastTapEl = e.target.closest('[data-action]'); }, true);
document.addEventListener('click', e=>{ if(!e.target.closest('.rank-orb')) document.querySelectorAll('.rank-pop').forEach(x=>x.remove()); });
window.addEventListener('scroll', ()=>document.querySelectorAll('.rank-pop').forEach(x=>x.remove()), { passive: true });
function showRankInfo(name, rankName, xp){
  document.querySelectorAll('.rank-pop').forEach(x=>x.remove());
  const el = lastTapEl;
  const ri = rankFor(Number(xp) || 0);
  const pop = document.createElement('div');
  pop.className = 'rank-pop'; pop.setAttribute('role', 'status');
  pop.innerHTML = `<div class="pc-rank rank-${ri.idx}">${icon(ri.rank.icon, 16)}</div>
    <div><b>${escapeHtml(name)}</b><span>${escapeHtml(rankName)}</span><small>${Number(xp || 0).toLocaleString('es-ES')} XP</small></div>`;
  document.body.appendChild(pop);
  if(el && el.isConnected){
    const r = el.getBoundingClientRect(), w = pop.offsetWidth, h = pop.offsetHeight;
    const left = Math.min(r.right + 12, window.innerWidth - w - 8);
    pop.style.left = (left + window.scrollX) + 'px';
    pop.style.top = (r.top + r.height / 2 - h / 2 + window.scrollY) + 'px';
  } else {
    pop.classList.add('center');
  }
  clearTimeout(showRankInfo.t);
  showRankInfo.t = setTimeout(()=>pop.remove(), 3500);
}

/* ---------- RETOS DIRECTOS Y AVISOS DE DUELO ---------- */
// Se reta a un compañero desde la lista de Duelos y le llega el aviso en su perfil, sin enlaces ni WhatsApp.
const DUEL_SEEN_KEY = 'tes_duel_seen_v1';
let duelInbox = [];
let rivalsCache = null;
let challenging = false;
function isIncomingDuel(s){
  return s.role === 'opponent' && s.my_score == null && !s.expired && s.their_score != null
    && !pendingDuelSubmits().some(x=>x.id === s.id);
}
function setDuelInbox(list){
  duelInbox = (list || []).filter(isIncomingDuel);
  const seen = new Set(Store.get(DUEL_SEEN_KEY, []) || []);
  const fresh = duelInbox.filter(s=>!seen.has(s.id));
  if(fresh.length){
    toast(fresh.length === 1 ? `${fresh[0].their_name || 'Un compañero'} te ha retado a un duelo` : `Tienes ${fresh.length} duelos nuevos`);
    vibrate([20, 40, 20]);
    Store.set(DUEL_SEEN_KEY, Array.from(seen).concat(fresh.map(s=>s.id)).slice(-100));
  }
  paintDuelBadges();
}
async function refreshDuelInbox(){
  if(!Cloud.canUse()) return;
  try{ setDuelInbox(await Cloud.rpc('my_duels', {})); }catch(e){}
}
function paintDuelBadges(){
  const n = duelInbox.length;
  const btn = document.getElementById('accountBtn');
  if(btn){
    let b = btn.querySelector('.notif-badge');
    if(n){ if(!b){ b = document.createElement('span'); b.className = 'notif-badge'; btn.appendChild(b); } b.textContent = n > 9 ? '9+' : String(n); }
    else if(b) b.remove();
  }
  const tab = document.querySelector('.home-tab[data-args=\'["duelos"]\']');
  if(tab){
    const has = !!(n || Store.getRaw(PENDING_DUEL_KEY)), dot = tab.querySelector('.tab-dot');
    if(has && !dot) tab.insertAdjacentHTML('beforeend', ' <i class="tab-dot"></i>');
    if(!has && dot) dot.remove();
  }
  const box = document.getElementById('duelInboxBox');
  if(box) box.innerHTML = duelInboxHtml();
}
function duelInboxHtml(){
  if(!duelInbox.length) return '';
  return `<div class="section-label">Duelos que te han enviado</div>` + duelInbox.map(s=>{
    const subj = getSubject(s.subject);
    return `<div class="duel-invite">
      <div>${icon('award',20)} <b>${escapeHtml(s.their_name || 'Un compañero')} te reta</b><span>${escapeHtml(subj.short)} · sacó ${s.their_score}/${s.total}</span></div>
      <button class="btn-mini" data-action="playDuel" data-args="${argsAttr([s.id])}">Jugar</button>
    </div>`;
  }).join('');
}
async function loadRivals(){
  const el = document.getElementById('rivalList');
  if(!el) return;
  if(rivalsCache) paintRivals(el);
  try{ rivalsCache = (await Cloud.rpc('weekly_ranking_v3', {})).filter(r=>!r.is_me && r.uid); paintRivals(el); }
  catch(e){ if(!rivalsCache && el.isConnected) el.innerHTML = `<p class="empty-hint">No se pudo cargar la lista de compañeros.</p>`; }
}
function paintRivals(el){
  if(!el || !el.isConnected) return;
  if(!rivalsCache.length){ el.innerHTML = '<p class="empty-hint">Todavía no hay compañeros con acceso.</p>'; return; }
  el.innerHTML = rivalsCache.map(r=>{
    const ri = rankFor(r.xp || 0);
    return `<div class="rival-row">
      <span class="pc-rank rank-${ri.idx} rival-orb">${icon(ri.rank.icon, 15)}</span>
      <div class="rival-name"><b>${escapeHtml(r.display_name)}</b><span>${escapeHtml(ri.rank.name)}</span></div>
      <button class="btn-mini" data-action="challengeRival" data-args="${argsAttr([r.uid, r.display_name])}">Retar</button>
    </div>`;
  }).join('');
}
async function challengeRival(uid, name){
  if(challenging) return;
  const sel = document.getElementById('duelSubject');
  const subjectId = sel && sel.value;
  if(!subjectId) return;
  const pool = shuffle(dedupe(questionsOf(subjectId).filter(q=>!q.u))).slice(0, DUEL_SIZE);
  challenging = true;
  document.querySelectorAll('[data-action="challengeRival"]').forEach(b=>{ b.disabled = true; });
  try{
    const state = await Cloud.rpc('challenge_duel', { p_target: uid, p_subject: subjectId, p_ids: pool.map(q=>q.id) });
    toast('Reto a ' + name + ': ¡te toca jugar primero!');
    startDuelTest(state);
  }catch(e){ duelMsg = { type:'error', text: duelError(e) }; homeTab = 'duelos'; renderHome(); }
  finally{ challenging = false; }
}
document.addEventListener('visibilitychange', ()=>{ if(document.visibilityState === 'visible') refreshDuelInbox(); });
setInterval(()=>{ if(document.visibilityState === 'visible') refreshDuelInbox(); }, 90000);
