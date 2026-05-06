# AGENTS.md

Reglas persistentes para cualquier agente o script que opere sobre `waly-memory-mvp`.

## Objetivo del sistema

Mantener memoria local, legible y persistente para WALY Outlier Hunt v1. Este proyecto no ejecuta ordenes ni automatiza trading; solo organiza contexto, catalysts, price action, crowding y decision.

## Principio clave

- social = discovery
- data = conviction

La capa social nunca debe dominar la decision final.

## Reglas obligatorias

1. Revisar primero `data/settings.json` y `data/positions.json` antes de evaluar la watchlist.
2. Nunca omitir posiciones abiertas en un reporte, estado o revision.
3. No reemplazar una thesis previa sin justificacion explicita en el log diario.
4. Mantener la watchlist viva, pero siempre subordinada a la cartera abierta.
5. Limitar a 3 las entradas en `newOpportunities` por revision.
6. Limitar a 0-3 las oportunidades finales del ranking diario.
7. Para estado operativo usar solo estas etiquetas:
   - `mantener`
   - `observar`
   - `descartar`
   - `nueva oportunidad`
8. Para ranking usar solo estas etiquetas:
   - `A+`
   - `A`
   - `B`
   - `descartar`
9. Si no hay catalyst verificable, no puede haber `A+`.
10. Si no hay liquidez real, no puede haber `A+`.
11. Si el crowding es alto o la estructura esta demasiado extendida, debe penalizarse.
12. Toda decision final debe quedar escrita en lenguaje claro, accionable y sin maquillaje.
13. El sistema debe seguir siendo local, simple y sin dependencias innecesarias.

## Catalyst types permitidos

- `earnings`
- `insider`
- `fda`
- `unusual-volume-gap`

## Prioridad de lectura

1. `data/settings.json`
2. `data/positions.json`
3. `data/watchlist.json`
4. `data/daily_log.json`
5. `data/social_signals.json`

## Criterios de salida

Todo reporte diario debe incluir:

- cartera actual
- watchlist prioritaria
- catalysts activos
- social signals relevantes
- crowding warnings
- top 0-3 outlier candidates
- decision final brutal y clara
