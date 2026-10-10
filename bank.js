'use strict';
/* ---------------- BANCO DE PREGUNTAS ----------------
   Orden de prioridad:
   1) Supabase (lo más nuevo). Si responde, se guarda una copia en el dispositivo.
   2) La copia guardada en el dispositivo (sirve sin internet o si Supabase está caído).
   3) data.js, que va dentro del código como copia de seguridad.
   SUBJECTS y QUESTIONS se actualizan "en el sitio" para que el resto de la app no cambie. */
const BANK_CACHE_KEY = 'tes_bank_cache_v1';

const Bank = (function(){
  let source = 'código';

  function normalize(data){
    if(!data || !Array.isArray(data.subjects) || !Array.isArray(data.questions)) return null;
    const subjects = data.subjects.filter(s=>s && s.id && s.name).map(s=>({
      id:s.id, name:s.name, short:s.short || s.name, icon:s.icon || 'book', color:s.color || '#1C5FB0'
    }));
    const questions = data.questions.filter(q=>q && q.id && q.subject && Array.isArray(q.options) && q.options.length >= 2).map(q=>{
      const out = { id:q.id, subject:q.subject, exam:q.exam, text:q.text, options:q.options.slice(), correct:Number(q.correct) };
      if(q.u || q.unverified) out.u = true;
      return out;
    });
    if(!subjects.length || !questions.length) return null;
    return { subjects, questions };
  }
  function replaceInPlace(target, items){ target.length = 0; items.forEach(x=>target.push(x)); }
  function apply(data){
    const n = normalize(data);
    if(!n) return false;
    replaceInPlace(SUBJECTS, n.subjects);
    replaceInPlace(QUESTIONS, n.questions);
    return true;
  }
  function signature(){ return QUESTIONS.length + '|' + QUESTIONS.map(q=>q.id + ':' + q.correct + ':' + (q.u?1:0) + ':' + q.text.length).join(',') + '|' + SUBJECTS.map(s=>s.id+s.name).join(','); }

  // Paso síncrono, antes de que arranque la app: usa la copia del dispositivo si existe
  function applyCached(){
    const cached = Store.get(BANK_CACHE_KEY, null);
    if(cached && apply(cached)){ source = 'copia del dispositivo'; return true; }
    return false;
  }

  // Paso en segundo plano: pide a Supabase la versión más nueva
  async function refresh(onChanged){
    if(typeof SUPABASE_URL === 'undefined') return;
    try{
      const headers = { apikey: SUPABASE_KEY };
      const [sr, qr] = await Promise.all([
        fetch(SUPABASE_URL + '/rest/v1/subjects?select=id,name,short,icon,color&order=sort', { headers }),
        fetch(SUPABASE_URL + '/rest/v1/questions?select=id,subject,exam,text,options,correct,unverified&order=sort&limit=5000', { headers })
      ]);
      if(!sr.ok || !qr.ok) return;
      const data = { subjects: await sr.json(), questions: await qr.json() };
      const before = signature();
      if(!apply(data)) return;
      source = 'nube';
      Store.set(BANK_CACHE_KEY, { subjects: SUBJECTS, questions: QUESTIONS.map(q=>q.u ? q : Object.assign({}, q)), savedAt: Date.now() });
      if(signature() !== before && typeof onChanged === 'function') onChanged();
    }catch(e){ /* sin conexión o Supabase caído: seguimos con lo que hay */ }
  }

  return { applyCached, refresh, source(){ return source; } };
})();

Bank.applyCached();
