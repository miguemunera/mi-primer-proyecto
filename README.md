# Ruta a 3000

Juego de ajedrez contra Stockfish 19 (WASM, corre en tu navegador) con entrenador integrado.

## Cómo ejecutarlo

Necesita servirse por HTTP (los Web Workers no funcionan desde `file://`):

```bash
python3 -m http.server 8000
# abre http://localhost:8000
```

## Qué incluye

- Rival ajustable de ELO 1320 a 3190 (`UCI_Elo` de Stockfish) y modo máximo. Preajustes: 1500 → 3000.
- Feedback tras cada jugada tuya: mejor jugada / buena / imprecisión / error / error grave, con la razón
  (qué captura o mate permites) y cuál era la mejor.
- «Deshacer y reintentar» tras un error, y pistas en 3 niveles (tipo de pieza → casilla → jugada).
- Revisión al final: precisión, jugadas a revisar y consejos según tus errores.
- «Ruta a 3000»: guarda el mayor nivel que has vencido y sube/baja 100 ELO según el resultado.

## Limitaciones honestas

- El ELO es la escala de Stockfish (CCRL), **no** FIDE ni Lichess. Vencer al nivel 3000 no equivale a ser 3000 FIDE.
- La clasificación de jugadas usa un análisis a profundidad 14 con la versión «lite» del motor; es una guía, no un veredicto.
- Un juego no te hace 3000: sirve para practicar y detectar errores. Para mejorar de verdad combina partidas con tácticas, finales y repaso de tus derrotas.

## Licencias

`vendor/` incluye Stockfish 19 (GPL-3.0, ver `vendor/STOCKFISH-LICENSE-GPL3.txt`) y chess.js (BSD-2).
