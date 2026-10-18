'use strict';
/* ---------------- ESTADO ---------------- */
let currentTest = null; // {mode, subject, label, questions:[...], answers:[...], timed, endTime}
let currentIndex = 0;
let timerInterval = null;
let lastWrongIds = [];
let lastQuizIndex = -1;   // para animar la entrada de cada pregunta
let justAnswered = false; // para animar la respuesta recién elegida
let homeTab = 'asignaturas';   // 'asignaturas' | 'progreso'
let subjectTab = 'practicar';  // 'practicar' | 'progreso'
let currentSubjectId = null;

const HISTORY_KEY = 'tes_test_history_v1';
const PROGRESS_KEY = 'tes_test_progress_v1';
const THEME_KEY = 'tes_theme_v1';
const FAILED_KEY = 'tes_failed_ids_v1';
const MASTERY_KEY = 'tes_mastered_ids_v1';
// Tamaño de los simulacros de cada asignatura: entre 30 y 50.
// Si el banco aún no tiene tantas preguntas, el test usa todas las disponibles.
const TEST_SIZE = 40;
const SEEN_KEY = 'tes_seen_v1';        // última vez que salió cada pregunta
const RECENT_KEY = 'tes_recent_tests_v1'; // preguntas de los 2 últimos tests aleatorios de cada asignatura
const LETTERS = ['A','B','C','D'];
const PASS_RATIO = 0.5;
const TIMED_SECONDS = 45 * 60; // 45 minutos en modo cronometrado

function passScoreFor(total){ return Math.ceil(total * PASS_RATIO); }

