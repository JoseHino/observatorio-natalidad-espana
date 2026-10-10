# -*- coding: utf-8 -*-
"""Colector del observatorio de natalidad: descarga el INE y escribe data/data.js.

    python pipeline/build_data.py

Series que une (todas de Tempus3, total nacional, nacidos vivos por mes):

  MNP17521  1941-1974  MNP, serie historica por lugar de inscripcion
  MNP17451  1975-...   MNP definitivo por residencia de la madre
  EMN39     2013-...   Estimacion Mensual de Nacimientos (llega hasta hace ~2 meses;
                       en los anos con dato definitivo coincide con el MNP)
  ECP320    1971-...   Poblacion residente trimestral (para las tasas)

Antes de 1941 solo hay dato anual: pipeline/historico_anual.csv (1858-1975).

Ademas de data.js, calcula las alertas de minimo historico. Si aparece una
alerta que no estaba en el data.js publicado, escribe ALERTA_NUEVA.md para que la
Action abra una incidencia en GitHub (que llega por correo al propietario).
"""

import calendar
import datetime
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from sources import ine                                            # noqa: E402
from sources.comun import escribir_js, paso, ok, aviso, get_json   # noqa: E402

RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SALIDA = os.path.join(RAIZ, "data", "data.js")
HISTORICO = os.path.join(RAIZ, "pipeline", "historico_anual.csv")
ALERTA_MD = os.path.join(RAIZ, "ALERTA_NUEVA.md")

# Orden de prioridad: la ultima fuente de la lista manda si hay solape.
SERIES_NAC = [("MNP17521", 1000), ("MNP17451", 1000), ("EMN39", 400)]
SERIE_POB = "ECP320"
MESES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio",
         "agosto", "septiembre", "octubre", "noviembre", "diciembre"]


# ------------------------------------------------------------------ Recoleccion

def leer_historico():
    filas = []
    for lin in open(HISTORICO, encoding="utf-8"):
        if lin.startswith("#") or lin.startswith("anio"):
            continue
        a, p, n = lin.strip().split(",")
        filas.append((int(a), float(p), float(n) if n else None))
    return filas


def poblacion_trimestral():
    """ECP320: FK_Periodo 19..22 = 1 de enero, abril, julio y octubre."""
    j = get_json(f"{ine.SERIE}{SERIE_POB}?nult=400")
    mes = {19: 1, 20: 4, 21: 7, 22: 10}
    out = []
    for d in j.get("Data", []):
        p = int(d.get("FK_Periodo") or 0)
        if p in mes and d.get("Valor") is not None:
            out.append((int(d["Anyo"]) + (mes[p] - 1) / 12, d["Valor"]))
    return sorted(out)


def interpolar(anclas, t):
    """Lineal entre anclas (t, valor); despues de la ultima, prolonga la pendiente del ultimo ano."""
    if t <= anclas[0][0]:
        return anclas[0][1]
    for (t0, v0), (t1, v1) in zip(anclas, anclas[1:]):
        if t0 <= t <= t1:
            return v0 + (v1 - v0) * (t - t0) / (t1 - t0)
    ref = [a for a in anclas if a[0] >= anclas[-1][0] - 1]
    pend = (ref[-1][1] - ref[0][1]) / max(ref[-1][0] - ref[0][0], 0.25)
    return anclas[-1][1] + pend * (t - anclas[-1][0])


def recoger():
    fallos = []
    paso("INE - nacimientos mensuales")
    nac = {}
    for cod, nult in SERIES_NAC:
        s = ine.mensual(cod, nult)
        if not s["x"]:
            fallos.append(f"INE {cod}")
            continue
        nac.update(dict(zip(s["x"], s["v"])))
        ok(f"{cod}: {len(s['x'])} meses, {s['x'][0]} a {s['x'][-1]}")

    paso("INE - poblacion")
    hist = leer_historico()
    anclas = [(a, p) for a, p, _ in hist if a < 1971]
    try:
        ecp = poblacion_trimestral()
        ok(f"{SERIE_POB}: {len(ecp)} trimestres, hasta {ecp[-1][0]:.2f}")
    except Exception as e:                                        # noqa: BLE001
        fallos.append(f"INE {SERIE_POB}: {e}")
        aviso(str(e))
        ecp = []
    anclas += ecp or [(a, p) for a, p, _ in hist if a >= 1971]
    anclas.sort()

    x = sorted(nac)
    mensual = {"x": x, "nac": [], "dias": [], "pob": [], "tasa": []}
    for t in x:
        y, m = int(t[:4]), int(t[5:])
        dias = calendar.monthrange(y, m)[1]
        pob = interpolar(anclas, y + (m - 0.5) / 12)
        n = nac[t]
        mensual["nac"].append(int(n))
        mensual["dias"].append(dias)
        mensual["pob"].append(round(pob))
        # Tasa anualizada: nacidos por dia * 365,25 / poblacion, por mil. Asi un
        # febrero no parece "bajo" solo por tener menos dias.
        mensual["tasa"].append(round(n / dias * 365.25 / pob * 1000, 3))

    # Serie anual: historica hasta 1940, suma de meses completos desde 1941.
    anual = {"x": [], "nac": [], "tasa": []}
    pob1 = {a: p for a, p, _ in hist}
    for a, p, n in hist:
        if a >= 1941 or n is None or a + 1 not in pob1:
            continue
        anual["x"].append(str(a))
        anual["nac"].append(int(n))
        anual["tasa"].append(round(n / ((p + pob1[a + 1]) / 2) * 1000, 3))
    for a in sorted({t[:4] for t in x}):
        ms = [t for t in x if t[:4] == a]
        if len(ms) < 12:
            continue
        n = sum(nac[t] for t in ms)
        anual["x"].append(a)
        anual["nac"].append(int(n))
        anual["tasa"].append(round(n / interpolar(anclas, int(a) + 0.5) * 1000, 3))

    datos = {
        "meta": {
            "actualizado": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "ultimo_periodo": x[-1] if x else None,
            "fallos": fallos,
        },
        "mensual": mensual,
        "anual": anual,
        # Anclas de poblacion para que la pagina calcule la tasa de los meses
        # que traiga en vivo del INE y que aun no esten en este fichero.
        "pob_anclas": [[round(t, 4), round(v)] for t, v in anclas if t >= 2000],
    }
    datos["alertas"] = alertas(datos)
    return datos, fallos


