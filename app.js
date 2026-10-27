/* ============================================================================
   app.js — Observatorio de natalidad de España.
   Mapa de calor mes x año desde 1941, alarmas de mínimo histórico y series
   anuales desde 1858. assets/ es el kit y no se toca.
   ========================================================================== */
(function () {
  'use strict';

  var D = window.DATOS || {};
  var F = Obs.fmt;
  var MES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
  var MES3 = ['ENE', 'FEB', 'MAR', 'ABR', 'MAY', 'JUN', 'JUL', 'AGO', 'SEP', 'OCT', 'NOV', 'DIC'];
  var INE_API = 'https://servicios.ine.es/wstempus/js/ES/DATOS_SERIE/';

  var FUENTE_EMN = { txt: 'INE · Estimación Mensual de Nacimientos', url: 'https://www.ine.es/dyngs/INEbase/es/operacion.htm?c=Estadistica_C&cid=1254736177079&menu=ultiDatos&idp=1254735573002' };
  var FUENTE_MNP = { txt: 'INE · MNP, nacimientos', url: 'https://www.ine.es/dynt3/inebase/es/index.htm?padre=1123&dh=1' };
  var FUENTE_HIST = { txt: 'INE (anuarios históricos) y Carreras y Tafunell, Estadísticas Históricas de España', url: 'https://www.ine.es/inebaseweb/libros.do?tntp=25687' };
  var FUENTE_ECP = { txt: 'INE · Estadística Continua de Población', url: 'https://www.ine.es/jaxiT3/Tabla.htm?t=56934' };

  /* Métricas del mapa. La tasa es la referencia: corrige los días del mes y el
     tamaño de la población, que entre 1941 y hoy casi se ha duplicado. */
  var METRICAS = {
    tasa: { txt: 'Tasa anualizada (‰)', corto: 'tasa', fmt: function (v) { return F.num(v, 2) + ' ‰'; } },
    dia:  { txt: 'Nacimientos por día', corto: 'nacimientos por día', fmt: function (v) { return F.num(v, 0) + ' al día'; } },
    nac:  { txt: 'Nacimientos del mes', corto: 'nacimientos', fmt: function (v) { return F.num(v, 0); } }
  };
  var estado = { metrica: 'tasa' };

  /* ----------------------------------------------------------- Utilidades */

  function diasMes(y, m) { return new Date(y, m, 0).getDate(); }

  function interpolar(anclas, t) {
    if (!anclas || !anclas.length) return null;
    if (t <= anclas[0][0]) return anclas[0][1];
    for (var i = 1; i < anclas.length; i++) {
      var a = anclas[i - 1], b = anclas[i];
      if (t <= b[0]) return a[1] + (b[1] - a[1]) * (t - a[0]) / (b[0] - a[0]);
    }
    var u = anclas[anclas.length - 1];
    var ref = anclas.filter(function (x) { return x[0] >= u[0] - 1; });
    var p = (u[1] - ref[0][1]) / Math.max(u[0] - ref[0][0], 0.25);
    return u[1] + p * (t - u[0]);
  }

  /* Mínimo de una lista [{k, v}] en orden temporal, y el mínimo anterior a él
     (el récord que batió). Misma lógica que record() en build_data.py. */
  function record(pares) {
    pares = pares.filter(function (p) { return p.v != null && isFinite(p.v); });
    if (!pares.length) return { rec: null, ant: null };
    var i = 0;
    pares.forEach(function (p, k) { if (p.v < pares[i].v) i = k; });
    var antes = pares.slice(0, i), j = -1;
    antes.forEach(function (p, k) { if (j < 0 || p.v < antes[j].v) j = k; });
    return { rec: pares[i], ant: j >= 0 ? antes[j] : null };
  }

  function etiquetaMes(k) { return MES[+k.slice(5) - 1] + ' de ' + k.slice(0, 4); }

  /* --------------------------------------------- Datos: base + INE en vivo */

  var M = D.mensual || { x: [], nac: [], dias: [], pob: [], tasa: [] };
  var A = D.anual || { x: [], nac: [], tasa: [] };
  var enVivo = { ok: false, nuevos: 0 };

  function añadirMes(k, n) {
    var y = +k.slice(0, 4), m = +k.slice(5);
    var dias = diasMes(y, m);
    var pob = interpolar(D.pob_anclas, y + (m - 0.5) / 12);
    var i = M.x.indexOf(k);
    var t = pob ? +(n / dias * 365.25 / pob * 1000).toFixed(3) : null;
    if (i >= 0) { M.nac[i] = n; M.tasa[i] = t; return false; }
    M.x.push(k); M.nac.push(n); M.dias.push(dias); M.pob.push(Math.round(pob)); M.tasa.push(t);
    return true;
  }

  /* Años completos a partir de 1941 que el fichero aún no tenga. */
  function completarAnual() {
    var porAnio = {};
    M.x.forEach(function (k, i) { (porAnio[k.slice(0, 4)] = porAnio[k.slice(0, 4)] || []).push(M.nac[i]); });
    Object.keys(porAnio).sort().forEach(function (a) {
      if (porAnio[a].length < 12 || A.x.indexOf(a) >= 0) return;
      var n = porAnio[a].reduce(function (s, v) { return s + v; }, 0);
      A.x.push(a); A.nac.push(n);
      A.tasa.push(+(n / interpolar(D.pob_anclas, +a + 0.5) * 1000).toFixed(3));
    });
  }

  function traerEnVivo() {
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var corte = setTimeout(function () { if (ctrl) ctrl.abort(); }, 6000);
    return fetch(INE_API + 'EMN39?nult=12', ctrl ? { signal: ctrl.signal } : {})
      .then(function (r) { return r.json(); })
      .then(function (j) {
        clearTimeout(corte);
        /* Periodo con Anyo + FK_Periodo, nunca con Fecha (va en hora de Madrid). */
        (j.Data || []).filter(function (d) { return d.Valor != null && d.FK_Periodo >= 1 && d.FK_Periodo <= 12; })
          .sort(function (a, b) { return a.Anyo - b.Anyo || a.FK_Periodo - b.FK_Periodo; })
          .forEach(function (d) {
            var k = d.Anyo + '-' + ('0' + d.FK_Periodo).slice(-2);
            if (añadirMes(k, d.Valor)) enVivo.nuevos++;
          });
        enVivo.ok = true;
        completarAnual();
      })
      .catch(function () { clearTimeout(corte); });
  }

  /* -------------------------------------------------- Valores por métrica */

  function valores(met) {
    if (met === 'tasa') return M.tasa;
    if (met === 'dia') return M.nac.map(function (n, i) { return n / M.dias[i]; });
    return M.nac;
  }
  function pares(met, filtroMes) {
    var v = valores(met);
    return M.x.map(function (k, i) { return { k: k, v: v[i] }; })
      .filter(function (p) { return !filtroMes || p.k.slice(5) === filtroMes; });
  }
  function puesto(met, k) {
    var v = valores(met), i = M.x.indexOf(k);
    if (i < 0) return null;
    var menores = v.filter(function (x) { return x < v[i]; }).length;
    return { n: menores + 1, de: v.length };
  }

  /* ----------------------------------------------------------- Alarmas */

  /* Misma lógica que alertas() en build_data.py. */
  function alertas() {
    var out = [];
    if (!M.x.length) return out;
    var ult = M.x[M.x.length - 1], m = +ult.slice(5), y = ult.slice(0, 4);
    var nom = etiquetaMes(ult);
    nom = nom.charAt(0).toUpperCase() + nom.slice(1);
    [['tasa', 'la tasa de natalidad más baja'], ['dia', 'menos nacimientos por día']].forEach(function (c) {
      var r = record(pares(c[0]));
      if (r.rec && r.rec.k === ult) out.push({ nivel: 'crit', txt: nom + ': el mes con ' + c[1] + ' desde 1941.', ant: r.ant, met: c[0] });
      r = record(pares(c[0], ult.slice(5)));
      if (r.rec && r.rec.k === ult) out.push({ nivel: 'warn', txt: nom + ': el ' + MES[m - 1] + ' con ' + c[1] + ' desde 1941.', ant: r.ant, met: c[0] });
    });
    if (A.x.length) {
      var ua = A.x[A.x.length - 1];
      [['tasa', 'la tasa de natalidad más baja'], ['nac', 'menos nacimientos']].forEach(function (c) {
        var r = record(A.x.map(function (k, i) { return { k: k, v: A[c[0]][i] }; }));
        if (r.rec && r.rec.k === ua) out.push({ nivel: 'crit', txt: ua + ': el año con ' + c[1] + ' desde 1858.', antAnio: r.ant, met: c[0] });
      });
    }
    var ac = acumulados(m);
    if (m < 12) {
      var r = record(ac);
      if (r.rec && r.rec.k === y) out.push({ nivel: 'warn', txt: 'Enero-' + MES[m - 1] + ' de ' + y + ': el acumulado con menos nacimientos desde 1941.', antAcum: r.ant });
    }
    return out;
  }

  /* Nacimientos de enero al mes m, por año. */
  function acumulados(m) {
    var s = {};
    M.x.forEach(function (k, i) { if (+k.slice(5) <= m) s[k.slice(0, 4)] = (s[k.slice(0, 4)] || 0) + M.nac[i]; });
    return Object.keys(s).sort().map(function (a) { return { k: a, v: s[a] }; });
  }

  var ICO_ALARMA = '<svg class="nat-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4m0 4h.01"/></svg>';
  var ICO_OK = '<svg class="nat-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/></svg>';

  function htmlAlarmas() {
    var al = alertas();
    var ult = M.x[M.x.length - 1];
    if (!al.length) {
      var p = puesto('tasa', ult);
      return { tipo: '', html: '<div class="nat-alarma ok">' + ICO_OK + '<div><b>Sin mínimo histórico en el último dato.</b> ' +
        etiquetaMes(ult).replace(/^./, function (c) { return c.toUpperCase(); }) + ' ocupa el puesto ' + p.n + ' de ' + F.num(p.de) +
        ' meses por tasa de natalidad (1 = el más bajo desde 1941).</div></div>' };
    }
    return { tipo: 'warn', html: al.map(function (a) {
      var ant = a.ant ? ' Récord anterior: ' + etiquetaMes(a.ant.k) + ' (' + METRICAS[a.met].fmt(a.ant.v) + ').'
        : a.antAnio ? ' Récord anterior: ' + a.antAnio.k + '.'
        : a.antAcum ? ' Récord anterior: ' + a.antAcum.k + ' (' + F.num(a.antAcum.v) + ').' : '';
      return '<div class="nat-alarma ' + a.nivel + '">' + ICO_ALARMA + '<div><b>Mínimo histórico.</b> ' + Obs.esc(a.txt) + Obs.esc(ant) + '</div></div>';
    }).join('') };
  }

  /* Récords vigentes y el anterior de cada uno: siempre a la vista. */
  function htmlRecords() {
    function ficha(titulo, r, fmtK, fmtV, nota) {
      if (!r.rec) return '';
      return '<div class="obs-kpi nat-rec"><div class="l">' + Obs.esc(titulo) + '</div>' +
        '<div class="v">' + Obs.esc(fmtK(r.rec.k)) + '</div>' +
        '<div class="nat-rec-val"><span class="nat-key solid"></span>' + Obs.esc(fmtV(r.rec.v)) + '</div>' +
        (r.ant ? '<div class="nat-rec-ant"><span class="nat-key dashed"></span>Anterior: ' + Obs.esc(fmtK(r.ant.k)) + ' · ' + Obs.esc(fmtV(r.ant.v)) + '</div>' : '') +
        (nota ? '<div class="nat-rec-nota">' + Obs.esc(nota) + '</div>' : '') + '</div>';
    }
    var mesK = function (k) { return MES3[+k.slice(5) - 1].charAt(0) + MES3[+k.slice(5) - 1].slice(1).toLowerCase() + ' ' + k.slice(0, 4); };
    var anK = function (k) { return k; };
    var anual = function (met) { return record(A.x.map(function (k, i) { return { k: k, v: A[met][i] }; })); };
    return '<div class="obs-kpis nat-recs">' +
      ficha('Mes con la tasa más baja (desde 1941)', record(pares('tasa')), mesK, METRICAS.tasa.fmt) +
      ficha('Mes con menos nacimientos por día', record(pares('dia')), mesK, METRICAS.dia.fmt) +
      ficha('Año con la tasa más baja (desde 1858)', anual('tasa'), anK, METRICAS.tasa.fmt) +
      ficha('Año con menos nacimientos (desde 1858)', anual('nac'), anK, function (v) { return F.num(v); }) +
      '</div>';
  }

  /* -------------------------------------------------------- Mapa de calor */

  /* Escala tipo "turbo" (arcoíris corregido): violeta = baja, rojo = alta. */
  var TURBO = ['#30123b', '#4662d7', '#36aaf9', '#1ae4b6', '#72fe5e', '#c8ef34', '#faba39', '#f66b19', '#ca2a04', '#7a0403'];
  var heat = null;

  function opcionesMapa() {
    var T = Obs.tema();
    var met = estado.metrica, v = valores(met), def = METRICAS[met];
    var y0 = +M.x[0].slice(0, 4), y1 = +M.x[M.x.length - 1].slice(0, 4);
    var anios = []; for (var y = y0; y <= y1; y++) anios.push(String(y));
    var celdas = M.x.map(function (k, i) { return [+k.slice(0, 4) - y0, +k.slice(5) - 1, v[i]]; });
    var vs = v.filter(function (x) { return x != null; });
    var lo = Math.min.apply(null, vs), hi = Math.max.apply(null, vs);

    /* Marcas: los tres meses más bajos de la serie (marco grueso) y el mínimo
       de cada mes del calendario (marco fino). Un mes puede ser ambas cosas. */
    var marcas = {};
    function marca(k, tipo, txt) {
      if (!k) return;
      var mk = marcas[k] || (marcas[k] = { value: [+k.slice(0, 4) - y0, +k.slice(5) - 1], tipo: tipo, txt: [] });
      if (tipo === 'top') mk.tipo = 'top';
      mk.txt.push(txt);
    }
    var bajos = pares(met).filter(function (p) { return p.v != null && isFinite(p.v); })
      .sort(function (a, b) { return a.v - b.v; }).slice(0, 3);
    bajos.forEach(function (p, n) { marca(p.k, 'top', (n === 0 ? 'Mes más bajo' : n + 1 + 'º mes más bajo') + ' de toda la serie'); });
    for (var mm = 1; mm <= 12; mm++) {
      var rc = record(pares(met, ('0' + mm).slice(-2)));
      if (rc.rec) marca(rc.rec.k, 'cal', 'Mínimo de ' + MES[mm - 1]);
    }
    marcas = Object.keys(marcas).map(function (k) { var mk = marcas[k]; mk.txt = mk.txt.join('<br>'); return mk; });
    var ultimo = M.x[M.x.length - 1];

    return {
      backgroundColor: 'transparent',
      textStyle: { fontFamily: T.font },
      animation: false,
      grid: { left: 46, right: 14, top: 8, bottom: 74 },
      tooltip: {
        backgroundColor: T.surface, borderColor: T.line, textStyle: { color: T.ink, fontSize: 12 },
        formatter: function (p) {
          var d = p.data.value || p.data;
          var k = anios[d[0]] + '-' + ('0' + (d[1] + 1)).slice(-2);
          var i = M.x.indexOf(k);
          if (i < 0) return '';
          var pu = puesto(met, k);
          return '<b>' + etiquetaMes(k) + '</b><br>' +
            'Tasa: ' + METRICAS.tasa.fmt(M.tasa[i]) + '<br>' +
            'Nacimientos: ' + F.num(M.nac[i]) + ' (' + F.num(M.nac[i] / M.dias[i], 0) + ' al día)<br>' +
            '<span style="color:' + T.mut + '">Puesto ' + pu.n + ' de ' + F.num(pu.de) + ' por ' + def.corto + ' (1 = más bajo)</span>' +
            (p.data.txt ? '<br><b>' + p.data.txt + '</b>' : '') + (k === ultimo ? '<br>Último dato publicado' : '');
        }
      },
      xAxis: {
        type: 'category', data: anios, splitArea: { show: false },
        axisLine: { lineStyle: { color: T.axis } }, axisTick: { show: false },
        axisLabel: { color: T.ink2, interval: function (i, val) { return +val % 10 === 0; } }
      },
      yAxis: {
        type: 'category', data: MES3, inverse: true,
        axisLine: { show: false }, axisTick: { show: false },
        axisLabel: { color: T.ink2, fontSize: 11 }
      },
      visualMap: {
        min: lo, max: hi, calculable: false, orient: 'horizontal', left: 'center', bottom: 6,
        itemWidth: 12, itemHeight: 260, text: ['Alta', 'Baja'], textStyle: { color: T.ink2 },
        inRange: { color: TURBO }, seriesIndex: 0,
        formatter: function (x) { return met === 'tasa' ? F.num(x, 1) : F.num(x); }
      },
      series: [
        { type: 'heatmap', data: celdas, progressive: 0, emphasis: { itemStyle: { borderColor: T.ink, borderWidth: 1 } } },
        {
          type: 'scatter', symbol: 'rect', z: 5, silent: false,
          symbolSize: function () { return heat ? celda() : [8, 22]; },
          data: marcas.map(function (mk) {
            return {
              value: mk.value, txt: mk.txt,
              itemStyle: {
                /* Blanco: los mínimos caen siempre en las celdas más oscuras de la escala. */
                color: 'rgba(0,0,0,0)', borderColor: '#ffffff',
                borderWidth: mk.tipo === 'top' ? 2.2 : 1,
                borderType: mk.tipo === 'top' ? 'solid' : [3, 2]
              }
            };
          })
        }
      ]
    };
  }

  /* Tamaño de una celda, para que los marcos encajen en ella. */
  function celda() {
    var nodo = document.getElementById('nat-heat');
    var y0 = +M.x[0].slice(0, 4), y1 = +M.x[M.x.length - 1].slice(0, 4);
    var w = (nodo.clientWidth - 60) / (y1 - y0 + 1), h = (nodo.clientHeight - 82) / 12;
    return [Math.max(w, 5), h];
  }

  function pintarMapa() {
    var nodo = document.getElementById('nat-heat');
    if (!nodo || typeof echarts === 'undefined') return;
    if (!heat) {
      heat = echarts.init(nodo, null, { renderer: 'canvas', devicePixelRatio: 2 });
      if (typeof ResizeObserver !== 'undefined') new ResizeObserver(function () { heat.resize(); heat.setOption(opcionesMapa(), true); }).observe(nodo);
    }
    heat.setOption(opcionesMapa(), true);
    var sub = document.getElementById('nat-heat-sub');
    if (sub) sub.textContent = METRICAS[estado.metrica].txt + ' · ' + M.x[0].slice(0, 4) + '-' + M.x[M.x.length - 1].slice(0, 4);
  }

  function htmlMapa() {
    var opts = Object.keys(METRICAS).map(function (k) {
      return '<option value="' + k + '"' + (k === estado.metrica ? ' selected' : '') + '>' + Obs.esc(METRICAS[k].txt) + '</option>';
    }).join('');
    return '<article class="obs-card span-2 nat-card">' +
      '<div class="obs-card-head"><div class="t"><h3>Natalidad de cada mes desde 1941</h3><div class="cs" id="nat-heat-sub"></div></div>' +
        '<label class="obs-card-ctrl"><span>Medida</span><select class="obs-select" id="nat-metrica">' + opts + '</select></label>' +
        '<div class="obs-card-tools"><button type="button" class="obs-icon-btn" id="nat-png" title="Descargar el mapa en PNG">' + Obs.icono.imagen() + '</button></div>' +
      '</div>' +
      '<div id="nat-heat" class="nat-heat" role="img" aria-label="Mapa de calor de la natalidad mensual en España desde 1941"></div>' +
      '<div class="nat-leyenda">' +
        '<span><span class="nat-key solid"></span>Los tres meses más bajos de la serie</span>' +
        '<span><span class="nat-key dashed"></span>Mínimo histórico de cada mes (enero, febrero…)</span>' +
      '</div>' +
      '<div class="obs-card-foot"><span class="obs-chip live"><span class="dot"></span>Mensual</span>' +
        '<span>Fuente: <a href="' + FUENTE_MNP.url + '" target="_blank" rel="noopener">' + FUENTE_MNP.txt + '</a> (1941-2024) y ' +
        '<a href="' + FUENTE_EMN.url + '" target="_blank" rel="noopener">' + FUENTE_EMN.txt + '</a> (desde 2025)</span>' +
        '<span style="flex-basis:100%;font-style:italic">La tasa anualizada divide los nacidos de cada mes por sus días, la multiplica por 365,25 y la refiere a la población de ese mes: así febrero no sale bajo por ser corto y 1950 se compara con 2026 pese a que España tiene hoy casi el doble de habitantes. Los meses de 1941 a 1974 cuentan por lugar de inscripción; desde 1975, por residencia de la madre. Los últimos meses son estimación del INE y pueden revisarse.</span>' +
      '</div></article>';
  }

  function engancharMapa() {
    var sel = document.getElementById('nat-metrica');
    if (sel) sel.addEventListener('change', function () { estado.metrica = sel.value; pintarMapa(); });
    var png = document.getElementById('nat-png');
    if (png) png.addEventListener('click', function () {
      if (!heat) return;
      var a = document.createElement('a');
      a.href = heat.getDataURL({ type: 'png', pixelRatio: 2, backgroundColor: Obs.tema().surface });
      a.download = 'natalidad_mensual_espana.png';
      document.body.appendChild(a); a.click(); a.remove();
    });
    /* El kit repinta sus gráficas al cambiar de tema; el mapa es propio, así que
       se escucha el atributo del tema. */
    new MutationObserver(function () { if (heat) heat.setOption(opcionesMapa(), true); })
      .observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function () { if (heat) heat.setOption(opcionesMapa(), true); });
  }

  /* ------------------------------------------------------------- Secciones */

  function seccionMapa() {
    var ult = M.x[M.x.length - 1], i = M.x.length - 1;
    var y = +ult.slice(0, 4), m = +ult.slice(5);
    var iPrev = M.x.indexOf((y - 1) + '-' + ult.slice(5));
    var dPct = function (a, b) { return a != null && b ? (a - b) / b * 100 : null; };
    var ac = acumulados(m);
    var acAct = ac.filter(function (p) { return p.k === String(y); })[0];
    var acPrev = ac.filter(function (p) { return p.k === String(y - 1); })[0];
    var al = htmlAlarmas();
    var serie24 = function (a) { return a.slice(-24); };
    return {
      nota: al.html, notaTipo: al.tipo,
      kpis: [
        { label: 'Nacimientos en ' + MES[m - 1] + ' de ' + y, valor: M.nac[i], delta: dPct(M.nac[i], M.nac[iPrev]), deltaRef: 'interanual', serie: serie24(M.nac) },
        { label: 'Tasa de natalidad del mes', valor: M.tasa[i], dec: 2, unidad: '‰', formato: F.num, delta: dPct(M.tasa[i], M.tasa[iPrev]), deltaRef: 'interanual', serie: serie24(M.tasa) },
        { label: 'Acumulado enero-' + MES[m - 1] + ' ' + y, valor: acAct && acAct.v, delta: dPct(acAct && acAct.v, acPrev && acPrev.v), deltaRef: 'mismo periodo ' + (y - 1) },
        { label: 'Nacimientos en ' + A.x[A.x.length - 1] + ' (último año completo)', valor: A.nac[A.nac.length - 1], delta: dPct(A.nac[A.nac.length - 1], A.nac[A.nac.length - 2]), deltaRef: 'frente a ' + A.x[A.x.length - 2], serie: A.nac.slice(-20) }
      ],
      extra: '<div class="obs-grid">' + htmlMapa() + '</div>' +
        '<div class="obs-section-head nat-sub"><h2>Récords vigentes</h2><p>Cada récord con el que batió. En el mapa, los tres meses más bajos llevan marco grueso y el mínimo de cada mes del calendario, discontinuo.</p></div>' +
        htmlRecords()
    };
  }

  function seccionEvolucion() {
    var mesSpec = function (mm) {
      var p = pares('tasa', mm);
      return { type: 'line', xType: 'anual', xLabel: 'Año', x: p.map(function (q) { return q.k.slice(0, 4); }), yFormat: 'dec1', zoomDesde: 0,
        tablaFormato: function (v) { return v == null ? '—' : F.num(v, 2); },
        series: [{ name: 'Tasa de ' + MES[+mm - 1], data: p.map(function (q) { return q.v; }) }] };
    };
    var ult = M.x[M.x.length - 1], m = +ult.slice(5);
    var ac = acumulados(m).slice(-25);
    var opMes = MES.map(function (n, i) { return { v: ('0' + (i + 1)).slice(-2), txt: n.charAt(0).toUpperCase() + n.slice(1) }; });
    return {
      cards: [
        {
          titulo: 'Tasa bruta de natalidad', sub: 'Nacidos por cada 1.000 habitantes, ' + A.x[0] + '-' + A.x[A.x.length - 1],
          chips: [{ txt: 'Anual' }], fuente: FUENTE_HIST, ancho: 'full', alto: 'tall',
          nota: 'Hasta 1940, anuarios históricos (1871-1877 sin dato; antes de 1900 la población es estimación entre censos). Desde 1941, suma de los meses del INE sobre la población a mitad de año.',
          spec: { type: 'line', xType: 'anual', xLabel: 'Año', x: A.x, yFormat: 'dec1', desdeCero: true, zoomDesde: 0,
            tablaFormato: function (v) { return v == null ? '—' : F.num(v, 2); },
            series: [{ name: 'Tasa bruta de natalidad', data: A.tasa }] }
        },
        {
          titulo: 'Nacimientos al año', sub: 'Nacidos vivos', chips: [{ txt: 'Anual' }], fuente: FUENTE_HIST, ancho: 'full',
          spec: { type: 'bar', xType: 'anual', xLabel: 'Año', x: A.x, yFormat: 'num', zoomDesde: 0, series: [{ name: 'Nacimientos', data: A.nac }] }
        },
        {
          titulo: 'Un mes a lo largo de los años', sub: 'Tasa anualizada de ese mes, desde 1941',
          chips: [{ txt: 'Mensual', tipo: 'live' }], fuente: FUENTE_MNP,
          control: { label: 'Mes', valor: ult.slice(5), opciones: opMes, spec: mesSpec },
          spec: mesSpec(ult.slice(5))
        },
        {
          titulo: 'Acumulado enero-' + MES[m - 1], sub: 'Nacimientos del mismo periodo, últimos ' + ac.length + ' años',
          chips: [{ txt: 'Mensual', tipo: 'live' }], fuente: FUENTE_EMN,
          spec: { type: 'bar', xType: 'anual', xLabel: 'Año', x: ac.map(function (p) { return p.k; }), yFormat: 'num',
            series: [{ name: 'Nacimientos enero-' + MES[m - 1], data: ac.map(function (p) { return p.v; }) }] }
        }
      ]
    };
  }

  /* ----------------------------------------------------------- Arranque -- */

  function arrancar() {
    if (!M.x.length) { document.getElementById('obs-app').textContent = 'No se han podido cargar los datos.'; return; }
    Obs.init({
      titulo: 'Observatorio de la natalidad en España',
      subtitulo: 'Nacimientos de cada mes desde 1941 y de cada año desde 1858, con aviso de mínimos históricos',
      secciones: [
        { id: 'mapa', nombre: 'Mapa de calor', titulo: 'La natalidad de cada mes',
          desc: 'Cada columna es un año y cada fila un mes. Al abrir la página se consulta al INE el último dato publicado; si un mes, el acumulado del año o un año completo marca un mínimo histórico, salta el aviso de arriba.',
          render: seccionMapa },
        { id: 'evolucion', nombre: 'Evolución', titulo: 'Evolución a largo plazo',
          desc: 'La serie anual desde 1858 y el detalle por mes del calendario. Todas las tarjetas permiten ver los datos en tabla y descargarlos.',
          render: seccionEvolucion }
      ],
      actualizado: (D.meta || {}).actualizado,
      fuentes: [FUENTE_MNP, FUENTE_EMN, FUENTE_ECP, FUENTE_HIST],
      metodologia: 'Un proceso automático (<code>pipeline/build_data.py</code>) une tres series mensuales del INE: MNP histórico 1941-1974, MNP definitivo desde 1975 y la Estimación Mensual de Nacimientos para los meses aún sin dato definitivo. ' +
        'La población sale de la Estadística Continua de Población (desde 1971) y de los censos antes. Además, la página consulta al INE en directo al abrirse.',
      pie: 'Los últimos meses son estimaciones del INE y se revisan cuando sale el dato definitivo. Antes de 1941 no hay serie mensual pública sin registro; la serie anual 1858-1940 procede de anuarios históricos.'
    });
    var u = M.x[M.x.length - 1];
    Obs.estado('Último mes publicado: ' + etiquetaMes(u) + (enVivo.ok ? ' · consultado al INE ahora' : ' · datos del ' + new Date(D.meta.actualizado).toLocaleDateString('es-ES')), enVivo.ok ? 'live' : '');
    engancharMapa();
    pintarMapa();
    /* Al volver a la pestaña del mapa, el kit vuelve a montar la sección. */
    document.querySelector('.obs-nav-in').addEventListener('click', function () {
      setTimeout(function () {
        var n = document.getElementById('nat-heat');
        if (n && heat && heat.getDom() !== n) { heat.dispose(); heat = null; }
        if (n && !heat) { engancharMapa(); pintarMapa(); }
      }, 0);
    });
  }

  traerEnVivo().then(arrancar, arrancar);

})();