/* ---------------- ASIGNATURAS ---------------- */
function getSubject(id){ return SUBJECTS.find(s=>s.id===id) || {id, name:id||'Sin asignatura', short:id||'—', icon:'book', color:'#1C5FB0'}; }
const QUESTIONS_BY_SUBJECT = {};
function rebuildSubjectIndex(){
  Object.keys(QUESTIONS_BY_SUBJECT).forEach(k=>delete QUESTIONS_BY_SUBJECT[k]);
  QUESTIONS.forEach(q=>{ (QUESTIONS_BY_SUBJECT[q.subject] = QUESTIONS_BY_SUBJECT[q.subject] || []).push(q); });
}
rebuildSubjectIndex();
function questionsOf(subjectId){ return QUESTIONS_BY_SUBJECT[subjectId] || []; }
function temasOf(subjectId){
  const out = [];
  questionsOf(subjectId).forEach(q=>{ if(!out.includes(q.exam)) out.push(q.exam); });
  return out;
}
function subjectMastery(subjectId){
  const qs = questionsOf(subjectId);
  if(!qs.length) return 0;
  const m = new Set(loadMasteredIds());
  return Math.round(qs.filter(q=>m.has(q.id)).length / qs.length * 100);
}
function escapeHtml(s){
  return String(s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

/* ---------------- FRASES DE REFUERZO ---------------- */
const CORRECT_PHRASES = [
  '¡Más acertado que un catéter bien puesto!',
  '¡Más fino que una vía cogida a la primera!',
  '¡Correcto! Eso ha sido un 15 en la escala de Glasgow.',
  '¡Dentro! Más preciso que un pulsioxímetro recién estrenado.',
  '¡Toma ya! Más estable que un paciente en el colchón de vacío.',
  '¡Acierto! El DEA analiza... no se recomienda descarga, estás perfecto.',
  '¡Correcto! Ni el médico del SAMU lo clava así.',
  '¡Eso es! Constantes vitales de campeón.',
  '¡Bien! Triaje en verde: tú solito caminas hacia el aprobado.',
  '¡Perfecto! Más rápido que la ambulancia con la sirena puesta.',
  '¡Olé! Más bien colocado que un collarín cervical.',
  '¡Correcto! Saturando al 100% sin gafas nasales.'
];
const INCORRECT_TEMPLATES = [
  'Vía fallida, toca pinchar otra vez. Era la {L}.',
  'Uy, eso ha sido un Glasgow de 3. La correcta era la {L}.',
  'Esa respuesta ha entrado en parada. La buena era la {L}.',
  'Más perdido que una ambulancia sin GPS. Era la {L}.',
  'Error de triaje: esa iba directa a tarjeta negra. Era la {L}.',
  'Te has ido con la sirena puesta a la dirección equivocada. Era la {L}.',
  'Se te ha soltado el torniquete. La correcta era la {L}.',
  'Saturación bajando... la buena era la {L}.',
  'Esa respuesta necesita oxígeno a alto flujo. Era la {L}.',
  'Tranquilo, esto se reanima. La correcta era la {L}.'
];
function pickPhrase(correct, correctLetter){
  if(correct) return CORRECT_PHRASES[Math.floor(Math.random()*CORRECT_PHRASES.length)];
  const t = INCORRECT_TEMPLATES[Math.floor(Math.random()*INCORRECT_TEMPLATES.length)];
  return t.replace('{L}', correctLetter);
}
function resultMessage(pct){
  if(pct === 100) return 'Turno perfecto. Todos los pacientes atendidos y ni una incidencia.';
  if(pct >= 85) return 'Guardia de lujo. Estás para salir en la próxima dotación.';
  if(pct >= 70) return 'Muy buena intervención. Unos ajustes y quedas de diez.';
  if(pct >= 50) return 'Aviso resuelto. Repasa las falladas para llegar con más margen.';
  if(pct >= 30) return 'Paciente estable, pero hay que reforzar. Repasa y vuelve a intentarlo.';
  return 'Toca volver a la base a repasar. Cada test te deja más preparado.';
}

/* ---------------- MASCOTA: "Ambu", la ambulancia ---------------- */
function mascotSVG(state, size){
  size = size || 34;
  const navy = '#10233D';
  const sirenOn = state === 'happy';
  const sirenCol = state === 'sad' ? '#9AA6B6' : '#2F8CFF';
  const sirenCol2 = state === 'sad' ? '#9AA6B6' : '#E0312B';
  let eyes, mouth, extra = '';
  if(state === 'happy'){
    eyes = `<path d="M11 33.5Q14 29.5 17 33.5" fill="none" stroke="${navy}" stroke-width="2.2" stroke-linecap="round"/>
            <path d="M31 33.5Q34 29.5 37 33.5" fill="none" stroke="${navy}" stroke-width="2.2" stroke-linecap="round"/>`;
    mouth = `<path d="M19.5 35Q24 40.5 28.5 35Z" fill="${navy}"/><path d="M21.5 37.4Q24 39 26.5 37.4" fill="none" stroke="#E0312B" stroke-width="1.4" stroke-linecap="round"/>`;
    extra = `<circle cx="10" cy="37.5" r="1.8" fill="#FF8A8A" opacity=".55"/><circle cx="38" cy="37.5" r="1.8" fill="#FF8A8A" opacity=".55"/>`;
  } else if(state === 'sad'){
    eyes = `<circle cx="14" cy="33" r="3.4" fill="#fff" stroke="${navy}" stroke-width="1.4"/><circle cx="14" cy="34" r="1.5" fill="${navy}"/>
            <circle cx="34" cy="33" r="3.4" fill="#fff" stroke="${navy}" stroke-width="1.4"/><circle cx="34" cy="34" r="1.5" fill="${navy}"/>
            <path d="M10.5 28.8L17 30.4M37.5 28.8L31 30.4" stroke="${navy}" stroke-width="1.6" stroke-linecap="round"/>`;
    mouth = `<path d="M20.5 38.5Q24 35.5 27.5 38.5" fill="none" stroke="${navy}" stroke-width="2" stroke-linecap="round"/>`;
    extra = `<path d="M40.5 17Q42.5 20.5 40.5 22Q38.5 20.5 40.5 17Z" fill="#6FB6FF"/>`;
  } else {
    eyes = `<circle cx="14" cy="33" r="3.4" fill="#fff" stroke="${navy}" stroke-width="1.4"/><circle cx="14.4" cy="33" r="1.6" fill="${navy}"/>
            <circle cx="34" cy="33" r="3.4" fill="#fff" stroke="${navy}" stroke-width="1.4"/><circle cx="34.4" cy="33" r="1.6" fill="${navy}"/>`;
    mouth = `<path d="M21 37.2Q24 38.8 27 37.2" fill="none" stroke="${navy}" stroke-width="2" stroke-linecap="round"/>`;
  }
  // franja reflectante (cuadros verde/amarillo)
  let checks = '';
  for(let i=0;i<9;i++){
    checks += `<rect x="${6+i*4}" y="25" width="4" height="4" fill="${i%2? '#2FA35B':'#F5C518'}"/>`;
  }
  const rays = sirenOn ? `<g stroke="#2F8CFF" stroke-width="1.6" stroke-linecap="round" class="siren-a"><path d="M13 5L10 3"/><path d="M12 8.5H8.5"/></g>
                          <g stroke="#E0312B" stroke-width="1.6" stroke-linecap="round" class="siren-b"><path d="M35 5L38 3"/><path d="M36 8.5H39.5"/></g>` : '';
  return `<svg width="${size}" height="${size}" viewBox="0 0 48 48" aria-hidden="true">
    ${rays}
    <rect x="16" y="4.5" width="8" height="6" rx="2" fill="${sirenCol}" class="${sirenOn?'siren-a':''}"/>
    <rect x="24" y="4.5" width="8" height="6" rx="2" fill="${sirenCol2}" class="${sirenOn?'siren-b':''}"/>
    <rect x="9" y="41" width="7" height="5" rx="1.5" fill="${navy}"/>
    <rect x="32" y="41" width="7" height="5" rx="1.5" fill="${navy}"/>
    <rect x="5" y="10" width="38" height="33" rx="8" fill="#FFFFFF" stroke="${navy}" stroke-width="2"/>
    <rect x="9.5" y="13.5" width="29" height="10" rx="3" fill="#BFE0FF" stroke="${navy}" stroke-width="1.4"/>
    <path d="M13 16L17 16" stroke="#fff" stroke-width="1.6" stroke-linecap="round" opacity=".9"/>
    ${checks}
    <circle cx="24" cy="27" r="4.2" fill="#fff" stroke="${navy}" stroke-width="1"/>
    <path d="M24 24.4V29.6M21.4 27H26.6" stroke="#E0312B" stroke-width="1.9" stroke-linecap="round"/>
    ${eyes}${mouth}${extra}
  </svg>`;
}
function starOfLifeSVG(size){
  size = size || 26;
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true">
    <g fill="#1C5FB0">
      <rect x="9.6" y="1.5" width="4.8" height="21" rx="1"/>
      <rect x="9.6" y="1.5" width="4.8" height="21" rx="1" transform="rotate(60 12 12)"/>
      <rect x="9.6" y="1.5" width="4.8" height="21" rx="1" transform="rotate(120 12 12)"/>
    </g>
    <path d="M12 5V19.5" stroke="#fff" stroke-width="1.2" stroke-linecap="round"/>
    <path d="M13.6 7.2C10.6 8 10.6 10 12 10.8C13.6 11.7 13.6 13.6 12 14.4C10.6 15.1 10.8 16.6 12.6 17.2" fill="none" stroke="#fff" stroke-width="1.1" stroke-linecap="round"/>
  </svg>`;
}
function ecgSVG(){
  return `<svg class="hero-ecg" viewBox="0 0 400 60" preserveAspectRatio="none" aria-hidden="true">
    <polyline fill="none" stroke="#fff" stroke-width="2.5" stroke-linejoin="round" points="0,35 60,35 72,35 80,28 88,35 100,35 108,42 116,5 126,56 134,35 150,35 162,30 176,35 230,35 242,35 250,28 258,35 270,35 278,42 286,5 296,56 304,35 320,35 332,30 346,35 400,35"/>
  </svg>`;
}

/* ---------------- ICONOS ---------------- */
const ICON_PATHS = {
  warning: '<path d="M12 3L2 21H22L12 3Z"/><path d="M12 9V14"/><circle cx="12" cy="17.3" r="0.6" fill="currentColor" stroke="none"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7V12L15.5 14"/>',
  check: '<path d="M4 12L9.5 17.5L20 6"/>',
  cross: '<path d="M5 5L19 19M19 5L5 19"/>',
  chevronLeft: '<path d="M15 5L8 12L15 19"/>',
  chevronRight: '<path d="M9 5L16 12L9 19"/>',
  moon: '<path d="M20 14.5A8.5 8.5 0 1 1 9.5 4A6.5 6.5 0 0 0 20 14.5Z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2V4M12 20V22M4 12H2M22 12H20M4.9 4.9L6.3 6.3M17.7 17.7L19.1 19.1M4.9 19.1L6.3 17.7M17.7 6.3L19.1 4.9"/>',
  award: '<circle cx="12" cy="8" r="5"/><path d="M8.5 12.5L7 21L12 18L17 21L15.5 12.5"/>',
  pulse: '<path d="M2 12H6L8.5 6L12.5 18L15 10L16.5 12H22"/>',
  heart: '<path d="M12 20.5C12 20.5 3 15 3 8.8C3 6 5.2 4 7.8 4C9.6 4 11.2 5 12 6.5C12.8 5 14.4 4 16.2 4C18.8 4 21 6 21 8.8C21 15 12 20.5 12 20.5Z"/>',
  truck: '<path d="M2 16V6.5C2 5.7 2.7 5 3.5 5H14V16"/><path d="M14 9H18L21.5 12.5V16H14"/><circle cx="6.5" cy="17.5" r="2"/><circle cx="17.5" cy="17.5" r="2"/><path d="M8 9.5H10M9 8.5V10.5" stroke-width="2"/>',
  chat: '<path d="M4 5H20V15H10L5 19V15H4Z"/><path d="M12 12.2C12 12.2 9 10.4 9 8.7C9 7.9 9.6 7.3 10.4 7.3C11 7.3 11.6 7.6 12 8.2C12.4 7.6 13 7.3 13.6 7.3C14.4 7.3 15 7.9 15 8.7C15 10.4 12 12.2 12 12.2Z"/>',
  briefcase: '<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M9 7V5.5C9 4.7 9.7 4 10.5 4H13.5C14.3 4 15 4.7 15 5.5V7"/><path d="M3 12.5H21"/>',
  monitor: '<rect x="3" y="4" width="18" height="12" rx="1.5"/><path d="M8 20H16M12 16V20"/><path d="M7 12L10 9L12.5 11L16.5 7.5"/>',
  book: '<path d="M4 5C4 4.4 4.4 4 5 4H11V20H5C4.4 20 4 19.6 4 19Z"/><path d="M20 5C20 4.4 19.6 4 19 4H13V20H19C19.6 20 20 19.6 20 19Z"/>',
  siren: '<path d="M6 18V12C6 8.7 8.7 6 12 6C15.3 6 18 8.7 18 12V18"/><path d="M4 18H20V21H4Z"/><path d="M12 2V3.5M4.2 5.2L5.3 6.3M19.8 5.2L18.7 6.3"/>',
  shield: '<path d="M12 3L20 6V12C20 16.5 16.5 20 12 21C7.5 20 4 16.5 4 12V6Z"/><path d="M12 8.5V15.5M8.5 12H15.5"/>',
  route: '<circle cx="6" cy="18" r="2.2"/><circle cx="18" cy="6" r="2.2"/><path d="M8 18H15.5C17.4 18 18.5 16.8 18.5 15.3C18.5 13.8 17.4 12.5 15.5 12.5H8.5C6.6 12.5 5.5 11.2 5.5 9.7C5.5 8.2 6.6 7 8.5 7H15.8"/>',
  medal: '<path d="M8 3L12 10L16 3"/><circle cx="12" cy="15" r="6"/><path d="M12 12.3V17.7M9.3 15H14.7"/>',
  download: '<path d="M12 3V15"/><path d="M7 10L12 15L17 10"/><path d="M4 17V20H20V17"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21C4 16.6 7.6 14 12 14C16.4 14 20 16.6 20 21"/>',
  flame: '<path d="M12 21C8 21 6 18 6 15C6 11 9 9 9 6C9 4 8 3 8 3C13 4 14 9 12 11C14 10 15 8 15 6C17 8 18 11 18 14C18 18 16 21 12 21Z"/>'
};
function icon(name, size){
  size = size || 16;
  const d = ICON_PATHS[name] || '';
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-3px" aria-hidden="true">${d}</svg>`;
}
function confettiHtml(count){
  const colors = ['#F5C518','#2FA35B','#2F8CFF','#E0312B','#FFFFFF'];
  let out = '<div class="confetti-wrap">';
  for(let i=0;i<count;i++){
    const left = Math.round(Math.random()*100);
    const delay = (Math.random()*0.35).toFixed(2);
    const dur = (0.9+Math.random()*0.8).toFixed(2);
    const color = colors[i % colors.length];
    const rot = Math.floor(Math.random()*360);
    out += `<span class="confetti-piece" style="left:${left}%; background:${color}; animation-delay:${delay}s; animation-duration:${dur}s; transform:rotate(${rot}deg);"></span>`;
  }
  return out + '</div>';
}

/* ---------------- TEMA (claro / oscuro / rosa) ---------------- */
// El botón va rotando: claro → oscuro → rosa → claro
const THEMES = ['light', 'dark', 'pink'];
const THEME_COLORS = { light:'#10233D', dark:'#10233D', pink:'#D9488F' };
const THEME_NEXT_LABEL = { light:'Modo oscuro', dark:'Modo rosa', pink:'Modo claro' };
function currentTheme(){
  const t = document.documentElement.getAttribute('data-theme');
  return t === 'dark' || t === 'pink' ? t : 'light';
}
function applyThemeIcon(){
  const t = currentTheme();
  const el = document.getElementById('themeIcon');
  if(el) el.innerHTML = icon(t === 'light' ? 'moon' : t === 'dark' ? 'heart' : 'sun', 18);
  const btn = document.getElementById('themeToggle');
  if(btn){ btn.title = THEME_NEXT_LABEL[t]; btn.setAttribute('aria-label', 'Cambiar a ' + THEME_NEXT_LABEL[t].toLowerCase()); }
  const meta = document.querySelector('meta[name="theme-color"]');
  if(meta) meta.setAttribute('content', THEME_COLORS[t]);
}
function setTheme(t){
  if(t === 'light') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', t);
  Store.setRaw(THEME_KEY, t);
  applyThemeIcon();
}
function toggleTheme(){
  const t = currentTheme();
  const next = THEMES[(THEMES.indexOf(t) + 1) % THEMES.length];
  setTheme(next);
  if(next === 'pink' && typeof burstConfetti === 'function') burstConfetti(70);
}

/* ---------------- UTIL ---------------- */
// Todo el guardado pasa por Store (store.js), así la sincronización en la nube solo toca ese módulo.
function safeGetJSON(key, fallback){ return Store.get(key, fallback); }
function safeSetJSON(key, value){ return Store.set(key, value); }
function safeRemove(key){ Store.remove(key); }
function shuffle(arr){
  const a = arr.slice();
  for(let i=a.length-1;i>0;i--){
    const j = Math.floor(Math.random()*(i+1));
    [a[i],a[j]]=[a[j],a[i]];
  }
  return a;
}
const QUESTION_BY_ID = new Map();
function rebuildIdIndex(){ QUESTION_BY_ID.clear(); QUESTIONS.forEach(q=>QUESTION_BY_ID.set(q.id, q)); }
rebuildIdIndex();
// Se llama cuando llega un banco de preguntas nuevo desde la nube
function onBankUpdated(){
  rebuildSubjectIndex();
  rebuildIdIndex();
  const onHome = document.querySelector('.home-tabs') && !document.getElementById('accountScreen') && !document.getElementById('welcomeScreen');
  if(onHome){ if(currentSubjectId) renderSubject(currentSubjectId); else renderHome(); }
}
function findQuestionById(id){ return QUESTION_BY_ID.get(id); }

/* ---------------- HISTORIAL ---------------- */
function loadHistory(){ return safeGetJSON(HISTORY_KEY, []); }
function saveHistoryEntry(entry){
  const h = loadHistory();
  h.unshift(entry);
  safeSetJSON(HISTORY_KEY, h.slice(0,80));
}
// Agrega aciertos por clave a partir del campo "field" de cada entrada del historial
function aggregate(history, field, filterFn){
  const agg = {};
  history.forEach(h=>{
    const b = h[field];
    if(!b) return;
    Object.keys(b).forEach(k=>{
      if(filterFn && !filterFn(k)) return;
      if(!agg[k]) agg[k] = {correct:0, total:0};
      agg[k].correct += b[k].correct;
      agg[k].total += b[k].total;
    });
  });
  return agg;
}

/* ---------------- BANCO DE FALLADAS (persistente) ---------------- */
function loadFailedIds(){
  // Se descartan ids que ya no existen en el banco
  return safeGetJSON(FAILED_KEY, []).filter(id=>findQuestionById(id));
}
function saveFailedIds(ids){ safeSetJSON(FAILED_KEY, ids); }
function failedIdsOf(subjectId){
  const ids = loadFailedIds();
  if(!subjectId) return ids;
  return ids.filter(id=>{ const q = findQuestionById(id); return q && q.subject === subjectId; });
}
function updateFailedBank(){
  // Se parte de lo guardado sin filtrar: si el banco aún no ha cargado alguna pregunta, no se pierde su id
  const failed = new Set(safeGetJSON(FAILED_KEY, []));
  currentTest.questions.forEach((q,i)=>{
    if(currentTest.answers[i] === q.correct) failed.delete(q.id);
    else failed.add(q.id);
  });
  saveFailedIds(Array.from(failed));
}

/* ---------------- DOMINIO TOTAL DEL BANCO ---------------- */
function loadMasteredIds(){ return safeGetJSON(MASTERY_KEY, []); }
function updateMasteredIds(){
  const mastered = new Set(loadMasteredIds());
  currentTest.questions.forEach((q,i)=>{
    if(currentTest.answers[i] === q.correct) mastered.add(q.id);
  });
  safeSetJSON(MASTERY_KEY, Array.from(mastered));
}
function isFullMastery(){
  const m = new Set(loadMasteredIds());
  return QUESTIONS.every(q=>m.has(q.id));
}

/* ---------------- MODO DEPURACIÓN ---------------- */
// Acceso oculto para probar pantallas especiales sin tocar datos guardados.
const DEBUG_PASSWORD_SHA256 = 'ebafc7f8530e495245bdfba503810ccef462ce7630766e7e1b9ec8dec07f160d';
async function sha256Hex(str){
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b=>b.toString(16).padStart(2,'0')).join('');
}
async function openDebugMode(){
  const pass = prompt('Contraseña de depuración:');
  if(pass === null) return;
  let ok = false;
  try{ ok = (await sha256Hex(pass)) === DEBUG_PASSWORD_SHA256; }catch(e){}
  if(!ok){ alert('Contraseña incorrecta.'); return; }
  showDebugPanel();
}
function showDebugPanel(){
  clearTimer();
  document.getElementById('topbarSub').textContent = 'Modo depuración';
  document.getElementById('screen').innerHTML = `
    <div class="home">
      <div class="section-label">Modo depuración</div>
      <p class="empty-hint">Estas acciones solo simulan pantallas, sin tocar tu historial, logros ni progreso reales.</p>
      <button class="btn-primary" data-action="debugShowLegendary" style="margin-bottom:10px;">Simular logro legendario</button>
      <button class="btn-secondary" data-action="debugShowPass" style="margin-bottom:10px; width:100%;">Simular aprobado + récord</button>
      <button class="btn-secondary" data-action="debugShowFail" style="margin-bottom:10px; width:100%;">Simular suspenso</button>
      <button class="btn-secondary" data-action="renderHome" style="width:100%;">Salir del modo depuración</button>
    </div>
  `;
}
function debugShowLegendary(){
  currentTest = makeTestShell('review', null, null, []);
  renderResults(180, 180, false, false, [GRAND_MASTER_ACHIEVEMENT]);
}
function debugShowPass(){
  currentTest = makeTestShell('review', null, null, []);
  renderResults(30, 36, false, true, []);
}
function debugShowFail(){
  currentTest = makeTestShell('review', null, null, []);
  renderResults(11, 36, false, false, []);
}

/* ---------------- RÉCORD PERSONAL ---------------- */
function getBestPercent(history){
  if(!history.length) return null;
  return Math.max(...history.map(h=>Math.round(h.score/(h.total||TEST_SIZE)*100)));
}

/* ---------------- LOGROS ---------------- */
const REGULAR_ACHIEVEMENTS = [
  {id:'primera_salida', icon:'siren', title:'Primera salida', desc:'Completa tu primer test.',
    check:h=>h.length>=1},
  {id:'aviso_resuelto', icon:'check', title:'Aviso resuelto', desc:'Aprueba un test por primera vez.',
    check:h=>h.some(e=>e.score>=passScoreFor(e.total||TEST_SIZE))},
  {id:'guardia_completa', icon:'clock', title:'Guardia completa', desc:'Completa 10 tests.',
    check:h=>h.length>=10},
  {id:'constantes_perfectas', icon:'heart', title:'Constantes perfectas', desc:'Saca un 100% en un test de al menos 12 preguntas.',
    check:h=>h.some(e=>(e.total||0)>=12 && e.score===e.total)},
  {id:'polivalente', icon:'route', title:'Polivalente', desc:'Haz un test de cada una de las asignaturas.',
    check:h=>{ const s=new Set(h.filter(e=>e.subject && (e.mode==='subject'||e.mode==='exam')).map(e=>e.subject)); return SUBJECTS.filter(x=>questionsOf(x.id).length).every(x=>s.has(x.id)); }},
  {id:'ritmo_sinusal', icon:'pulse', title:'Ritmo sinusal', desc:'Encadena 10 aciertos seguidos en un test.',
    check:h=>h.some(e=>(e.maxCombo||0)>=10)},
  {id:'simulacro_superado', icon:'siren', title:'Simulacro superado', desc:'Aprueba un simulacro de examen.',
    check:h=>h.some(e=>e.mode==='subject' && e.score>=passScoreFor(e.total||TEST_SIZE))},
  {id:'racha_3', icon:'flame', title:'Tres guardias seguidas', desc:'Estudia 3 días seguidos.',
    check:(h,st)=>Math.max(st.bestStreak, streakInfo(st.days).best)>=3},
  {id:'racha_7', icon:'flame', title:'Semana de guardia', desc:'Estudia 7 días seguidos.',
    check:(h,st)=>Math.max(st.bestStreak, streakInfo(st.days).best)>=7},
  {id:'racha_30', icon:'flame', title:'Un mes sin bajas', desc:'Estudia 30 días seguidos.',
    check:(h,st)=>Math.max(st.bestStreak, streakInfo(st.days).best)>=30},
  {id:'doble_turno', icon:'clock', title:'Doble turno', desc:'Haz 5 tests en un mismo día.',
    check:(h,st)=>Object.keys(st.days).some(k=>(st.days[k].t||0)>=5)},
  {id:'turno_noche', icon:'moon', title:'Turno de noche', desc:'Termina un test entre las 0:00 y las 6:00.',
    check:h=>h.some(e=>{ const hr = new Date(e.date).getHours(); return hr < 6; })},
  {id:'mil_aciertos', icon:'award', title:'Mil pacientes atendidos', desc:'Llega a 1.000 aciertos en total.',
    check:(h,st)=>Object.keys(st.days).reduce((n,k)=>n+(st.days[k].c||0),0)>=1000},
  {id:'especialista', icon:'shield', title:'Especialista', desc:'Domina el 100% de las preguntas de una asignatura.',
    check:()=>SUBJECTS.some(x=>questionsOf(x.id).length && subjectMastery(x.id)===100)},
  {id:'jefe_dotacion', icon:'truck', title:'Jefe de dotación', desc:'Alcanza el rango de Jefe de dotación.',
    check:(h,st)=>rankFor(st.xp).idx>=4},
  {id:'duelista', icon:'award', title:'Duelista', desc:'Gana un duelo contra un compañero.', social:true,
    check:(h,st)=>st.duelsWon.length>=1},
];
const GRAND_MASTER_ACHIEVEMENT = {
  id:'leyenda_112', icon:'medal', title:'Leyenda del 112',
  desc:`Consigue todos los demás logros (menos el de duelos) y acierta alguna vez las ${QUESTIONS.length} preguntas del banco.`,
  legendary:true,
  check:(h,st) => REGULAR_ACHIEVEMENTS.filter(a=>!a.social).every(a=>a.check(h,st) || st.badges.includes(a.id)) && isFullMastery()
};
const ACHIEVEMENTS = [...REGULAR_ACHIEVEMENTS, GRAND_MASTER_ACHIEVEMENT];
function getAchievements(history){
  const st = loadStats();
  return ACHIEVEMENTS.map(a=>{ let earned = st.badges.includes(a.id); if(!earned){ try{ earned = !!a.check(history, st); }catch(e){} } return {...a, earned}; });
}
function computeMaxCombo(test){
  let maxCombo=0, run=0;
  test.questions.forEach((q,i)=>{
    if(test.answers[i]===q.correct){ run++; if(run>maxCombo) maxCombo=run; }
    else{ run=0; }
  });
  return maxCombo;
}
function currentCombo(){
  if(!currentTest) return 0;
  let idx = currentTest.answers.length-1;
  while(idx>=0 && currentTest.answers[idx]===null) idx--;
  let combo=0;
  while(idx>=0 && currentTest.answers[idx]!==null && currentTest.answers[idx]===currentTest.questions[idx].correct){
    combo++; idx--;
  }
  return combo;
}

/* ---------------- PROGRESO (continuar test) ---------------- */
let saveProgressTimer = null;
function writeProgressNow(){
  if(saveProgressTimer){ clearTimeout(saveProgressTimer); saveProgressTimer = null; }
  if(currentTest) safeSetJSON(PROGRESS_KEY, {currentTest, currentIndex, savedAt:Date.now()});
}
function saveProgress(){
  if(saveProgressTimer) clearTimeout(saveProgressTimer);
  saveProgressTimer = setTimeout(writeProgressNow, 400);
}
function loadProgress(){ return safeGetJSON(PROGRESS_KEY, null); }
function clearProgress(){
  if(saveProgressTimer){ clearTimeout(saveProgressTimer); saveProgressTimer = null; }
  safeRemove(PROGRESS_KEY);
}
window.addEventListener('pagehide', ()=>{ if(saveProgressTimer) writeProgressNow(); });
document.addEventListener('visibilitychange', ()=>{ if(document.visibilityState === 'hidden' && saveProgressTimer) writeProgressNow(); });

/* ---------------- BARAJADO ---------------- */
// Opciones que hacen referencia a otras por letra/posición: no se barajan.
const NO_SHUFFLE_PATTERNS = [
  /\b[a-dA-D]\s+y\s+[a-dA-D]\b/,
  /\brespuestas?\s+[a-dA-D]\b/i,
  /anteriores/i,
  /todas\s+(las\s+)?(respuestas\s+)?son\s+correctas/i,
  /ninguna\s+(de\s+las\s+)?(es|son)\s+correcta/i,
  /solo\s+la\s+[a-dA-D]\b/i,
  /\bambas\b/i,
];
function needsFixedOrder(q){ return q.options.length <= 2 || q.options.some(opt => NO_SHUFFLE_PATTERNS.some(p=>p.test(opt))); }
function shuffleQuestionOptions(q){
  const base = { id:q.id, subject:q.subject, exam:q.exam, text:q.text, unverified:!!q.u };
  if(needsFixedOrder(q)) return { ...base, options:q.options.slice(), correct:q.correct };
  const shuffled = shuffle(q.options.map((_,i)=>i));
  return { ...base, options:shuffled.map(i=>q.options[i]), correct:shuffled.indexOf(q.correct) };
}
function modeLabel(test){
  const s = test.subject ? getSubject(test.subject) : null;
  if(test.mode === 'subject') return s.short + ' · Simulacro';
  if(test.mode === 'exam') return s.short + ' · ' + test.label;
  if(test.mode === 'review') return 'Repaso de falladas';
  if(test.mode === 'failed') return 'Falladas guardadas' + (s ? ' · ' + s.short : '');
  if(test.mode === 'unverified') return 'Preguntas no verificadas';
  if(test.mode === 'duel') return 'Duelo' + (s ? ' · ' + s.short : '');
  return 'Test';
}
function historyTag(h){
  const s = h.subject ? getSubject(h.subject) : null;
  if(h.mode === 'subject') return 'Simulacro · ' + s.short;
  if(h.mode === 'exam') return s.short + ' · ' + h.label;
  if(h.mode === 'review' || h.mode === 'failed') return 'Repaso' + (s ? ' · ' + s.short : '');
  if(h.mode === 'unverified') return 'Revisión';
  if(h.mode === 'duel') return 'Duelo' + (s ? ' · ' + s.short : '');
  return 'Test';
}

/* ---------------- CONSTRUCCIÓN DE TESTS ---------------- */
function makeTestShell(mode, subject, label, questions){
  return { mode, subject, label, questions, answers:new Array(questions.length).fill(null), phrases:new Array(questions.length).fill(null), timed:false, endTime:null };
}
/* ---------------- SELECCIÓN ALEATORIA SIN REPETICIONES ---------------- */
function normText(t){ return String(t).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/[^a-z0-9]+/g,' ').trim(); }
// Elimina duplicados: mismo id, o mismo enunciado con la misma respuesta correcta
// (por si una pregunta se repite en dos tests distintos de la plataforma).
function dedupe(pool){
  const seenIds = new Set(), seenKeys = new Set(), out = [];
  pool.forEach(q=>{
    const key = normText(q.text) + '|' + normText(q.options[q.correct]);
    if(seenIds.has(q.id) || seenKeys.has(key)) return;
    seenIds.add(q.id); seenKeys.add(key); out.push(q);
  });
  return out;
}
function loadSeen(){ const v = safeGetJSON(SEEN_KEY, null); return (v && v.last) ? v : {n:0, last:{}}; }
function loadRecent(){ return safeGetJSON(RECENT_KEY, {}); }
// Reparte "size" preguntas sin repetir ninguna dentro del test y evitando las
// que salieron en los tests aleatorios anteriores del mismo ámbito:
//   1º preguntas que no salieron en los 2 últimos tests,
//   2º las del penúltimo test, 3º (solo si no queda otra) las del último.
// Dentro de cada nivel se prioriza lo que lleva más tiempo sin salir y se
// reparte por turnos entre temas/asignaturas para que todos estén representados.
function pickFresh(pool, keyFn, size, scope){
  pool = dedupe(pool);
  const seen = loadSeen();
  const recent = loadRecent()[scope] || [];
  const last = new Set(recent[0] || []), prev = new Set(recent[1] || []);
  const tierOf = q => last.has(q.id) ? 2 : (prev.has(q.id) ? 1 : 0);
  const age = q => (q.id in seen.last) ? seen.last[q.id] : -1;
  const picked = [], used = new Set();
  for(let tier=0; tier<=2 && picked.length<size; tier++){
    const groups = {};
    pool.filter(q=>tierOf(q)===tier).forEach(q=>{ const k = keyFn(q); (groups[k] = groups[k] || []).push(q); });
    // orden: lo más antiguo primero; empates al azar
    const lists = shuffle(Object.keys(groups)).map(k=>shuffle(groups[k]).sort((x,y)=>age(x)-age(y)));
    let added = true;
    while(picked.length < size && added){
      added = false;
      for(const l of lists){
        if(picked.length >= size) break;
        const q = l.shift();
        if(q && !used.has(q.id)){ picked.push(q); used.add(q.id); added = true; }
      }
    }
  }
  return shuffle(picked);
}
// Guarda qué preguntas han salido, para que el siguiente test las evite.
function rememberTest(questions, scope){
  const seen = loadSeen();
  seen.n++;
  questions.forEach(q=>{ seen.last[q.id] = seen.n; });
  safeSetJSON(SEEN_KEY, seen);
  const recent = loadRecent();
  recent[scope] = [questions.map(q=>q.id), (recent[scope] && recent[scope][0]) || []];
  safeSetJSON(RECENT_KEY, recent);
}
function buildSubjectTest(subjectId){
  const scope = 'subject:' + subjectId;
  const picked = pickFresh(questionsOf(subjectId), q=>q.exam, TEST_SIZE, scope);
  rememberTest(picked, scope);
  return makeTestShell('subject', subjectId, null, picked.map(shuffleQuestionOptions));
}
function buildExamTest(subjectId, tema){
  const picked = shuffle(dedupe(questionsOf(subjectId).filter(q=>q.exam === tema)));
  return makeTestShell('exam', subjectId, tema, picked.map(shuffleQuestionOptions));
}
function buildReviewTest(ids, mode, subjectId){
  const picked = shuffle(dedupe(ids.map(findQuestionById).filter(Boolean)));
  return makeTestShell(mode || 'review', subjectId || null, null, picked.map(shuffleQuestionOptions));
}

