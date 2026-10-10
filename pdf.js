'use strict';
/* ---------------- PDF DEL RESULTADO (generador propio, sin librerías, funciona sin internet) ---------------- */
const PDF_W = { F1: [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584,350,556,350,222,556,333,1000,556,556,333,1000,667,333,1000,350,611,350,350,222,222,333,333,350,556,1000,333,1000,500,333,944,350,500,667,278,333,556,556,556,556,260,556,333,737,370,556,584,333,737,333,400,584,333,333,333,556,537,278,333,333,365,556,834,834,834,611,667,667,667,667,667,667,1000,722,667,667,667,667,278,278,278,278,722,722,778,778,778,778,778,584,778,722,722,722,722,667,667,611,556,556,556,556,556,556,889,500,556,556,556,556,278,278,278,278,556,556,556,556,556,556,556,584,611,556,556,556,556,500,556,500], F2: [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,611,611,389,556,333,611,556,778,556,556,500,389,280,389,584,350,556,350,278,556,500,1000,556,556,333,1000,667,333,1000,350,611,350,350,278,278,500,500,350,556,1000,333,1000,556,333,944,350,500,667,278,333,556,556,556,556,280,556,333,737,370,556,584,333,737,333,400,584,333,333,333,611,556,278,333,333,365,556,834,834,834,611,722,722,722,722,722,722,1000,722,667,667,667,667,278,278,278,278,722,722,778,778,778,778,778,584,778,722,722,722,722,667,667,611,556,556,556,556,556,556,889,556,556,556,556,556,278,278,278,278,611,611,611,611,611,611,611,584,611,611,611,611,611,556,611,556] };
// Caracteres especiales de WinAnsi (0x80-0x9F)
const WINANSI_EXTRA = {'€':128,'‚':130,'ƒ':131,'„':132,'…':133,'†':134,'‡':135,'ˆ':136,'‰':137,'Š':138,'‹':139,'Œ':140,'Ž':142,'‘':145,'’':146,'“':147,'”':148,'•':149,'–':150,'—':151,'˜':152,'™':153,'š':154,'›':155,'œ':156,'ž':158,'Ÿ':159};
function pdfCode(ch){
  const c = ch.charCodeAt(0);
  if(c >= 32 && c < 127) return c;
  if(c >= 160 && c <= 255) return c;
  if(WINANSI_EXTRA[ch]) return WINANSI_EXTRA[ch];
  return 63; // '?'
}
function pdfEncode(str){
  let out = '';
  for(const ch of String(str).replace(/\s+/g,' ')){
    const code = pdfCode(ch);
    const c = String.fromCharCode(code);
    out += (c === '(' || c === ')' || c === '\\') ? '\\' + c : c;
  }
  return out;
}
function pdfTextWidth(str, font, size){
  let w = 0;
  for(const ch of String(str)) w += PDF_W[font][pdfCode(ch)] || 500;
  return w * size / 1000;
}
function pdfWrap(str, font, size, maxW){
  const words = String(str).replace(/\s+/g,' ').trim().split(' ');
  const lines = [];
  let line = '';
  words.forEach(word=>{
    const test = line ? line + ' ' + word : word;
    if(pdfTextWidth(test, font, size) <= maxW || !line){ line = test; }
    else { lines.push(line); line = word; }
  });
  if(line) lines.push(line);
  return lines.length ? lines : [''];
}
function hexToRgb(hex){
  const h = hex.replace('#','');
  return [0,2,4].map(i=>(parseInt(h.substr(i,2),16)/255).toFixed(3)).join(' ');
}
function PdfDoc(){
  const W = 595.28, H = 841.89, M = 42;
  const pages = [];
  let ops = null, y = 0;
  const api = {
    W, H, M,
    get y(){ return y; }, set y(v){ y = v; },
    newPage(){ ops = []; pages.push(ops); y = H - M; },
    ensure(h){ if(y - h < M + 24) api.newPage(); },
    rect(x, yTop, w, h, color){ ops.push(`${hexToRgb(color)} rg ${x.toFixed(2)} ${(yTop-h).toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re f`); },
    text(str, x, yBase, font, size, color){
      ops.push(`BT /${font} ${size} Tf ${hexToRgb(color||'#14202E')} rg ${x.toFixed(2)} ${yBase.toFixed(2)} Td (${pdfEncode(str)}) Tj ET`);
    },
    // Escribe un párrafo con salto de línea automático y avanza "y"
    para(str, x, maxW, font, size, color, lineH){
      lineH = lineH || size * 1.35;
      pdfWrap(str, font, size, maxW).forEach(l=>{
        api.ensure(lineH);
        api.text(l, x, y - size, font, size, color);
        y -= lineH;
      });
    },
    output(){
      const total = pages.length;
      pages.forEach((p, i)=>{
        p.push(`BT /F1 8 Tf ${hexToRgb('#566273')} rg ${M} 22 Td (${pdfEncode('TES Test · Técnico en Emergencias Sanitarias')}) Tj ET`);
        const t = `Página ${i+1} de ${total}`;
        p.push(`BT /F1 8 Tf ${hexToRgb('#566273')} rg ${(W - M - pdfTextWidth(t,'F1',8)).toFixed(2)} 22 Td (${pdfEncode(t)}) Tj ET`);
      });
      const objs = [];
      objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
      objs[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
      objs[4] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>';
      const kids = [];
      pages.forEach((p, i)=>{
        const pageId = 5 + i*2, contId = 6 + i*2;
        const stream = p.join('\n');
        objs[contId] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
        objs[pageId] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contId} 0 R >>`;
        kids.push(`${pageId} 0 R`);
      });
      objs[2] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pages.length} >>`;
      let out = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n';
      const offsets = [];
      for(let i=1;i<objs.length;i++){
        offsets[i] = out.length;
        out += `${i} 0 obj\n${objs[i]}\nendobj\n`;
      }
      const xref = out.length;
      out += `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
      for(let i=1;i<objs.length;i++) out += String(offsets[i]).padStart(10,'0') + ' 00000 n \n';
      out += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
      const bytes = new Uint8Array(out.length);
      for(let i=0;i<out.length;i++) bytes[i] = out.charCodeAt(i) & 0xFF;
      return bytes;
    }
  };
  api.newPage();
  return api;
}

function buildResultPdf(test){
  const doc = PdfDoc();
  const {W, M} = doc;
  const CW = W - 2*M;
  const total = test.questions.length;
  const score = test.questions.filter((q,i)=>test.answers[i] === q.correct).length;
  const pct = total ? Math.round(score/total*100) : 0;
  const pass = score >= passScoreFor(total);
  const when = new Date(test.finishedAt || Date.now());
  const dateStr = when.toLocaleDateString('es-ES',{day:'2-digit',month:'long',year:'numeric'}) + ' · ' + when.toLocaleTimeString('es-ES',{hour:'2-digit',minute:'2-digit'});

  // Cabecera
  doc.rect(0, doc.H, W, 92, '#10233D');
  for(let x=0, i=0; x<W; x+=18, i++) doc.rect(x, doc.H-92, 18, 6, i%2 ? '#2FA35B' : '#F5C518');
  doc.text('TES TEST', M, doc.H-40, 'F2', 22, '#F5C518');
  doc.text('Técnico en Emergencias Sanitarias', M, doc.H-58, 'F1', 10, '#FFFFFF');
  doc.text(modeLabel(test), M, doc.H-74, 'F2', 11, '#8CC0F5');
  doc.y = doc.H - 92 - 22;

  // Resumen
  const boxH = 64;
  doc.rect(M, doc.y, CW, boxH, pass ? '#E2F5E9' : '#FCE6E4');
  doc.rect(M, doc.y, 6, boxH, pass ? '#178A4C' : '#C62828');
  doc.text(`${score}/${total}`, M+20, doc.y-40, 'F2', 30, pass ? '#0F5E33' : '#8E1B1B');
  const verdict = pass ? 'APTO' : 'NO APTO';
  doc.text(verdict, M+150, doc.y-26, 'F2', 16, pass ? '#0F5E33' : '#8E1B1B');
  doc.text(`${pct}% de aciertos · aprobado con ${passScoreFor(total)}/${total}`, M+150, doc.y-44, 'F1', 10, '#14202E');
  doc.text(dateStr, M+150, doc.y-57, 'F1', 9, '#566273');
  doc.y -= boxH + 22;

  const LETTERS_ = LETTERS;
  test.questions.forEach((q, i)=>{
    const ans = test.answers[i];
    const ok = ans === q.correct;
    const status = ans === null ? 'SIN RESPONDER' : (ok ? 'ACIERTO' : 'FALLO');
    const statusCol = ans === null ? '#7A5A00' : (ok ? '#178A4C' : '#C62828');
    const subj = getSubject(q.subject);

    doc.ensure(70);
    doc.rect(M, doc.y, 3, 12, subj.color);
    doc.text(`${i+1}. ${subj.short} · ${q.exam}`.toUpperCase(), M+9, doc.y-9, 'F2', 7.5, '#566273');
    doc.text(status, W - M - pdfTextWidth(status,'F2',8.5), doc.y-9, 'F2', 8.5, statusCol);
    doc.y -= 17;
    doc.para(q.text, M, CW, 'F2', 10.5, '#14202E');
    doc.y -= 3;
    q.options.forEach((opt, k)=>{
      let color = '#3B4656', font = 'F1', suffix = '';
      if(k === q.correct){ color = '#0F7A40'; font = 'F2'; suffix = ans === k ? '   (tu respuesta · correcta)' : '   (correcta)'; }
      else if(k === ans){ color = '#C62828'; font = 'F2'; suffix = '   (tu respuesta)'; }
      const prefix = LETTERS_[k] + ')';
      const lines = pdfWrap(opt + suffix, font, 9.5, CW - 22);
      lines.forEach((l, li)=>{
        doc.ensure(13);
        if(li === 0) doc.text(prefix, M+6, doc.y-9.5, font, 9.5, color);
        doc.text(l, M+22, doc.y-9.5, font, 9.5, color);
        doc.y -= 13;
      });
    });
    doc.y -= 12;
  });
  return doc.output();
}
function pdfFileName(test){
  const d = new Date(test.finishedAt || Date.now());
  const stamp = d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0') + '_' + String(d.getHours()).padStart(2,'0') + String(d.getMinutes()).padStart(2,'0');
  const label = modeLabel(test).normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/[^A-Za-z0-9]+/g,'_').replace(/^_|_$/g,'');
  return `TES_${label}_${stamp}.pdf`;
}
function downloadResultPdf(){
  if(!currentTest || !currentTest.questions.length) return;
  try{
    const bytes = buildResultPdf(currentTest);
    const blob = new Blob([bytes], {type:'application/pdf'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = pdfFileName(currentTest);
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(()=>URL.revokeObjectURL(url), 4000);
  }catch(e){
    console.error(e);
    alert('No se pudo generar el PDF.');
  }
}
