'use strict';
/* ---------------- ALMACENAMIENTO ----------------
   Única puerta de entrada a los datos guardados.
   Hoy guarda en el navegador (localStorage). Cuando se active la cuenta en la nube,
   la sincronización se engancha aquí con Store.onChange, sin tocar el resto de la app. */
const Store = (function(){
  const listeners = [];
  function notify(key, value){ listeners.forEach(fn=>{ try{ fn(key, value); }catch(e){} }); }
  function getRaw(key){ try{ return localStorage.getItem(key); }catch(e){ return null; } }
  function setRaw(key, value){
    try{ localStorage.setItem(key, value); notify(key, value); return true; }
    catch(e){ return false; }
  }
  function get(key, fallback){
    const raw = getRaw(key);
    if(raw === null) return fallback;
    try{
      const v = JSON.parse(raw);
      return v === null || v === undefined ? fallback : v;
    }catch(e){ return fallback; }
  }
  function set(key, value){
    try{ localStorage.setItem(key, JSON.stringify(value)); notify(key, value); return true; }
    catch(e){ return false; }
  }
  function remove(key){
    try{ localStorage.removeItem(key); notify(key, undefined); }catch(e){}
  }
  // Para volcar o restaurar todo de golpe (sincronización)
  function snapshot(keys){
    const out = {};
    keys.forEach(k=>{ const raw = getRaw(k); if(raw !== null) out[k] = raw; });
    return out;
  }
  function restore(obj){
    Object.keys(obj || {}).forEach(k=>{ try{ localStorage.setItem(k, obj[k]); }catch(e){} });
  }
  function onChange(fn){ listeners.push(fn); }
  return { get, set, remove, getRaw, setRaw, snapshot, restore, onChange };
})();