function applyTimedMode(){
  const chk = document.getElementById('timedMode');
  if(chk && chk.checked){
    currentTest.timed = true;
    currentTest.endTime = Date.now() + TIMED_SECONDS*1000;
  }
}
function launch(test, allowTimed){
  if(!test.questions.length) return;
  currentTest = test;
  lastQuizIndex = -1;
  if(allowTimed) applyTimedMode();
  currentIndex = 0;
  saveProgress();
  startTimerIfNeeded();
  window.scrollTo(0,0);
  renderQuiz();
}
function startSubjectTest(subjectId){ launch(buildSubjectTest(subjectId), true); }
function startExamTest(subjectId, temaIdx){
  const tema = temasOf(subjectId)[temaIdx];
  if(tema === undefined) return;
  launch(buildExamTest(subjectId, tema), true);
}
function startExamTestByName(subjectId, tema){ launch(buildExamTest(subjectId, tema), true); }
function startReviewTest(ids, mode, subjectId){
  if(!ids || !ids.length) return;
  launch(buildReviewTest(ids, mode, subjectId), false);
}
function reviewFailed(){ startReviewTest(lastWrongIds, 'review', currentTest && currentTest.subject); }
function startUnverifiedTest(subjectId){
  startReviewTest(QUESTIONS.filter(q=>q.u && (!subjectId || q.subject===subjectId)).map(q=>q.id), 'unverified', subjectId);
}
function startFailedTest(subjectId){
  const ids = failedIdsOf(subjectId);
  if(!ids.length) return;
  startReviewTest(shuffle(ids).slice(0, TEST_SIZE), 'failed', subjectId);
}
function repeatTest(){
  const t = currentTest;
  if(t.mode === 'exam') startExamTestByName(t.subject, t.label);
  else if(t.mode === 'subject') startSubjectTest(t.subject);
  else if(t.mode === 'review') startReviewTest(t.questions.map(q=>q.id), 'review', t.subject);
  else if(t.mode === 'unverified') startUnverifiedTest(t.subject);
  else if(t.mode === 'failed') startFailedTest(t.subject);
  else if(t.mode === 'duel') openDuels();
  else renderHome();
}
function continueTest(){
  const p = loadProgress();
  if(!p || !p.currentTest){ renderHome(); return; }
  currentTest = p.currentTest;
  currentIndex = p.currentIndex;
  startTimerIfNeeded();
  renderQuiz();
}
function discardProgress(){
  clearProgress();
  if(currentSubjectId) renderSubject(currentSubjectId); else renderHome();
}
function backToMenu(){
  if(currentTest && currentTest.mode === 'duel'){ openDuels(); return; }
  if(currentTest && currentTest.subject) renderSubject(currentTest.subject);
  else renderHome();
}

