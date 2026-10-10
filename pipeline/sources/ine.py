# -*- coding: utf-8 -*-
"""INE - API Tempus3 (https://servicios.ine.es/wstempus/).

Tiene CORS abierto y admite `?nult=N` ("dame los N ultimos periodos"), que es lo
que permite un observatorio vivo sin base de datos propia.

    TRAMPA IMPORTANTE - el campo `Fecha`
    ------------------------------------
    Cada punto trae `Fecha` en milisegundos de epoch, fijada a medianoche en
    hora de Madrid. Si se convierte a UTC (que es lo que hace
    `datetime.fromtimestamp(f/1000, timezone.utc)`), enero de 2026 sale como
    2025-12-31T23:00Z y TODA la serie mensual queda corrida un mes hacia atras.
    El error es silencioso: la grafica se dibuja perfecta y con las cifras
    buenas, solo que etiquetadas en el mes equivocado.

    Por eso este modulo NUNCA usa `Fecha`. El periodo se construye con `Anyo` +
    `FK_Periodo`, que vienen ya como numeros del calendario y no dependen de
    ninguna zona horaria.
"""

from .comun import get_json, aviso

SERIE = "https://servicios.ine.es/wstempus/js/ES/DATOS_SERIE/"
TABLA = "https://servicios.ine.es/wstempus/js/ES/DATOS_TABLA/"


def _puntos(cod, nult):
    try:
        j = get_json(f"{SERIE}{cod}?nult={nult}")
    except Exception as e:                                        # noqa: BLE001
        aviso(f"INE serie {cod}: {e}")
        return []
    return [d for d in j.get("Data", []) if d.get("Valor") is not None]


def mensual(cod, nult=400):
    """Serie mensual -> {"x": ["2026-01", ...], "v": [valor, ...]}.

    FK_Periodo 1..12 son los meses. Cualquier otro codigo (M13 = media anual y
    similares) se descarta: no es un mes del calendario.
    """
    filas = {}
    for d in _puntos(cod, nult):
        p = d.get("FK_Periodo")
        if p is None or not (1 <= int(p) <= 12):
            continue
        filas[f"{int(d['Anyo']):04d}-{int(p):02d}"] = d["Valor"]
    xs = sorted(filas)
    return {"x": xs, "v": [filas[t] for t in xs]}


def trimestral(cod, nult=200):
    """Serie trimestral -> x con formato "2026T1".

    En Tempus3 los trimestres llegan como FK_Periodo 1..4 en unas operaciones y
    como los meses de cierre (3, 6, 9, 12) en otras; se admiten los dos.
    """
    cierre = {3: 1, 6: 2, 9: 3, 12: 4}
    filas = {}
    for d in _puntos(cod, nult):
        p = d.get("FK_Periodo")
        if p is None:
            continue
        p = int(p)
        t = p if 1 <= p <= 4 else cierre.get(p)
        if not t:
            continue
        filas[f"{int(d['Anyo']):04d}T{t}"] = d["Valor"]
    xs = sorted(filas)
    return {"x": xs, "v": [filas[t] for t in xs]}


def anual(cod, nult=60):
    """Serie anual -> x con el año como cadena ("2025")."""
    filas = {}
    for d in _puntos(cod, nult):
        filas[str(int(d["Anyo"]))] = d["Valor"]
    xs = sorted(filas)
    return {"x": xs, "v": [filas[t] for t in xs]}


def tabla(cod, tv=None, det=2):
    """Series de una tabla completa de Tempus3 (para operaciones sin codigo de
    serie estable). `tv` filtra por variable:valor, p. ej. tv="115:29069"."""
    url = f"{TABLA}{cod}?det={det}" + (f"&tv={tv}" if tv else "")
    try:
        return get_json(url)
    except Exception as e:                                        # noqa: BLE001
        aviso(f"INE tabla {cod}: {e}")
        return []


def buscar(series, *trozos):
    """De la lista devuelta por `tabla`, la primera serie cuyo Nombre contenga
    TODOS los trozos indicados. Devuelve serie anual."""
    nd = [t.lower() for t in trozos]
    s = next((x for x in series if all(n in x.get("Nombre", "").lower() for n in nd)), None)
    if not s:
        aviso(f"INE: ninguna serie contiene {trozos}")
        return {"x": [], "v": []}
    filas = {}
    for p in s.get("Data", []):
        if p.get("Valor") is None:
            continue
        filas[str(int(p["Anyo"]))] = p["Valor"]
    xs = sorted(filas)
    return {"x": xs, "v": [filas[t] for t in xs]}
