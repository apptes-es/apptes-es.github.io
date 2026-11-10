'use strict';
/* ---------------- ALMACENAMIENTO ----------------
   Única puerta de entrada a los datos guardados.
   Hoy guarda en el navegador (localStorage). Cuando se active la cuenta en la nube,
   la sincronización se engancha aquí con Store.onChange, sin tocar el resto de la app. */
const Store = (function(){
  const listeners = [];
  // Caché en memoria de lo ya leído: evita releer y volver a interpretar lo mismo en cada pantalla
  const cache = new Map();
  try{ window.addEventListener('storage', ()=>cache.clear()); }catch(e){}
  function notify(key, value){ listeners.forEach(fn=>{ try{ fn(key, value); }catch(e){} }); }
  function getRaw(key){ try{ return localStorage.getItem(key); }catch(e){ return null; } }
  function setRaw(key, value){
    cache.delete(key);
    try{ localStorage.setItem(key, value); notify(key, value); return true; }
    catch(e){ return false; }
  }
  function get(key, fallback){
    if(!cache.has(key)){
      const raw = getRaw(key);
      let v;
      if(raw !== null){ try{ const p = JSON.parse(raw); if(p !== null && p !== undefined) v = p; }catch(e){} }
      cache.set(key, v);
    }
    const c = cache.get(key);
    return c === undefined ? fallback : c;
  }
  function set(key, value){
    cache.delete(key);
    try{ localStorage.setItem(key, JSON.stringify(value)); cache.set(key, value); notify(key, value); return true; }
    catch(e){ return false; }
  }
  function remove(key){
    cache.delete(key);
    try{ localStorage.removeItem(key); notify(key, undefined); }catch(e){}
  }
  // Para volcar o restaurar todo de golpe (sincronización)
  function snapshot(keys){
    const out = {};
    keys.forEach(k=>{ const raw = getRaw(k); if(raw !== null) out[k] = raw; });
    return out;
  }
  function restore(obj){
    Object.keys(obj || {}).forEach(k=>{ cache.delete(k); try{ localStorage.setItem(k, obj[k]); }catch(e){} });
  }
  function onChange(fn){ listeners.push(fn); }
  return { get, set, remove, getRaw, setRaw, snapshot, restore, onChange };
})();