/* ---------------- TEMPORIZADOR ---------------- */
function clearTimer(){ if(timerInterval){ clearInterval(timerInterval); timerInterval = null; } }
function startTimerIfNeeded(){
  clearTimer();
  if(currentTest && currentTest.timed) timerInterval = setInterval(updateTimerDisplay, 1000);
}
function updateTimerDisplay(){
  const el = document.getElementById('timerDisplay');
  if(!el || !currentTest || !currentTest.timed) return;
  const remaining = Math.max(0, currentTest.endTime - Date.now());
  const mins = Math.floor(remaining/60000);
  const secs = Math.floor((remaining%60000)/1000);
  el.innerHTML = `${icon('clock',13)} ${mins}:${secs.toString().padStart(2,'0')}`;
  el.classList.toggle('warn', remaining < 5*60*1000);
  if(remaining <= 0){ clearTimer(); finishTest(true); }
}

/* ---------------- COMPONENTES COMUNES ---------------- */
function continueBannerHtml(){
  const progress = loadProgress();
  if(!progress || !progress.currentTest || !progress.currentTest.questions) return '';
  const total = progress.currentTest.questions.length;
  return `
    <div class="continue-banner">
      <div class="cb-text">${icon('siren',15)} Tienes un test en curso: <b>${escapeHtml(modeLabel(progress.currentTest))}</b> · Pregunta ${progress.currentIndex+1} de ${total}</div>
      <div class="cb-actions">
        <button class="btn-secondary" data-action="discardProgress">Descartar</button>
        <button class="btn-primary" data-action="continueTest">Continuar</button>
      </div>
    </div>`;
}
function historyListHtml(history, emptyText){
  if(!history.length) return `<p class="empty-hint">${emptyText}</p>`;
  return '<div class="history">' + history.slice(0,8).map(h=>{
    const total = h.total || TEST_SIZE;
    const pass = h.score >= passScoreFor(total);
    const dateStr = new Date(h.date).toLocaleDateString('es-ES',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'});
    return `<div class="history-item">
      <span>${dateStr} <span style="color:var(--text-muted);font-size:12px;">· ${escapeHtml(historyTag(h))}</span></span>
      <span class="score ${pass?'pass':'fail'}">${h.score}/${total}</span>
    </div>`;
  }).join('') + '</div>';
}
function statsListHtml(agg, labelFn, emptyText){
  const keys = Object.keys(agg);
  if(!keys.length) return `<p class="empty-hint">${emptyText}</p>`;
  return '<div class="stats-list">' + keys.map(k=>{
    const s = agg[k];
    const pct = Math.round(s.correct/s.total*100);
    return `<div class="stats-item">
      <div class="si-top"><b>${escapeHtml(labelFn(k))}</b><span>${pct}% (${s.correct}/${s.total})</span></div>
      <div class="stats-bar"><div class="stats-bar-fill ${pct<50?'low':''}" style="width:${pct}%"></div></div>
    </div>`;
  }).join('') + '</div>';
}
function timedToggleHtml(){
  return `<label class="mode-toggle"><input type="checkbox" id="timedMode"> ${icon('clock',15)} Modo cronometrado (45 min)</label>`;
}

/* ---------------- FECHAS DE EXAMEN Y PLAN DIARIO ---------------- */
function todayStart(){ const d = new Date(); d.setHours(0,0,0,0); return d; }
function parseDay(str){ const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str || ''); return m ? new Date(+m[1], +m[2]-1, +m[3]) : null; }
function daysUntil(str){ const d = parseDay(str); return d ? Math.round((d - todayStart()) / 86400000) : null; }
function formatDay(str){ const d = parseDay(str); return d ? d.toLocaleDateString('es-ES', {weekday:'long', day:'numeric', month:'long'}) : ''; }
// Fecha del examen: la que ponga el alumno o, si no, la oficial de la asignatura (Supabase)
// Fecha oficial del examen, igual para todos (se gestiona en Supabase y no se puede cambiar desde la app)
function examDateOf(subjectId){ return getSubject(subjectId).exam_date || ''; }
// Plan: ver cada pregunta no dominada al menos dos veces antes del examen
function examPlan(subjectId){
  const date = examDateOf(subjectId);
  const days = daysUntil(date);
  if(days === null || days < 0) return null;
  const qs = questionsOf(subjectId);
  const mastered = new Set(loadMasteredIds());
  const pending = qs.filter(q=>!mastered.has(q.id)).length;
  const perTest = Math.max(1, Math.min(TEST_SIZE, qs.length));
  const testsNeeded = Math.ceil(pending * 2 / perTest);
  const perDay = days === 0 ? 1 : Math.min(5, Math.max(1, Math.ceil(testsNeeded / days)));
  const t0 = todayStart().getTime();
  const doneToday = loadHistory().filter(h=>h.subject === subjectId && h.date >= t0).length;
  return { date, days, pending, perDay, doneToday };
}
function examCountdownLabel(days){
  if(days === 0) return '¡Examen hoy!';
  if(days === 1) return 'Examen mañana';
  return 'Examen en ' + days + ' días';
}
function examChipHtml(subjectId){
  const plan = examPlan(subjectId);
  if(!plan) return '';
  const cls = plan.days <= 3 ? 'hot' : plan.days <= 7 ? 'warm' : '';
  return `<span class="exam-chip ${cls}">${icon('clock',12)} ${examCountdownLabel(plan.days)}</span>`;
}
function planDotsHtml(plan){
  let out = '';
  for(let i=0;i<plan.perDay;i++) out += `<i class="${i < plan.doneToday ? 'on' : ''}"></i>`;
  return `<span class="plan-dots" aria-label="${Math.min(plan.doneToday, plan.perDay)} de ${plan.perDay} tests hechos hoy">${out}</span>`;
}
function planText(plan){
  if(plan.days === 0) return '¡Hoy toca! Un último repaso tranquilo y a por ello.';
  if(plan.doneToday >= plan.perDay) return `Plan de hoy cumplido (${plan.doneToday}/${plan.perDay}). ¡Así se hace!`;
  return `Hoy: ${plan.doneToday}/${plan.perDay} tests · te quedan ${plan.pending} preguntas por dominar`;
}
// Tarjeta del examen más cercano en la portada
function nextExamCardHtml(){
  const plans = SUBJECTS.map(s=>({ s, plan: examPlan(s.id) })).filter(x=>x.plan && questionsOf(x.s.id).length);
  if(!plans.length) return '';
  plans.sort((a,b)=>a.plan.days - b.plan.days);
  const { s, plan } = plans[0];
  const done = plan.doneToday >= plan.perDay;
  return `<div class="next-exam ${plan.days <= 3 ? 'hot' : ''}" style="--sc:${s.color}">
    <div class="ne-count"><b>${plan.days}</b><span>${plan.days === 1 ? 'día' : 'días'}</span></div>
    <div class="ne-body">
      <span class="ne-eyebrow">Próximo examen · ${escapeHtml(formatDay(plan.date))}</span>
      <b>${escapeHtml(s.name)}</b>
      <div class="ne-plan">${planDotsHtml(plan)} <span>${escapeHtml(planText(plan))}</span></div>
    </div>
    <button class="btn-mini ${done ? 'ghost' : ''}" data-action="startSubjectTest" data-args='["${s.id}"]'>${done ? 'Otro más' : 'Hacer test'}</button>
  </div>`;
}
// Bloque de fecha de examen en la pantalla de la asignatura
function examDateBlockHtml(subjectId){
  const date = examDateOf(subjectId);
  if(!date) return '';
  const plan = examPlan(subjectId);
  return `<div class="section-label">Fecha del examen</div>
  <div class="exam-date-card">
    <div class="ed-field"><span>${icon('clock',15)} ${escapeHtml(formatDay(date))}</span></div>
    ${plan ? `<div class="ed-plan">
        <b>${examCountdownLabel(plan.days)}</b>
        <div class="ne-plan">${planDotsHtml(plan)} <span>${escapeHtml(planText(plan))}</span></div>
        <span class="ed-hint">Recomendación: ${plan.perDay} ${plan.perDay === 1 ? 'test' : 'tests'} al día para ver dos veces cada pregunta que aún no dominas.</span>
      </div>` : `<div class="ed-plan"><span class="ed-hint">Este examen ya se ha celebrado.</span></div>`}
  </div>`;
}

