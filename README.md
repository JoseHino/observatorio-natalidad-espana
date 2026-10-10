# Observatorio de la natalidad en España

Mapa de calor mes × año de la natalidad desde 1941, serie anual desde 1858 y
aviso de mínimos históricos. Montado sobre `observatorio-kit` (`assets/` no se toca).

## Datos (INE · Tempus3, total nacional)

| Serie | Periodo | Qué es |
|---|---|---|
| `MNP17521` | 1941-1974 | MNP histórico, nacimientos por lugar de inscripción |
| `MNP17451` | 1975-último definitivo | MNP, por residencia de la madre |
| `EMN39` | 2013-hace ~2 meses | Estimación Mensual de Nacimientos (coincide con el MNP donde hay definitivo) |
| `ECP320` | 1971-hoy | Población trimestral, para las tasas |
| `pipeline/historico_anual.csv` | 1858-1975 | Anual: anuarios INE + Carreras y Tafunell |

Antes de 1941 no hay serie mensual sin registro. La Human Mortality Database la
tiene (registro gratuito); si se consigue, se añade al colector.

## Cómo se actualiza

- **En vivo:** al abrirse, la página pide `EMN39?nult=12` al INE (CORS abierto) y
  añade los meses que falten en `data/data.js`.
- **Action** (lunes y jueves): `python pipeline/build_data.py` reescribe
  `data/data.js`. Si aparece un mínimo histórico nuevo, abre una *issue* en el
  repositorio, que llega por correo.

## Alarmas (misma lógica en `app.js` y en `build_data.py`)

- Último mes = mes más bajo desde 1941 (tasa anualizada y nacimientos por día).
- Último mes = el más bajo de ese mes del calendario.
- Último año completo = año más bajo desde 1858 (tasa y nacimientos).
- Acumulado enero-mes del año en curso = el más bajo desde 1941.

Cada récord se muestra junto al que batió: marco continuo y marco discontinuo en el mapa.
