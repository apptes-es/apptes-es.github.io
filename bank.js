'use strict';
/* ---------------- BANCO DE PREGUNTAS ----------------
   Orden de prioridad:
   1) Supabase (lo más nuevo). Si responde, se guarda una copia en el dispositivo.
   2) La copia guardada en el dispositivo (sirve sin internet o si Supabase está caído).
   3) data.js, que va dentro del código como copia de seguridad.
   SUBJECTS y QUESTIONS se actualizan "en el sitio" para que el resto de la app no cambie. */
const BANK_CACHE_KEY = 'tes_bank_cache_v1';
const BANK_VERSION_KEY = 'tes_bank_version_v1'; // huella del banco guardado en el dispositivo

const Bank = (function(){
  let source = 'código';

  function normalize(data){
    if(!data || !Array.isArray(data.subjects) || !Array.isArray(data.questions)) return null;
    const subjects = data.subjects.filter(s=>s && s.id && s.name).map(s=>({
      id:s.id, name:s.name, short:s.short || s.name, icon:s.icon || 'book', color:s.color || '#1C5FB0', exam_date:s.exam_date || null
    }));
    const questions = data.questions.filter(q=>q && q.id && q.subject && Array.isArray(q.options) && q.options.length >= 2).map(q=>{
      const out = { id:q.id, subject:q.subject, exam:q.exam, text:q.text, options:q.options.slice(), correct:Number(q.correct) };
      if(q.u || q.unverified) out.u = true;
      const e = q.e || q.explanation;
      if(e) out.e = String(e);
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
  // Huella del banco que la app tiene cargado ahora mismo (la calcula Supabase: bank_version)
  let version = (typeof BANK_VERSION !== 'undefined') ? BANK_VERSION : null;

  // Paso síncrono, antes de que arranque la app: usa la copia del dispositivo si existe
  function applyCached(){
    let cached = null;
    try{ cached = JSON.parse(Store.getRaw(BANK_CACHE_KEY)); }catch(e){}
    if(cached && apply(cached)){ source = 'copia del dispositivo'; version = Store.getRaw(BANK_VERSION_KEY) || null; return true; }
    return false;
  }

  // Paso en segundo plano: pide a Supabase la versión más nueva
  async function refresh(onChanged){
    if(typeof SUPABASE_URL === 'undefined') return;
    try{
      const headers = { apikey: SUPABASE_KEY };
      // 1) Pregunta corta: ¿ha cambiado algo? Si no, no se descarga ni se guarda nada
      let remote = null;
      try{
        const vr = await fetch(SUPABASE_URL + '/rest/v1/rpc/bank_version', { method:'POST', headers: Object.assign({ 'Content-Type':'application/json' }, headers), body:'{}' });
        if(vr.ok) remote = await vr.json();
      }catch(e){}
      if(remote && remote === version){ source = source === 'código' ? 'código (al día)' : source; return; }
      // 2) Hay cambios (o no se pudo saber): se descarga el banco entero
      const [sr, qr] = await Promise.all([
        fetch(SUPABASE_URL + '/rest/v1/subjects?select=id,name,short,icon,color,exam_date&active=eq.true&order=sort', { headers }),
        fetch(SUPABASE_URL + '/rest/v1/questions?select=id,subject,exam,text,options,correct,unverified,explanation&active=eq.true&order=sort&limit=5000', { headers })
      ]);
      if(!sr.ok || !qr.ok) return;
      const data = { subjects: await sr.json(), questions: await qr.json() };
      if(!apply(data)) return;
      source = 'nube';
      Store.setRaw(BANK_CACHE_KEY, JSON.stringify({ subjects: SUBJECTS, questions: QUESTIONS, savedAt: Date.now() }));
      if(remote){ version = remote; Store.setRaw(BANK_VERSION_KEY, remote); }
      if(typeof onChanged === 'function') onChanged();
    }catch(e){ /* sin conexión o Supabase caído: seguimos con lo que hay */ }
  }

  return { applyCached, refresh, source(){ return source; } };
})();

Bank.applyCached();