/* ---------------- INSTALAR LA APP (PWA) ---------------- */
let deferredInstallPrompt = null;
const INSTALL_DISMISSED_KEY = 'tes_install_dismissed_v1';
function isStandalone(){ return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone === true; }
function isIOS(){ return /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1); }
window.addEventListener('beforeinstallprompt', e=>{ e.preventDefault(); deferredInstallPrompt = e; if(document.querySelector('.home-tabs') && !currentSubjectId) renderHome(); });
window.addEventListener('appinstalled', ()=>{ deferredInstallPrompt = null; Store.setRaw(INSTALL_DISMISSED_KEY, '1'); });
function installBannerHtml(){
  if(isStandalone() || Store.getRaw(INSTALL_DISMISSED_KEY)) return '';
  if(deferredInstallPrompt){
    return `<div class="install-banner">${icon('download',18)}<span><b>Instala TES Test</b> en tu móvil: icono propio y funciona sin cobertura.</span>
      <button class="btn-mini" data-action="installApp">Instalar</button><button class="ib-close" data-action="dismissInstall" aria-label="Cerrar">${icon('cross',14)}</button></div>`;
  }
  if(isIOS()){
    return `<div class="install-banner">${icon('download',18)}<span><b>Instala TES Test</b>: en Safari pulsa Compartir y luego "Añadir a pantalla de inicio".</span>
      <button class="ib-close" data-action="dismissInstall" aria-label="Cerrar">${icon('cross',14)}</button></div>`;
  }
  return '';
}
async function installApp(){
  if(!deferredInstallPrompt) return;
  deferredInstallPrompt.prompt();
  try{ await deferredInstallPrompt.userChoice; }catch(e){}
  deferredInstallPrompt = null;
  renderHome();
}
function dismissInstall(){ Store.setRaw(INSTALL_DISMISSED_KEY, '1'); renderHome(); }