# ---------------------------------------------------------------- Alertas

def record(pares):
    """pares = [(clave, valor)] en orden temporal -> (minimo, minimo anterior a el)."""
    pares = [p for p in pares if p[1] is not None]
    if not pares:
        return None, None
    i = min(range(len(pares)), key=lambda k: pares[k][1])
    antes = pares[:i]
    j = min(range(len(antes)), key=lambda k: antes[k][1]) if antes else None
    return pares[i], (antes[j] if j is not None else None)


def alertas(d):
    """Misma logica que alertas() en app.js: mantener las dos a la par."""
    M, A = d["mensual"], d["anual"]
    out = []
    if not M["x"]:
        return out
    ult = M["x"][-1]
    y, m = int(ult[:4]), int(ult[5:])
    nom = f"{MESES[m - 1].capitalize()} de {y}"
    por_dia = [n / dd for n, dd in zip(M["nac"], M["dias"])]
    for met, serie_v, txt in (("tasa", M["tasa"], "la tasa de natalidad mas baja"),
                              ("nac", por_dia, "menos nacimientos por dia")):
        serie = list(zip(M["x"], serie_v))
        r, _ = record(serie)
        if r and r[0] == ult:
            out.append({"id": f"mes-{met}-{ult}", "nivel": "crit",
                        "txt": f"{nom}: el mes con {txt} desde 1941"})
        r, _ = record([p for p in serie if p[0][5:] == ult[5:]])
        if r and r[0] == ult:
            out.append({"id": f"mescal-{met}-{ult}", "nivel": "warn",
                        "txt": f"{nom}: el {MESES[m - 1]} con {txt} desde 1941"})
    if A["x"]:
        ua = A["x"][-1]
        for met, txt in (("tasa", "la tasa de natalidad mas baja"), ("nac", "menos nacimientos")):
            r, _ = record(list(zip(A["x"], A[met])))
            if r and r[0] == ua:
                out.append({"id": f"anio-{met}-{ua}", "nivel": "crit",
                            "txt": f"{ua}: el ano con {txt} desde 1858"})
    if m < 12:
        acum = {}
        for t, n in zip(M["x"], M["nac"]):
            if int(t[5:]) <= m:
                acum[t[:4]] = acum.get(t[:4], 0) + n
        r, _ = record(sorted(acum.items()))
        if r and r[0] == str(y):
            out.append({"id": f"acum-{y}-{m}", "nivel": "warn",
                        "txt": f"Enero-{MESES[m - 1]} de {y}: el acumulado con menos nacimientos desde 1941"})
    return out


# --------------------------------------------------------------- Red de seguridad

def _contar_valores(obj):
    if isinstance(obj, dict):
        return sum(_contar_valores(v) for v in obj.values())
    if isinstance(obj, list):
        return sum(1 for v in obj if isinstance(v, (int, float)))
    return 0


def _vigente():
    if not os.path.exists(SALIDA):
        return None
    try:
        txt = open(SALIDA, encoding="utf-8").read()
        m = re.search(r"window\.\w+\s*=\s*(\{.*\});?\s*$", txt, re.S)
        return json.loads(m.group(1)) if m else None
    except Exception:                                             # noqa: BLE001
        return None


def main():
    print("== Observatorio de natalidad de Espana - recoleccion ==")
    datos, fallos = recoger()

    nuevos = _contar_valores(datos)
    previo = _vigente()
    if previo is not None and "mensual" in previo:
        antes = _contar_valores(previo)
        # 90 %: deja pasar una revision normal del INE, pero corta si una fuente
        # ha dejado de responder y el panel se quedaria cojo.
        if antes and nuevos < antes * 0.9:
            aviso(f"ABORTADO: {nuevos} valores frente a {antes} publicados "
                  f"({nuevos / antes:.0%}). No se sobrescribe data.js.")
            return 1

    paso("Alertas")
    conocidas = {a["id"] for a in (previo or {}).get("alertas", [])}
    nuevas = [a for a in datos["alertas"] if a["id"] not in conocidas]
    for a in datos["alertas"]:
        ok(("NUEVA   " if a in nuevas else "vigente ") + a["txt"])
    if os.path.exists(ALERTA_MD):
        os.remove(ALERTA_MD)
    if nuevas:
        with open(ALERTA_MD, "w", encoding="utf-8") as f:
            f.write("El INE ha publicado datos que marcan un nuevo minimo historico:\n\n")
            f.writelines(f"- {a['txt']}\n" for a in nuevas)
            f.write(f"\nUltimo periodo publicado: {datos['meta']['ultimo_periodo']}\n")

    paso("Escritura")
    escribir_js(SALIDA, datos)
    if fallos:
        aviso(f"{len(fallos)} fuente(s) con incidencia: " + "; ".join(fallos))
    print(f"\nListo. {nuevos} valores. Ultimo periodo: {datos['meta']['ultimo_periodo']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
