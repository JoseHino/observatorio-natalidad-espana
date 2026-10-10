# -*- coding: utf-8 -*-
"""Utilidades compartidas por todos los conectores de fuentes."""

import io
import json
import os
import time
import urllib.request

UA = {"User-Agent": "observatorio-indicadores/1.0 (+https://github.com/)"}


def get(url, timeout=120, reintentos=3, espera=2.0):
    """GET con reintentos. Las fuentes oficiales cortan de vez en cuando y una
    Action que muere por un timeout transitorio deja el panel sin actualizar."""
    ultimo = None
    for intento in range(reintentos):
        try:
            req = urllib.request.Request(url, headers=UA)
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read()
        except Exception as e:                                   # noqa: BLE001
            ultimo = e
            if intento < reintentos - 1:
                time.sleep(espera * (intento + 1))
    raise ultimo


def get_json(url):
    return json.loads(get(url).decode("utf-8"))


def num(x, defecto=None):
    """Número robusto. '<5' es el enmascarado por secreto estadístico: no es
    cero, es 'no publicado', así que devuelve el valor por defecto (None)."""
    s = (x or "").strip() if isinstance(x, str) else x
    if s is None or s == "":
        return defecto
    if isinstance(s, (int, float)):
        return s
    if s.startswith("<"):
        return defecto
    try:
        return int(s)
    except ValueError:
        pass
    try:
        return float(s.replace(".", "").replace(",", ".")) if "," in s else float(s)
    except ValueError:
        return defecto


def paso(titulo):
    print(f"\n> {titulo}")


def ok(msg):
    print(f"  [ok] {msg}")


def aviso(msg):
    print(f"  [!] {msg}")


def escribir_js(ruta, datos, variable="DATOS"):
    """Vuelca el diccionario como data/data.js.

    Un .js y no un .json a propósito: así el observatorio se abre con doble clic
    desde el disco, sin servidor y sin tropezar con CORS de file://.
    """
    os.makedirs(os.path.dirname(ruta), exist_ok=True)
    with io.open(ruta, "w", encoding="utf-8") as f:
        f.write("/* Generado por pipeline/build_data.py - no editar a mano. */\n")
        f.write(f"window.{variable} = ")
        json.dump(datos, f, ensure_ascii=False, separators=(",", ":"))
        f.write(";\n")
    kb = max(1, os.path.getsize(ruta) // 1024)
    ok(f"{ruta} ({kb} KB)")