/* ---------------- RENDER: HOME ---------------- */
function renderHome(){
  if(saveProgressTimer) writeProgressNow();
  clearTimer();
  currentSubjectId = null;
  document.getElementById('topbarSub').textContent = 'Técnico en Emergencias Sanitarias';
  const history = loadHistory();
  const unverifiedCount = QUESTIONS.filter(q=>q.u).length;
  const failedCount = loadFailedIds().length;

  const subjectsHtml = '<div class="subject-list">' + SUBJECTS.map(s=>{
    const n = questionsOf(s.id).length;
    const nt = temasOf(s.id).length;
    const m = subjectMastery(s.id);
    return `<button type="button" class="subject-card" style="--sc:${s.color}" data-action="openSubject" data-args='["${s.id}"]' ${n?'':'disabled'}>
      <div class="sc-ring" style="--p:${m}" aria-hidden="true"><div class="sc-icon">${icon(s.icon, 24)}</div></div>
      <div class="sc-body">
        <b>${escapeHtml(s.name)}</b>
        <span>${n ? `${n} preguntas · ${nt} ${nt===1?'tema':'temas'} · ${m}% dominado` : 'Próximamente'}</span>
        ${n ? examChipHtml(s.id) : ''}
        <div class="sc-meter"><div style="width:${m}%"></div></div>
      </div>
      <div class="sc-arrow">${icon('chevronRight',18)}</div>
    </button>`;
  }).join('') + '</div>';

  const bestPercent = getBestPercent(history);
  const achievements = getAchievements(history);
  const earnedCount = achievements.filter(a=>a.earned).length;
  const achvHtml = `<p class="achv-count">${earnedCount} de ${achievements.length} conseguidos</p>` + '<div class="achv-grid">' + achievements.map(a=>`
    <div class="achv-item ${a.earned?'':'locked'} ${a.legendary?'legendary':''}">
      <div class="achv-icon">${icon(a.icon || 'award', a.legendary?26:22)}</div>
      <b>${a.title}</b>
      <span>${a.desc}</span>
    </div>
  `).join('') + '</div>';

  const subjAgg = aggregate(history, 'subjBreakdown');
  const orderedAgg = {};
  SUBJECTS.forEach(s=>{ if(subjAgg[s.id]) orderedAgg[s.id] = subjAgg[s.id]; });

  document.getElementById('screen').innerHTML = `
    <div class="home">
      ${continueBannerHtml()}
      ${installBannerHtml()}
      <div class="hero">
        ${ecgSVG()}
        <div class="hero-top">
          <div class="hero-mascot mascot-idle">${mascotSVG('happy', 76)}</div>
          <div>
            <h2>Prepárate<br>para la <em>guardia</em></h2>
          </div>
        </div>
        <p>Elige una asignatura y entrena por temas o con simulacros de examen de esa asignatura.</p>
        <div class="stat-row">
          <div class="stat"><b>${QUESTIONS.length}</b><span>preguntas</span></div>
          <div class="stat"><b>${SUBJECTS.length}</b><span>asignaturas</span></div>
          <div class="stat"><b>${SUBJECTS.reduce((n,x)=>n+temasOf(x.id).length,0)}</b><span>temas</span></div>
        </div>
      </div>

      ${playerCardHtml()}

      <div class="home-tabs four">
        <button class="home-tab ${homeTab==='asignaturas'?'active':''}" data-action="switchHomeTab" data-args='["asignaturas"]'>Asignaturas</button>
        <button class="home-tab ${homeTab==='progreso'?'active':''}" data-action="switchHomeTab" data-args='["progreso"]'>Progreso</button>
        <button class="home-tab ${homeTab==='ranking'?'active':''}" data-action="switchHomeTab" data-args='["ranking"]'>Ranking</button>
        <button class="home-tab ${homeTab==='duelos'?'active':''}" data-action="switchHomeTab" data-args='["duelos"]'>Duelos${Store.getRaw(PENDING_DUEL_KEY) ? ' <i class="tab-dot"></i>' : ''}</button>
      </div>

      ${homeTab === 'asignaturas' ? `
      ${nextExamCardHtml()}
      <div class="section-label">Elige asignatura</div>
      ${subjectsHtml}

      ` : homeTab === 'ranking' ? `
      <div id="rankingBox" class="ranking-box"><p class="empty-hint">Cargando ranking…</p></div>
      ` : homeTab === 'duelos' ? `
      <div id="duelsBox" class="duels-box"></div>
      ` : `
      <div class="section-label">Calendario de estudio</div>
      ${calendarHtml()}

      <div class="section-label">Rangos</div>
      ${ranksListHtml()}

      ${bestPercent !== null ? `
      <div class="section-label">Récord personal</div>
      <div class="record-card">
        <div class="record-icon">${icon('award',24)}</div>
        <div><b>${bestPercent}%</b><span>Tu mejor resultado hasta ahora. ¡A por más!</span></div>
      </div>` : ''}

      <div class="section-label">Logros</div>
      ${achvHtml}

      <div class="section-label">Rendimiento por asignatura</div>
      ${statsListHtml(orderedAgg, k=>getSubject(k).name, 'Haz al menos un test para ver tu rendimiento por asignatura.')}

      <div class="section-label">Últimos resultados</div>
      ${historyListHtml(history, 'Todavía no has hecho ningún test. ¡Primera salida cuando quieras!')}
      `}
    </div>
    <footer class="note">Aprobado orientativo: 50% de aciertos. Contrasta siempre con tus apuntes y el material oficial del ciclo.</footer>
  `;
  if(homeTab === 'ranking') Cloud.renderRanking(document.getElementById('rankingBox'));
  if(homeTab === 'duelos') renderDuelsTab(document.getElementById('duelsBox'));
}
function switchHomeTab(tab){ homeTab = tab; renderHome(); }

/* ---------------- RENDER: ASIGNATURA ---------------- */
function openSubject(id){ subjectTab = 'practicar'; renderSubject(id); window.scrollTo(0,0); }
function renderSubject(id){
  clearTimer();
  currentSubjectId = id;
  const s = getSubject(id);
  document.getElementById('topbarSub').textContent = s.name;
  const qs = questionsOf(id);
  const temas = temasOf(id);
  const failedCount = failedIdsOf(id).length;
  const unvCount = qs.filter(q=>q.u).length;
  const history = loadHistory().filter(h=>h.subject === id);
  const m = subjectMastery(id);

  const temaAgg = aggregate(loadHistory(), 'temaBreakdown', k=>k.startsWith(id+'::'));
  const temaOrdered = {};
  temas.forEach(t=>{ const k = id+'::'+t; if(temaAgg[k]) temaOrdered[k] = temaAgg[k]; });

  document.getElementById('screen').innerHTML = `
    <div class="home" style="--sc:${s.color}">
      <button class="back-link" data-action="renderHome">${icon('chevronLeft',16)} Asignaturas</button>
      ${continueBannerHtml()}
      <div class="subject-hero">
        <div class="sh-top">
          <div class="sc-icon">${icon(s.icon, 26)}</div>
          <h2>${escapeHtml(s.name)}</h2>
        </div>
        <div class="stat-row">
          <div class="stat"><b>${qs.length}</b><span>preguntas</span></div>
          <div class="stat"><b>${temas.length}</b><span>${temas.length===1?'tema':'temas'}</span></div>
          <div class="stat"><b>${m}%</b><span>dominado</span></div>
        </div>
        ${timedToggleHtml()}
      </div>

      <button class="btn-primary" data-action="startSubjectTest" data-args='["${id}"]'>${icon('siren',20)} Simulacro de examen</button>
      <p class="sim-hint">${Math.min(TEST_SIZE, qs.length)} preguntas al azar de todos los temas, priorizando las que no salieron en el simulacro anterior.</p>
      ${examDateBlockHtml(id)}

      <div class="home-tabs">
        <button class="home-tab ${subjectTab==='practicar'?'active':''}" data-action="switchSubjectTab" data-args='["practicar"]'>Practicar</button>
        <button class="home-tab ${subjectTab==='progreso'?'active':''}" data-action="switchSubjectTab" data-args='["progreso"]'>Progreso</button>
      </div>

      ${subjectTab === 'practicar' ? `
      <div class="section-label">Practicar por tema</div>
      <div class="exam-list">
        ${temas.map((t,i)=>`
          <div class="exam-practice-item">
            <div class="epi-info"><b>${escapeHtml(t)}</b><span>${qs.filter(q=>q.exam===t).length} preguntas</span></div>
            <button class="btn-mini" data-action="startExamTest" data-args='["${id}", ${i}]'>Practicar</button>
          </div>`).join('')}
      </div>

      ${failedCount > 0 ? `
      <div class="section-label">Repaso</div>
      <div class="exam-practice-item">
        <div class="epi-info"><b>${icon('flame',15)} Falladas de la asignatura</b><span>${Math.min(failedCount, TEST_SIZE)}${failedCount > TEST_SIZE ? ' de '+failedCount : ''} preguntas guardadas</span></div>
        <button class="btn-mini" data-action="startFailedTest" data-args='["${id}"]'>Repasar</button>
      </div>` : ''}

      ${unvCount > 0 ? `
      <div class="section-label">Revisión</div>
      <div class="exam-practice-item">
        <div class="epi-info"><b>${icon('warning',15)} Preguntas no verificadas</b><span>${unvCount} ${unvCount===1?'pregunta':'preguntas'} sin confirmar oficialmente</span></div>
        <button class="btn-mini" data-action="startUnverifiedTest" data-args='["${id}"]'>Repasar</button>
      </div>` : ''}
      ` : `
      <div class="section-label">Rendimiento por tema</div>
      ${statsListHtml(temaOrdered, k=>k.split('::').slice(1).join('::'), 'Haz algún test de esta asignatura para ver tu rendimiento por tema.')}

      <div class="section-label">Últimos resultados</div>
      ${historyListHtml(history, 'Aún no has hecho tests de esta asignatura.')}
      `}
    </div>
    <footer class="note">Aprobado orientativo: 50% de aciertos. Contrasta siempre con tus apuntes y el material oficial del ciclo.</footer>
  `;
}
function switchSubjectTab(tab){ subjectTab = tab; renderSubject(currentSubjectId); }

