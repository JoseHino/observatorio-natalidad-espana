/* ============================================================================
   obs-map.js — Mapa de puntos para los Observatorios de Indicadores
   ----------------------------------------------------------------------------
   Mapa con agrupación, capa de calor, filtros y línea del tiempo, declarado con
   la misma filosofía que el resto del kit: se describe qué se pinta y el
   componente resuelve el cómo.

       Obs.mapa(el, {
         puntos: [...],
         fecha:  p => p.alta,          // AAAA-MM-DD, para la línea del tiempo
         popup:  p => '<b>…</b>',
         grupo:  p => p.tipo,          // decide color y leyenda
         peso:   p => p.plazas,        // pondera la capa de calor (opcional)
         filtros: [ {id, label, valor: p => …, tipo: 'select'|'rango'} ],
         linea:  { etiqueta: 'Alta en el registro', acumulado: true }
       })

   Depende de Leaflet, Leaflet.markercluster y Leaflet.heat (CDN), además de los
   tokens de obs.css.
   ========================================================================== */
(function (global) {
  'use strict';

  var Obs = global.Obs = global.Obs || {};
  var mapas = [];

  /* Teselas grises de Esri: sobrias, sin el ruido de color del mapa estándar de
     OSM, que compite con los datos. Se usan éstas y no las de CARTO porque
     CARTO pasó a exigir clave: sin ella devuelve un PNG con «API KEY REQUIRED»
     estampado, y como responde con HTTP 200 el fallo no salta por ningún lado,
     simplemente el mapa sale rotulado con el aviso. */
  var TESELAS = {
    claro: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}',
    oscuro: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}',
    /* El fondo gris va sin rótulos a propósito; los topónimos son una capa
       aparte que se pinta ENCIMA de los datos, para que un nombre de
       urbanización no quede tapado por un grupo de puntos. */
    rotulosClaro: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}',
    rotulosOscuro: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}',
    /* Ortofoto del mismo servicio, sin clave. Sirve para reconocer el terreno
       —urbanizaciones, campos de golf, monte— cuando el fondo gris no basta;
       sus rótulos van en la capa de referencia híbrida, no en la imagen. */
    satelite: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    rotulosSatelite: 'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',
    credito: 'Teselas &copy; Esri &mdash; Esri, DeLorme, NAVTEQ · Datos &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    creditoSatelite: 'Ortofoto &copy; Esri &mdash; Maxar, Earthstar Geographics y la comunidad de usuarios de Esri'
  };

  /* Zoom máximo con tesela propia de cada fondo: el gris de Esri se acaba en 16
     y la ortofoto llega a 19. Poner 16 a las dos dejaría la foto borrosa de más. */
  var ZOOM_NATIVO = { mapa: 16, satelite: 18 };


  /* Rampa cálida de densidad (ColorBrewer YlOrRd): amarillo claro donde hay
     poco, rojo profundo donde se concentran. Es secuencial y monótona en
     luminosidad, así que se lee bien también impresa en gris y con daltonismo:
     lo que ordena la escala es el brillo, no solo el tono. */
  var CALOR = {
    0.00: '#ffffb2',
    0.25: '#fed976',
    0.45: '#feb24c',
    0.62: '#fd8d3c',
    0.78: '#fc4e2a',
    0.90: '#e31a1c',
    1.00: '#b10026'
  };

  function esOscuro() {
    var t = document.documentElement.getAttribute('data-theme');
    return t === 'dark' || (!t && matchMedia('(prefers-color-scheme: dark)').matches);
  }

  function anyoDe(f) {
    var s = String(f || '');
    return /^\d{4}/.test(s) ? +s.slice(0, 4) : null;
  }

  /* --------------------------------------------------------------- 1. Marco */

  function marco(id, cfg) {
    var filtros = (cfg.filtros || []).map(function (f) {
      if (f.tipo === 'rango') {
        return '<label class="obs-map-f"><span>' + Obs.esc(f.label) + '</span>' +
          '<select class="obs-select" data-filtro="' + f.id + '"></select></label>';
      }
      return '<label class="obs-map-f"><span>' + Obs.esc(f.label) + '</span>' +
        '<select class="obs-select" data-filtro="' + f.id + '"></select></label>';
    }).join('');

    var linea = cfg.linea ? (
      '<div class="obs-map-linea">' +
        '<button type="button" class="obs-icon-btn" data-act="play" title="Reproducir la evolución">' +
          '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>' +
        '</button>' +
        '<div class="obs-map-linea-in">' +
          '<div class="obs-map-linea-lbl"><span>' + Obs.esc(cfg.linea.etiqueta || 'Periodo') + '</span>' +
            '<b data-rol="anyo"></b></div>' +
          '<input type="range" data-rol="tiempo" step="1">' +
          '<div class="obs-map-linea-ejes"><span data-rol="min"></span><span data-rol="max"></span></div>' +
        '</div>' +
      '</div>') : '';

    /* En modo automático no hay conmutador de capa: la vista la decide el zoom,
       igual que en cualquier mapa de calor al uso. Un botón que ofrezca lo que
       el mapa ya hace solo sirve para que el usuario se pregunte cuál elegir. */
    var conmutador = cfg.modo === 'auto' ? '' :
      '<div class="obs-segment" role="group">' +
        '<button type="button" data-capa="puntos" aria-pressed="true">Puntos</button>' +
        '<button type="button" data-capa="calor" aria-pressed="false">Calor</button>' +
      '</div>';

    /* Fondo del mapa. Va aparte del conmutador de capas de datos: una cosa es
       cómo se pintan los datos y otra sobre qué se pintan. */
    var fondo = cfg.satelite === false ? '' :
      '<div class="obs-segment" role="group">' +
        '<button type="button" data-fondo="mapa" aria-pressed="true">Mapa</button>' +
        '<button type="button" data-fondo="satelite" aria-pressed="false">Satélite</button>' +
      '</div>';

    return '<div class="obs-map" data-mapa="' + id + '">' +
      '<div class="obs-map-tools">' + filtros +
        '<div class="obs-map-capas">' + fondo + conmutador +
          '<button type="button" class="obs-btn" data-act="reset">Restablecer</button>' +
        '</div>' +
        '<div class="obs-map-cuenta" data-rol="cuenta"></div>' +
      '</div>' +
      '<div class="obs-map-lienzo" data-rol="lienzo"></div>' +
      linea +
      '<div class="obs-map-leyenda" data-rol="leyenda"></div>' +
    '</div>';
  }

  /* --------------------------------------------------------------- 2. Motor */

  /**
   * Dibuja un mapa de puntos.
   * @param {HTMLElement|string} el contenedor
   * @param {Object} cfg ver cabecera
   */
  Obs.mapa = function (el, cfg) {
    var host = typeof el === 'string' ? document.querySelector(el) : el;
    if (!host) { console.warn('[obs-map] contenedor no encontrado:', el); return null; }
    if (typeof L === 'undefined') {
      host.innerHTML = '<div class="obs-msg error">No se pudo cargar la librería de mapas.</div>';
      return null;
    }

    var puntos = (cfg.puntos || []).filter(function (p) {
      return p && isFinite(p.lat) && isFinite(p.lon);
    });
    if (!puntos.length) {
      host.innerHTML = '<div class="obs-msg">Ningún punto georreferenciado que mostrar.</div>';
      return null;
    }

    var id = 'm' + (mapas.length + 1);
    host.innerHTML = marco(id, cfg);
    var raiz = host.querySelector('.obs-map');
    var lienzo = raiz.querySelector('[data-rol="lienzo"]');

    var T = Obs.tema();
    var mapa = L.map(lienzo, { scrollWheelZoom: false, zoomControl: true, attributionControl: true });
    /* maxNativeZoom: el servicio de Esri no sirve teselas por encima de 16, pero
       el mapa sigue admitiendo acercarse: Leaflet reescala la última disponible
       en lugar de dejar el fondo en gris. */
    var fondoActivo = 'mapa';
    var teselas = L.tileLayer(esOscuro() ? TESELAS.oscuro : TESELAS.claro,
      { attribution: TESELAS.credito, maxZoom: 19, maxNativeZoom: ZOOM_NATIVO.mapa }).addTo(mapa);
    var rotulos = L.tileLayer(esOscuro() ? TESELAS.rotulosOscuro : TESELAS.rotulosClaro,
      { maxZoom: 19, maxNativeZoom: ZOOM_NATIVO.mapa, pane: 'shadowPane', opacity: .9 }).addTo(mapa);

    /* Cambia la ortofoto por el fondo gris y viceversa. Se reutilizan las dos
       capas ya creadas en lugar de añadir y quitar capas: así el orden de
       pintado (datos encima del fondo, rótulos encima de los datos) no cambia. */
    function ponerFondo(cual) {
      fondoActivo = cual;
      var sat = cual === 'satelite';
      teselas.options.maxNativeZoom = sat ? ZOOM_NATIVO.satelite : ZOOM_NATIVO.mapa;
      rotulos.options.maxNativeZoom = teselas.options.maxNativeZoom;
      teselas.setUrl(sat ? TESELAS.satelite : (esOscuro() ? TESELAS.oscuro : TESELAS.claro));
      rotulos.setUrl(sat ? TESELAS.rotulosSatelite
                         : (esOscuro() ? TESELAS.rotulosOscuro : TESELAS.rotulosClaro));
      /* Sobre la foto, los rótulos claros de la capa gris no se leerían. */
      rotulos.setOpacity(sat ? 1 : .9);
      raiz.classList.toggle('es-satelite', sat);
      mapa.attributionControl.removeAttribution(TESELAS.credito);
      mapa.attributionControl.removeAttribution(TESELAS.creditoSatelite);
      mapa.attributionControl.addAttribution(sat ? TESELAS.creditoSatelite : TESELAS.credito);
    }
    /* Sin scroll-zoom por defecto: en una página larga, la rueda debe seguir
       desplazando la página. Con Ctrl o tras hacer clic dentro, sí hace zoom. */
    mapa.on('click', function () { mapa.scrollWheelZoom.enable(); });
    mapa.on('mouseout', function () { mapa.scrollWheelZoom.disable(); });

    /* --- grupos y colores: el color sigue a la categoría, nunca al orden --- */
    var grupos = [];
    if (cfg.grupo) {
      puntos.forEach(function (p) {
        var g = cfg.grupo(p) || 'Sin clasificar';
        if (grupos.indexOf(g) < 0) grupos.push(g);
      });
      grupos.sort();
    }
    var colorDe = function (p) {
      if (!cfg.grupo) return T.serie[0];
      var i = grupos.indexOf(cfg.grupo(p) || 'Sin clasificar');
      return T.serie[i % T.serie.length];
    };

    /* --- capas --- */
    /* `agrupar: false` pinta un punto por registro en lugar de burbujas con el
       recuento. Con miles de puntos hay que dibujar sobre lienzo (`L.canvas`) o
       el navegador crea un nodo SVG por punto y la pestaña se arrastra. */
    var agrupa = cfg.agrupar !== false;
    var lienzoPuntos = L.canvas({ padding: 0.3 });
    var cluster = agrupa ? L.markerClusterGroup({
      showCoverageOnHover: false, maxClusterRadius: 45, disableClusteringAtZoom: 17,
      iconCreateFunction: function (c) {
        var n = c.getChildCount();
        var talla = n < 25 ? 30 : (n < 150 ? 38 : 46);
        return L.divIcon({
          html: '<span>' + Obs.fmt.num(n) + '</span>',
          className: 'obs-cluster',
          iconSize: L.point(talla, talla)
        });
      }
    }) : L.layerGroup();
    var calor = null;

    var RADIO = cfg.radio || (agrupa ? 6 : 4.5);

    function marcador(p) {
      var m = L.circleMarker([p.lat, p.lon], {
        renderer: agrupa ? undefined : lienzoPuntos,
        radius: RADIO,
        /* El anillo del color del fondo separa los puntos que se solapan; sin
           agrupación, además, la semitransparencia deja que el amontonamiento
           se lea por sí solo. */
        weight: agrupa ? 2 : 1,
        color: T.surface,
        fillColor: colorDe(p),
        fillOpacity: agrupa ? .92 : .78
      });
      /* El globo se compone al hacer clic: preparar miles por adelantado
         cuesta más que dibujar el mapa entero. */
      if (cfg.popup) {
        m.on('click', function (ev) {
          L.popup({ maxWidth: 320, className: 'obs-popup' })
            .setLatLng(ev.latlng).setContent(cfg.popup(p)).openOn(mapa);
        });
      }
      return m;
    }

    /* --- filtros --- */
    var estado = {};
    (cfg.filtros || []).forEach(function (f) {
      var sel = raiz.querySelector('[data-filtro="' + f.id + '"]');
      var vals = [];
      puntos.forEach(function (p) {
        var v = f.valor(p);
        if (v == null || v === '') return;
        if (vals.indexOf(v) < 0) vals.push(v);
      });
      vals.sort(function (a, b) {
        return (typeof a === 'number' && typeof b === 'number') ? a - b : String(a).localeCompare(String(b), 'es');
      });
      sel.innerHTML = '<option value="">Todas</option>' + vals.map(function (v) {
        return '<option value="' + Obs.esc(v) + '">' + Obs.esc(f.etiquetaValor ? f.etiquetaValor(v) : v) + '</option>';
      }).join('');
      estado[f.id] = '';
      sel.addEventListener('change', function () { estado[f.id] = sel.value; pintar(); });
    });

    /* --- línea del tiempo --- */
    var corte = null, anyos = [], reproduciendo = null;
    if (cfg.linea && cfg.fecha) {
      puntos.forEach(function (p) {
        var a = anyoDe(cfg.fecha(p));
        if (a && anyos.indexOf(a) < 0) anyos.push(a);
      });
      anyos.sort(function (a, b) { return a - b; });
      /* Se recorta la cola larga: un par de altas sueltas de 2000 estirarían la
         barra veinte años para no mover nada en el mapa. */
      if (anyos.length > 12) {
        var umbral = anyos[Math.max(0, anyos.length - 12)];
        var previas = puntos.filter(function (p) { var a = anyoDe(cfg.fecha(p)); return a && a < umbral; }).length;
        if (previas / puntos.length < 0.05) anyos = anyos.filter(function (a) { return a >= umbral; });
      }
      var rango = raiz.querySelector('[data-rol="tiempo"]');
      rango.min = 0; rango.max = anyos.length - 1; rango.value = anyos.length - 1;
      raiz.querySelector('[data-rol="min"]').textContent = anyos[0];
      raiz.querySelector('[data-rol="max"]').textContent = anyos[anyos.length - 1];
      corte = anyos[anyos.length - 1];
      rango.addEventListener('input', function () {
        corte = anyos[+rango.value];
        pintar();
      });
      raiz.querySelector('[data-act="play"]').addEventListener('click', function () {
        var btn = this;
        if (reproduciendo) {
          clearInterval(reproduciendo); reproduciendo = null;
          btn.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
          return;
        }
        btn.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>';
        if (+rango.value >= anyos.length - 1) { rango.value = 0; corte = anyos[0]; pintar(); }
        reproduciendo = setInterval(function () {
          if (+rango.value >= anyos.length - 1) {
            clearInterval(reproduciendo); reproduciendo = null;
            btn.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
            return;
          }
          rango.value = +rango.value + 1;
          corte = anyos[+rango.value];
          pintar();
        }, 900);
      });
    }

    /* --- pintado --- */
    /* Zoom a partir del cual el mapa deja de resumir y enseña cada registro.
       Por debajo, con miles de puntos amontonados, lo único legible es la
       densidad; por encima, lo que interesa es la vivienda concreta. */
    var ZOOM_DETALLE = cfg.zoomDetalle || 15;
    var automatico = cfg.modo === 'auto';
    var capaActiva = automatico ? 'calor' : 'puntos';

    function capaSegunZoom() {
      return mapa.getZoom() >= ZOOM_DETALLE ? 'puntos' : 'calor';
    }

    function visibles() {
      return puntos.filter(function (p) {
        for (var i = 0; i < (cfg.filtros || []).length; i++) {
          var f = cfg.filtros[i];
          if (estado[f.id] !== '' && String(f.valor(p)) !== String(estado[f.id])) return false;
        }
        if (corte != null && cfg.fecha) {
          var a = anyoDe(cfg.fecha(p));
          /* Acumulado: en el año N se ven todas las altas hasta N incluido.
             Sin fecha utilizable el punto se muestra siempre, y se dice cuántos son. */
          if (a != null && a > corte) return false;
        }
        return true;
      });
    }

    function pintar() {
      var vs = visibles();

      cluster.clearLayers();
      if (capaActiva === 'puntos') {
        var marcas = vs.map(marcador);
        if (agrupa) cluster.addLayers(marcas);
        else marcas.forEach(function (m) { cluster.addLayer(m); });
        if (!mapa.hasLayer(cluster)) mapa.addLayer(cluster);
      } else {
        if (mapa.hasLayer(cluster)) mapa.removeLayer(cluster);
        /* El lienzo de los puntos es un renderizador propio: quitar el grupo de
           capas lo vacía, pero deja el elemento colgado en el panel. */
        if (!agrupa && mapa.hasLayer(lienzoPuntos)) mapa.removeLayer(lienzoPuntos);
      }

      if (calor) { mapa.removeLayer(calor); calor = null; }
      /* Leaflet.heat llama a getImageData sobre su propio lienzo: si la sección
         todavía está oculta el lienzo mide 0 y lanza una excepción. Se pospone. */
      if (capaActiva === 'calor' && lienzo.offsetWidth > 0) {
        var max = 1;
        var datos = vs.map(function (p) {
          var w = cfg.peso ? (+cfg.peso(p) || 1) : 1;
          if (w > max) max = w;
          return [p.lat, p.lon, w];
        });
        calor = L.heatLayer(datos, {
          radius: 22, blur: 18, maxZoom: 16, max: max,
          minOpacity: .30,
          gradient: cfg.gradiente || CALOR
        }).addTo(mapa);
      }

      visiblesAhora = vs;
      actualizarCuenta();
      if (corte != null) {
        var lbl = raiz.querySelector('[data-rol="anyo"]');
        if (lbl) lbl.textContent = corte;
      }
    }

    /* --- recuento ---
       Se dice cuántos hay y, en la vista de detalle, cuántos caben en pantalla.
       Sin ese segundo número, ver veinte puntos bajo un rótulo que pone 2.205
       hace pensar que faltan datos, cuando lo que pasa es que el resto está
       fuera del encuadre. */
    var visiblesAhora = puntos;

    function actualizarCuenta() {
      var cuenta = raiz.querySelector('[data-rol="cuenta"]');
      if (!cuenta) return;
      var vs = visiblesAhora;
      var sinFecha = cfg.fecha ? vs.filter(function (p) { return anyoDe(cfg.fecha(p)) == null; }).length : 0;
      var unidad = cfg.unidad ? ' ' + cfg.unidad : '';

      var txt = '<b>' + Obs.fmt.num(vs.length) + '</b>' +
        (vs.length !== puntos.length ? ' de ' + Obs.fmt.num(puntos.length) : '') + unidad;

      if (capaActiva === 'puntos' && mapa._loaded) {
        var b = mapa.getBounds();
        var enPantalla = vs.filter(function (p) { return b.contains([p.lat, p.lon]); }).length;
        if (enPantalla !== vs.length) {
          txt += ' <span class="obs-map-nota">·</span> <b>' + Obs.fmt.num(enPantalla) + '</b> en pantalla';
        }
      }
      if (sinFecha) txt += ' <span class="obs-map-nota">(' + Obs.fmt.num(sinFecha) + ' sin fecha)</span>';
      if (automatico && capaActiva === 'calor') {
        txt += ' <span class="obs-map-pista">acerca el mapa para ver cada ' +
          Obs.esc(cfg.unidadSingular || 'punto') + '</span>';
      }
      cuenta.innerHTML = txt;
    }

    /* Al desplazar el mapa cambia lo que cabe en pantalla, no lo que hay. */
    mapa.on('moveend', actualizarCuenta);

    /* --- leyenda ---
       Cada capa codifica el color de una forma distinta, así que cada una lleva
       su leyenda: identidad (tipología) en la de puntos, y escala continua de
       densidad en la de calor. Un color que significa algo sin leyenda que lo
       diga no es legible. */
    var cajaLeyenda = raiz.querySelector('[data-rol="leyenda"]');

    function leyendaCategorias() {
      if (!cfg.grupo) return '';
      return grupos.map(function (g, i) {
        return '<span class="obs-map-item"><i style="background:' + T.serie[i % T.serie.length] + '"></i>' +
          Obs.esc(g) + '</span>';
      }).join('');
    }

    function leyendaCalor() {
      var g = cfg.gradiente || CALOR;
      var paradas = Object.keys(g).map(Number).sort(function (a, b) { return a - b; });
      var css = paradas.map(function (p) { return g[p] + ' ' + Math.round(p * 100) + '%'; }).join(', ');
      return '<span class="obs-map-item">' + Obs.esc(cfg.calorEtiqueta || 'Densidad') + '</span>' +
        '<span class="obs-map-escala">' +
          '<span class="ext">menos</span>' +
          '<span class="barra" style="background:linear-gradient(90deg,' + css + ')"></span>' +
          '<span class="ext">más</span>' +
        '</span>';
    }

    function leyendaSegun(capa) {
      cajaLeyenda.innerHTML = capa === 'calor' ? leyendaCalor() : leyendaCategorias();
      cajaLeyenda.style.display = cajaLeyenda.innerHTML ? '' : 'none';
    }
    leyendaSegun('puntos');

    /* --- conmutador de capa y reinicio --- */
    /* Al acercarse o alejarse el mapa cambia solo de resumen a detalle. */
    if (automatico) {
      mapa.on('zoomend', function () {
        var nueva = capaSegunZoom();
        if (nueva === capaActiva) return;
        capaActiva = nueva;
        leyendaSegun(capaActiva);
        pintar();
      });
    }

    raiz.querySelector('.obs-map-capas').addEventListener('click', function (ev) {
      var b = ev.target.closest('button');
      if (!b) return;
      if (b.getAttribute('data-act') === 'reset') {
        (cfg.filtros || []).forEach(function (f) {
          estado[f.id] = '';
          raiz.querySelector('[data-filtro="' + f.id + '"]').value = '';
        });
        var r = raiz.querySelector('[data-rol="tiempo"]');
        if (r) { r.value = r.max; corte = anyos[anyos.length - 1]; }
        mapa.fitBounds(L.latLngBounds(puntos.map(function (p) { return [p.lat, p.lon]; })).pad(0.08));
        pintar();
        return;
      }
      var elFondo = b.getAttribute('data-fondo');
      if (elFondo) {
        if (elFondo === fondoActivo) return;
        ponerFondo(elFondo);
        raiz.querySelectorAll('[data-fondo]').forEach(function (x) {
          x.setAttribute('aria-pressed', x === b ? 'true' : 'false');
        });
        pintar();
        return;
      }
      var capa = b.getAttribute('data-capa');
      if (!capa) return;
      capaActiva = capa;
      raiz.querySelectorAll('[data-capa]').forEach(function (x) {
        x.setAttribute('aria-pressed', x === b ? 'true' : 'false');
      });
      leyendaSegun(capa);
      pintar();
    });

    /* Si el contenedor se queda sin tamaño (sección oculta, captura de pantalla,
       ventana minimizada) la capa de calor intenta leer un lienzo de 0 px y
       lanza una excepción por dentro de la librería. Se retira y se repone. */
    mapa.on('resize', function () {
      var s = mapa.getSize();
      if ((!s.x || !s.y) && calor) { mapa.removeLayer(calor); calor = null; }
      else if (s.x && s.y && capaActiva === 'calor' && !calor) pintar();
    });

    mapa.fitBounds(L.latLngBounds(puntos.map(function (p) { return [p.lat, p.lon]; })).pad(0.08));
    if (automatico) capaActiva = capaSegunZoom();
    leyendaSegun(capaActiva);
    pintar();

    /* Al mostrarse la sección el lienzo pasa de 0 a su tamaño real: hay que
       avisar a Leaflet y repintar, o el mapa queda gris a medio dibujar. */
    if (typeof ResizeObserver !== 'undefined') {
      var visto = lienzo.offsetWidth;
      new ResizeObserver(function () {
        if (lienzo.offsetWidth && lienzo.offsetWidth !== visto) {
          visto = lienzo.offsetWidth;
          mapa.invalidateSize();
          pintar();
        }
      }).observe(lienzo);
    }

    var ref = { mapa: mapa, teselas: teselas, rotulos: rotulos, repintar: pintar,
                fondo: function () { return fondoActivo; } };
    mapas.push(ref);
    setTimeout(function () { mapa.invalidateSize(); }, 60);
    return ref;
  };

  /** Mapas vivos de la página. Útil para diagnosticar desde la consola. */
  Obs.mapasActivos = function () { return mapas; };

  /** Cambia las teselas al tema activo. Lo llama el armazón al conmutar. */
  Obs.mapasRepintar = function () {
    mapas.forEach(function (r) {
      /* Con la ortofoto puesta, el tema de la página no manda sobre el fondo:
         una foto aérea no tiene versión oscura. */
      if (r.fondo && r.fondo() === 'satelite') { r.repintar(); return; }
      r.teselas.setUrl(esOscuro() ? TESELAS.oscuro : TESELAS.claro);
      if (r.rotulos) r.rotulos.setUrl(esOscuro() ? TESELAS.rotulosOscuro : TESELAS.rotulosClaro);
      r.repintar();
    });
  };

})(window);