/* ---------------- RENDER: QUIZ ---------------- */
function renderQuiz(){
  const total = currentTest.questions.length;
  document.getElementById('topbarSub').textContent = `${modeLabel(currentTest)} · ${currentIndex+1}/${total}`;
  const q = currentTest.questions[currentIndex];
  const subj = getSubject(q.subject);
  const userAnswer = currentTest.answers[currentIndex];
  const answered = userAnswer !== null;
  // En los duelos no se enseña si aciertas hasta el final (si no, se podría repetir sabiendo las respuestas)
  const isDuel = currentTest.mode === 'duel';

  const optionsHtml = q.options.map((opt,i)=>{
    let cls = 'option';
    let state = '';
    if(answered && isDuel){
      cls += ' disabled';
      if(i===userAnswer){ cls += ' selected'; state = ', tu respuesta'; }
    } else if(answered){
      cls += ' disabled';
      if(i===q.correct){ cls += ' correct'; state = ', correcta'; if(justAnswered) cls += ' just'; }
      else if(i===userAnswer){ cls += ' incorrect'; state = ', tu respuesta, incorrecta'; if(justAnswered) cls += ' just'; }
    } else if(i===userAnswer){
      cls += ' selected';
    }
    return `<button type="button" class="${cls}" data-action="selectAnswer" data-args='[${i}]' ${answered?'disabled':''} aria-label="Opción ${LETTERS[i]}: ${escapeHtml(opt)}${state}">
      <div class="letter">${LETTERS[i]}</div>
      <div>${escapeHtml(opt)}</div>
    </button>`;
  }).join('');

  let feedbackHtml = '';
  if(answered && isDuel){
    feedbackHtml = `<div class="feedback show duel">${icon('check',15)} <span>Respuesta guardada. Verás los aciertos al terminar el duelo.</span></div>`;
  } else if(answered){
    const correct = userAnswer === q.correct;
    if(!currentTest.phrases) currentTest.phrases = new Array(total).fill(null);
    if(!currentTest.phrases[currentIndex]) currentTest.phrases[currentIndex] = pickPhrase(correct, LETTERS[q.correct]);
    feedbackHtml = `<div class="feedback show ${correct?'ok':'no'}">
      ${correct ? icon('check',15) : icon('cross',15)} <span>${currentTest.phrases[currentIndex]}</span>
    </div>`;
    let lastAnsweredIdx = currentTest.answers.length-1;
    while(lastAnsweredIdx>=0 && currentTest.answers[lastAnsweredIdx]===null) lastAnsweredIdx--;
    const combo = currentCombo();
    if(correct && combo >= 3 && currentIndex === lastAnsweredIdx){
      feedbackHtml += comboHtml(combo);
    }
  }
  const mascotState = (!answered || isDuel) ? 'neutral' : (userAnswer === q.correct ? 'happy' : 'sad');

  const dotsHtml = currentTest.questions.map((_,i)=>{
    let cls = 'dot';
    if(i===currentIndex) cls += ' current';
    const a = currentTest.answers[i];
    let stateLabel = 'sin responder';
    if(a !== null && isDuel){
      cls += ' answered-duel';
      stateLabel = 'respondida';
    } else if(a !== null){
      const isOk = a === currentTest.questions[i].correct;
      cls += isOk ? ' answered-ok' : ' answered-no';
      stateLabel = isOk ? 'respondida correctamente' : 'respondida incorrectamente';
    }
    const current = i===currentIndex ? ', pregunta actual' : '';
    return `<button type="button" class="${cls}" data-action="goToQuestion" data-args='[${i}]' aria-label="Pregunta ${i+1}, ${stateLabel}${current}" ${i===currentIndex?'aria-current="true"':''}>${i+1}</button>`;
  }).join('');

  const answeredCount = currentTest.answers.filter(a=>a!==null).length;
  const timerHtml = currentTest.timed ? ` · <span class="timer" id="timerDisplay">${icon('clock',13)} --:--</span>` : '';
  const progressPct = total > 0 ? (answeredCount/total*100) : 0;
  const liveCombo = isDuel ? 0 : currentCombo();
  const comboChip = liveCombo >= 3 ? ` <span class="combo-chip ${liveCombo>=10?'c10':liveCombo>=5?'c5':''}">${icon('flame',12)} x${liveCombo}</span>` : '';
  const entering = currentIndex !== lastQuizIndex;
  lastQuizIndex = currentIndex;

  document.getElementById('screen').innerHTML = `
    <div class="quiz" style="--sc:${subj.color}">
      <div class="progress-wrap">
        <div class="progress-bar"><div class="progress-fill" style="width:${progressPct}%"></div></div>
        <div class="progress-text"><span>Pregunta ${currentIndex+1}/${total}${comboChip}</span><span>${answeredCount} respondidas${timerHtml}</span></div>
      </div>

      <div class="q-card ${entering && !prefersReducedMotion() ? 'q-enter' : ''}">
        <div class="q-card-head">
          <div class="q-tag">${escapeHtml(subj.short)}<small>${escapeHtml(q.exam)}</small></div>
          <div class="mascot ${answered?'react':''}">${mascotSVG(mascotState, 46)}</div>
        </div>
        ${q.unverified ? '<div class="unverified-badge">'+icon('warning',12)+' Respuesta sin verificar oficialmente</div>' : ''}
        <div class="q-text">${escapeHtml(q.text)}</div>
        <div class="options">${optionsHtml}</div>
        ${feedbackHtml}
      </div>

      <div class="nav-buttons">
        <button class="btn-secondary" data-action="prevQuestion" ${currentIndex===0?'disabled':''}>${icon('chevronLeft',15)} Anterior</button>
        ${currentIndex===total-1
          ? `<button class="btn-primary" data-action="finishTest">Ver resultados</button>`
          : `<button class="btn-primary" data-action="nextQuestion">Siguiente ${icon('chevronRight',16)}</button>`}
      </div>

      <div class="dotnav">${dotsHtml}</div>
    </div>
  `;
  if(currentTest.timed) updateTimerDisplay();
  justAnswered = false;
  saveProgress();
}

function selectAnswer(i){
  if(currentTest.answers[currentIndex] !== null) return;
  currentTest.answers[currentIndex] = i;
  if(!currentTest.phrases) currentTest.phrases = new Array(currentTest.questions.length).fill(null);
  const q = currentTest.questions[currentIndex];
  currentTest.phrases[currentIndex] = pickPhrase(i === q.correct, LETTERS[q.correct]);
  if(currentTest.mode === 'duel') vibrate(12);
  else if(i === q.correct) vibrate(currentCombo() >= 5 ? [12,40,12] : 12);
  else vibrate([70,50,70]);
  justAnswered = true;
  renderQuiz();
}
function nextQuestion(){ if(currentIndex < currentTest.questions.length-1){ currentIndex++; renderQuiz(); } }
function prevQuestion(){ if(currentIndex > 0){ currentIndex--; renderQuiz(); } }
function goToQuestion(i){ currentIndex = i; renderQuiz(); }

/* ---------------- RENDER: RESULTADOS ---------------- */
function finishTest(timeUp){
  clearTimer();
  const total = currentTest.questions.length;
  let score = 0;
  const subjBreakdown = {};
  const temaBreakdown = {};
  currentTest.questions.forEach((q,i)=>{
    const tk = q.subject + '::' + q.exam;
    if(!subjBreakdown[q.subject]) subjBreakdown[q.subject] = {correct:0, total:0};
    if(!temaBreakdown[tk]) temaBreakdown[tk] = {correct:0, total:0};
    subjBreakdown[q.subject].total++;
    temaBreakdown[tk].total++;
    if(currentTest.answers[i] === q.correct){
      score++;
      subjBreakdown[q.subject].correct++;
      temaBreakdown[tk].correct++;
    }
  });
  const maxCombo = computeMaxCombo(currentTest);
  currentTest.finishedAt = Date.now();

  const historyBefore = loadHistory();
  const prevBest = getBestPercent(historyBefore);
  const achvBefore = getAchievements(historyBefore).filter(a=>a.earned).map(a=>a.id);

  const entry = {date:Date.now(), score, total, mode:currentTest.mode, subject:currentTest.subject, label:currentTest.label, subjBreakdown, temaBreakdown, maxCombo};
  saveHistoryEntry(entry);
  const xpInfo = recordTestStats(entry);
  // Puntos del ranking semanal: 1 por acierto y +10 por aprobar un simulacro
  if(total > 0) Cloud.recordScore({ subject: currentTest.subject, mode: currentTest.mode, correct: score, total,
    points: score + ((currentTest.mode === 'subject' && score >= passScoreFor(total)) ? 10 : 0) });
  updateFailedBank();
  updateMasteredIds();
  clearProgress();

  const newPercent = Math.round(score/total*100);
  const isNewRecord = historyBefore.length>0 && (prevBest===null || newPercent>prevBest);
  const newlyUnlocked = getAchievements(loadHistory()).filter(a=>a.earned && !achvBefore.includes(a.id));
  persistBadges();

  renderResults(score, total, !!timeUp, isNewRecord, newlyUnlocked, xpInfo);
  if(currentTest.mode === 'duel' && currentTest.duel) submitAndShowDuel(currentTest, score);
}

function renderResults(score, total, timeUp, isNewRecord, newlyUnlocked, xpInfo){
  window.scrollTo(0,0);
  document.getElementById('topbarSub').textContent = 'Resultado · ' + modeLabel(currentTest);
  const passScore = passScoreFor(total);
  const pass = score >= passScore;
  const pct = total ? Math.round(score/total*100) : 0;
  newlyUnlocked = newlyUnlocked || [];

  const wrongItems = currentTest.questions.map((q,i)=>({q,i,ans:currentTest.answers[i]}))
    .filter(x=>x.ans !== x.q.correct);
  lastWrongIds = wrongItems.map(x=>x.q.id);

  let reviewHtml = '';
  if(wrongItems.length){
    reviewHtml = `<div class="section-label">Preguntas a repasar (${wrongItems.length})</div>` +
      wrongItems.map(x=>{
        const s = getSubject(x.q.subject);
        return `
        <div class="review-item" style="--sc:${s.color}">
          <div class="review-tag">${escapeHtml(s.short)} · ${escapeHtml(x.q.exam)} · Pregunta ${x.i+1}${x.q.unverified ? ' · '+icon('warning',10)+' sin verificar' : ''}</div>
          <div class="rq">${escapeHtml(x.q.text)}</div>
          <div class="ra user-wrong">${x.ans!==null ? 'Tu respuesta: '+LETTERS[x.ans]+') '+escapeHtml(x.q.options[x.ans]) : 'No respondida'}</div>
          <div class="ra correct-ans">Correcta: ${LETTERS[x.q.correct]}) ${escapeHtml(x.q.options[x.q.correct])}</div>
        </div>`;
      }).join('');
  } else if(total){
    reviewHtml = `<div class="section-label">Repaso</div><p class="empty-hint">Ninguna pregunta fallada. Todos los pacientes atendidos.</p>`;
  }

  const timeUpHtml = timeUp ? `<p class="empty-hint">${icon('clock',12)} Se acabó el tiempo asignado; el test se ha cerrado automáticamente.</p>` : '';
  const grandMasterEntry = newlyUnlocked.find(a=>a.id===GRAND_MASTER_ACHIEVEMENT.id);
  const otherNewlyUnlocked = newlyUnlocked.filter(a=>a.id!==GRAND_MASTER_ACHIEVEMENT.id);
  const recordHtml = (pass && isNewRecord) ? `<div class="celebrate-banner">${icon('award',17)} Nuevo récord personal: ${pct}%</div>` : '';
  const achvHtml = otherNewlyUnlocked.map(a=>`<div class="celebrate-banner pop">${icon(a.icon||'award',17)} Logro desbloqueado: ${a.title}</div>`).join('');
  let xpHtml = '', rankUp = false;
  if(xpInfo){
    const rb = rankFor(xpInfo.xpBefore), ra = rankFor(xpInfo.xpAfter);
    rankUp = ra.idx > rb.idx;
    const streakUp = xpInfo.firstToday && xpInfo.streakAfter > xpInfo.streakBefore;
    xpHtml = `
      ${rankUp ? `<div class="rankup-banner pop">
        <div class="pc-rank rank-${ra.idx}">${icon(ra.rank.icon, 30)}</div>
        <div><span>¡Ascenso!</span><b>${escapeHtml(ra.rank.name)}</b></div>
      </div>` : ''}
      <div class="xp-row">
        <div class="xp-gain">+${xpInfo.gained} XP</div>
        <div class="xp-rank"><div class="pc-bar"><div style="width:${ra.pct}%"></div></div><span>${escapeHtml(ra.rank.name)}${ra.next ? ' · ' + ra.toNext + ' XP para ' + escapeHtml(ra.next.name) : ''}</span></div>
      </div>
      ${streakUp ? `<div class="streak-banner pop">${icon('flame',18)} Racha de ${xpInfo.streakAfter} ${xpInfo.streakAfter===1?'día':'días'} · ¡vuelve mañana!</div>` : ''}`;
  }
  const isDuel = currentTest.mode === 'duel';
  const duelHtml = isDuel ? `<div id="duelResult" class="duel-result"><p class="empty-hint">Enviando tu resultado del duelo…</p></div>` : '';
  const legendaryHtml = grandMasterEntry ? `
    <div class="legendary-banner">
      ${confettiHtml(40)}
      <div class="legendary-icon">${icon('medal',32)}</div>
      <b>¡LEYENDA DEL 112!</b>
      <span>Te sabes las ${QUESTIONS.length} preguntas del banco y has desbloqueado todos los logros. Ya solo falta que el examen de verdad sea así de tranquilo...</span>
      <a class="reward-btn" href="https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=RDdQw4w9WgXcQ&start_radio=1" target="_blank" rel="noopener">${icon('award',15)} Reclamar recompensa</a>
    </div>
  ` : '';

  const backLabel = isDuel ? 'Volver a duelos' : (currentTest.subject ? 'Volver a la asignatura' : 'Ir al inicio');

  document.getElementById('screen').innerHTML = `
    <div class="results">
      ${timeUpHtml}
      <div class="result-hero ${pass?'pass':'fail'}">
        ${pass ? confettiHtml(26) : ''}
        <div class="rh-mascot mascot-idle">${mascotSVG(pass?'happy':'sad', 78)}</div>
        <div class="big-score"><span id="scoreCount">0</span>/${total}</div>
        <div class="big-label">${pct}% de aciertos</div>
        <div class="rh-msg">${resultMessage(pct)}</div>
        <div class="verdict">${pass ? icon('check',14)+' APTO (orientativo)' : icon('cross',14)+' NO APTO · A REFORZAR'}</div>
      </div>

      ${duelHtml}
      ${xpHtml}

      ${total ? `<button class="btn-pdf" data-action="downloadResultPdf">${icon('download',18)} Descargar PDF corregido</button>` : ''}

      ${legendaryHtml}
      ${recordHtml}
      ${achvHtml}

      ${reviewHtml}

      <div class="bottom-actions">
        <button class="btn-secondary" data-action="backToMenu">${backLabel}</button>
        ${wrongItems.length ? `<button class="btn-secondary" data-action="reviewFailed">Repasar falladas</button>` : ''}
        ${isDuel ? '' : `<button class="btn-primary" data-action="repeatTest">Repetir test</button>`}
      </div>
    </div>
    <footer class="note">Aprobado orientativo: ${passScore}/${total} (50%). Contrasta siempre con el material oficial del ciclo.</footer>
  `;
  animateScoreCount(score);
  if(rankUp || grandMasterEntry || (pass && (currentTest.mode === 'subject' || pct === 100 || isNewRecord))){
    setTimeout(()=>burstConfetti(rankUp || grandMasterEntry ? 200 : 140), 250);
    if(rankUp) vibrate([30,40,30,40,60]);
  }
}
function animateScoreCount(target){
  const el = document.getElementById('scoreCount');
  if(!el || typeof requestAnimationFrame === 'undefined'){ if(el) el.textContent = target; return; }
  const duration = 650;
  const start = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  function step(now){
    const t = Math.min(1, (now - start)/duration);
    const eased = 1 - Math.pow(1-t, 3);
    el.textContent = Math.round(eased*target);
    if(t < 1) requestAnimationFrame(step);
    else el.textContent = target;
  }
  requestAnimationFrame(step);
}

/* ---------------- EVENTOS (delegación, sin onclick en el HTML) ---------------- */
const ACTIONS = {
  calGoTo, calMove,
  createDuel,
  joinDuelFromInput,
  acceptPendingDuel,
  playDuel,
  shareDuel,
  shareDuelWhatsApp,
  copyDuelLink,
  openDuels,
  installApp,
  dismissInstall,
  cloudSetRankName,
  openAccount,
  cloudView,
  cloudSyncNow,
  cloudLogout,
  backToMenu,
  continueTest,
  debugShowFail,
  debugShowLegendary,
  debugShowPass,
  discardProgress,
  downloadResultPdf,
  finishTest,
  goToQuestion,
  nextQuestion,
  openDebugMode,
  openSubject,
  prevQuestion,
  renderHome,
  repeatTest,
  reviewFailed,
  selectAnswer,
  startExamTest,
  startFailedTest,
  startSubjectTest,
  startUnverifiedTest,
  switchHomeTab,
  switchSubjectTab,
  toggleTheme
};
document.addEventListener('click', e=>{
  const el = e.target.closest('[data-action]');
  if(!el || el.disabled) return;
  const fn = ACTIONS[el.dataset.action];
  if(!fn) return;
  let args = [];
  if(el.dataset.args){ try{ args = JSON.parse(el.dataset.args); }catch(err){ return; } }
  fn(...args);
});
// Campos que guardan al cambiar (fecha de examen, ranking...): reciben sus argumentos + el valor
document.addEventListener('change', e=>{
  const el = e.target.closest('[data-change]');
  if(!el) return;
  const fn = ACTIONS[el.dataset.change];
  if(!fn) return;
  let args = [];
  if(el.dataset.args){ try{ args = JSON.parse(el.dataset.args); }catch(err){ return; } }
  fn(...args, el.type === 'checkbox' ? el.checked : el.value);
});

/* ---------------- INIT ---------------- */
(function init(){
  // Descarta un test a medias guardado con un formato antiguo (sin asignatura)
  const p = loadProgress();
  if(p && p.currentTest && (!p.currentTest.questions || p.currentTest.questions.some(q=>!q.subject))) clearProgress();
  document.getElementById('brandLogo').innerHTML = starOfLifeSVG(28);
  applyThemeIcon();
  Cloud.loadSession();
  captureDuelFromUrl();
  renderHome();
  // Cuenta opcional en la nube: al traer datos, refresca la portada si el usuario está en ella
  Cloud.init(()=>{ if(document.querySelector('.home-tabs') && !document.getElementById('accountScreen')) renderHome(); });
  // Banco de preguntas: pide la versión más nueva a la nube sin bloquear la app
  Bank.refresh(onBankUpdated);
  // App instalable y sin conexión
  if('serviceWorker' in navigator && location.protocol === 'https:'){
    window.addEventListener('load', ()=>{ navigator.serviceWorker.register('sw.js').catch(()=>{}); });
  }
})();
