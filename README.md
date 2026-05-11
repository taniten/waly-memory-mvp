# WALY Outlier Hunt v1

Sistema local, stateful y sin dependencias externas para detectar pocas apuestas de alta asimetria en equities. WALY usa memoria persistente, catalysts verificables, price action, volumen, insider support e ingesta social temprana como radar, pero nunca como sustituto de datos duros.

## Principio clave

- social = discovery
- data = conviction

WALY no compra narrativa sola. La capa social solo sirve para descubrir antes. La conviccion final siempre depende de catalyst, precio, volumen, liquidez y estructura.

## Dos playbooks, una disciplina

WALY puede convivir con dos juegos distintos sin confundirlos:

- `outlier`: pocas apuestas, mucha asimetria, paciencia, buscar reratings grandes
- `event-swing`: catalyst cercano, entrada tactica, objetivo frecuente de `+10%` a `+15%` en `5-30` dias

La regla es simple: no mezclar ambos loops. Si un setup no es `A+`, igual puede servir como `event-swing`, pero debe medirse como tal.

Advertencia ETFs:
`Los ETFs apalancados/inversos pueden resetear diariamente y no estan disenados como buy-and-hold. WALY los trata como instrumentos tacticos, no como tesis de inversion.`

## Que busca WALY

No intenta rankear “buenas ideas” en general. Busca pocas configuraciones con potencial de outlier real, idealmente con asimetria suficiente como para justificar una tesis x2+ si el catalyst y la estructura se alinean.

## Principios

- Local y simple
- Sin APIs obligatorias
- Con conectores opcionales que degradan a modo local si faltan credenciales
- Sin base de datos
- Sin frontend
- Sin automatizacion de ordenes
- Sin dependencias innecesarias
- Posiciones abiertas primero
- Maximo `0-3` oportunidades finales

## Estructura

```text
waly-memory-mvp/
  data/
    earnings.json
    insiders.json
    fda.json
    social_signals.json
    outcomes.json
    universe_candidates.json
    positions.json
    watchlist.json
    daily_log.json
    settings.json
    .gitkeep
  examples/
    positions.example.json
    watchlist.example.json
    daily_log.example.json
    settings.example.json
    nueva-revision.example.json
    nuevo-outcome.example.json
    social_signals.example.json
    outcomes.example.json
    earnings.example.json
    insiders.example.json
    fda.example.json
  ejemplos/
    nueva-revision.json
  reports/
    .gitkeep
  historical_prices/
    .gitkeep
  src/
    cli.js
    compareState.js
    connectors/
    constants.js
    decisionEngine.js
    eventEngine.js
    outcomeEngine.js
    rankingEngine.js
    reporter.js
    state.js
    storage.js
    universeEngine.js
    validators.js
  AGENTS.md
  README.md
  package.json
```

## Datos locales y privacidad

`data/` y `reports/` quedan fuera del versionado publico porque pueden contener posiciones reales, watchlists, configuraciones, catalysts y reportes operativos. `data/` es local, no se versiona y cada operador lo mantiene en su propia maquina. Los archivos de `examples/` son plantillas sanitizadas con tickers ficticios (`DEMO`, `TEST`, `FAKE`) para explicar la estructura sin exponer informacion sensible.

Si clonas el repo o queres arrancar desde cero, inicializa `data/` antes de correr WALY:

```bash
npm run init-data
```

Ese comando:

- crea `data/` si no existe
- copia `examples/*.example.json` hacia `data/*.json` solo cuando falta el archivo destino
- nunca sobrescribe archivos reales existentes
- muestra que archivos creo y cuales dejo intactos

Si preferis hacerlo a mano, tambien podes copiar las plantillas seguras hacia `data/`:

```bash
cp examples/positions.example.json data/positions.json
cp examples/watchlist.example.json data/watchlist.json
cp examples/daily_log.example.json data/daily_log.json
cp examples/settings.example.json data/settings.json
cp examples/social_signals.example.json data/social_signals.json
cp examples/outcomes.example.json data/outcomes.json
cp examples/earnings.example.json data/earnings.json
cp examples/insiders.example.json data/insiders.json
cp examples/fda.example.json data/fda.json
```

`data/universe_candidates.json` no es obligatorio para `state` o `report`; WALY lo genera cuando corres `node src/cli.js sync-universe`.

## Reglas de higiene operativa WALY

- `positions.json` solo contiene posiciones abiertas reales.
- `watchlist.json` solo contiene ideas vivas accionables.
- `outcomes.json` registra todo trade cerrado, incluso si fue chico.
- `daily_log.json` debe explicar altas y bajas relevantes del estado operativo.
- Feeds como `insiders`, `earnings`, `fda` y `social_signals` no deben arrastrar tickers viejos al estado activo.
- Si un ticker no tiene `catalystType` verificable, no puede clasificarse como `A+` WALY.
- Todo reset operativo debe hacerse con backup previo.
- `data/*.json` es memoria local privada y no debe versionarse.

## Uso rapido

```bash
node src/cli.js init-data
node src/cli.js state
node src/cli.js report
node src/cli.js backtest
node src/cli.js historical-backtest ./examples/historical-backtest-config.example.json
node src/cli.js sync-universe
node src/cli.js add-log ./examples/nueva-revision.example.json
node src/cli.js add-outcome ./examples/nuevo-outcome.example.json
node src/cli.js set-positions ./mi-positions.json
node src/cli.js set-watchlist ./mi-watchlist.json
```

Atajos disponibles via `npm run`:

```bash
npm run init-data
npm run state
npm run report
npm run backtest
npm run historical-backtest -- ./examples/historical-backtest-config.example.json
npm run sync-universe
npm run log -- ./examples/nueva-revision.example.json
npm run outcome -- ./examples/nuevo-outcome.example.json
npm run set-positions -- ./mi-positions.json
npm run set-watchlist -- ./mi-watchlist.json
```

En PowerShell puede convenir usar `node src/cli.js ...` si `npm.ps1` esta bloqueado por policy local.

## Capas del sistema

### Datos duros

- catalysts verificables
- precio y volumen
- liquidez
- downside claro
- rerating potential

### Discovery temprano

- señales en X
- Reddit
- foros
- Substack

La capa social puede sumar contexto y timing. Nunca define sola un `A+`.

## Scoring outlier

WALY rankea cada ticker usando estas variables conceptuales:

- `catalystStrength`
- `catalystWindow`
- `liquidityQuality`
- `momentumQuality`
- `breakoutReadiness`
- `reratingPotential`
- `insiderSupport`
- `socialDiscoveryScore`
- `crowdingRisk`
- `downsideClarity`

Reglas del ranking:

- `socialDiscoveryScore` puede sumar, pero no dominar
- `crowdingRisk` alto resta puntos
- sin catalyst verificable no hay `A+`
- sin liquidez real no hay `A+`
- si la estructura ya esta demasiado extendida, se penaliza
- `A+` queda reservado para setups con verdadera asimetria
- si no hay edge real, WALY devuelve `0`

Reglas extra para ETFs:

- Si `assetType="etf"`, `reratingPotential` deja de ser factor principal y WALY exige `underlyingConfirmation` para tratarlo como candidato tactico.
- ETFs apalancados o inversos nunca pueden ser `A+` WALY ni `outlier candidate`.
- ETFs de volatilidad, `single-stock leveraged ETFs`, `ETNs` o estructura `unknown` quedan en vigilancia manual salvo `manualOverride` explicito.
- Si un ETF apalancado/inverso no confirma `instrumentStructure="etf"`, WALY genera warning fuerte de revision manual.

## Esquema de datos

### `data/positions.json`

Cada posicion puede incluir:

- `ticker`
- `quantity`
- `avgPrice`
- `lastPrice`
- `priority`
- `status`
- `thesis`
- `conviction`
- `notes`
- `catalyst`
- `catalystType`
- `catalystDate`
- `invalidation`
- `source`
- `assetType`
- `etfCategory`
- `holdingRule`
- `maxHoldingDays`
- `maxPositionPct`
- `riskNote`
- `leverageFactor`
- `inverse`
- `instrumentStructure`
- `underlyingConfirmation`
- `manualOverride`
- `catalystStrength`
- `liquidityQuality`
- `momentumQuality`
- `breakoutReadiness`
- `reratingPotential`
- `insiderSupport`
- `socialDiscoveryScore`
- `crowdingRisk`
- `downsideClarity`
- `setupType`
- `setupRank`
- `socialSignals`

### `data/watchlist.json`

Cada ticker puede incluir el mismo set conceptual que posiciones, mas:

- `rationale`
- `catalystWindow`
- `nextReviewAt`

Campos ETF adicionales:

- `holdingRule`: `intraday-only` | `1-3d tactical` | `swing-short` | `hedge-temporal`
- `maxPositionPct`: numero opcional
- `instrumentStructure`: `etf` | `etn` | `etc` | `unknown`
- `underlyingConfirmation`: objeto opcional con `benchmark`, `trendConfirmed`, `macroCatalyst`, `invalidatesIf`
- `etfCategory`: por ejemplo `leveraged`, `inverse`, `leveraged-inverse`, `volatility`, `single-stock-leveraged`
- `maxHoldingDays`, `riskNote`, `leverageFactor`, `inverse`
- `manualOverride`: permite levantar vigilancia manual solo de forma explicita

### `data/social_signals.json`

Cada señal puede incluir:

- `ticker`
- `sourcePlatform`
- `sourceHandle`
- `signalType`
- `timestamp`
- `claim`
- `verificationStatus`
- `independenceScore`
- `crowdingRisk`
- `notes`

La idea de este archivo es muy simple:

- detectar discovery temprano
- medir crowding
- dejar trazabilidad de quien dijo que
- no transformar social en conviccion automatica

### `data/outcomes.json`

Cada outcome puede incluir:

- `ticker`
- `sourceKind`
- `playbookType`
- `loggedAt`
- `resolvedAt`
- `horizon`
- `setupType`
- `setupRankAtEntry`
- `assetType`
- `catalystType`
- `expectedMove`
- `resultPct`
- `entryPrice`
- `exitPrice`
- `peakPriceWithinWindow`
- `peakPriceWithin30d`
- `maxPostEntryReturnPct`
- `daysToPeak`
- `maxDrawdownPctBeforePeak`
- `return5d`
- `return10d`
- `return20d`
- `return30d`
- `hit7pct`
- `hit10pct`
- `hit15pct`
- `failedFast`
- `falsePositive`
- `outcomeLabel`
- `why`
- `lessons`
- `metadata`

Este archivo cierra el loop que mas importa:

- que ideas funcionaron
- cuales fallaron
- donde hubo setup real vs narrativa prolija
- que aprendizaje queda para recalibrar WALY
- si el playbook `event-swing` realmente captura movimientos repetibles de `10%` a `15%`

### `data/universe_candidates.json`

Es la salida local del discovery externo:

- junta candidatos desde market data y catalysts externos
- no reemplaza la watchlist real
- sirve como bandeja de entrada para ampliar universo
- mantiene el repo simple porque todo termina en JSON local

## Motores

### `src/eventEngine.js`

Construye el universo outlier:

- integra catalysts ingeridos
- integra señales sociales por ticker
- enriquece manualmente la watchlist y posiciones
- calcula factores conceptuales de asimetria
- detecta mismatches de catalyst
- deja social subordinado a la capa dura

### `src/rankingEngine.js`

Hace ranking por potencial de outlier:

- sube el peso de catalyst, liquidez, rerating y downside
- limita el impacto de social
- penaliza crowding e hipotesis extendidas
- solo deja `A+` cuando la asimetria parece real

### `src/decisionEngine.js`

Hace disciplina operativa:

- mantiene posiciones primero
- detecta hype sin confirmacion
- detecta crowding excesivo
- detecta catalyst debil
- detecta falta de downsideClarity
- devuelve una decision final brutal y clara

### `src/outcomeEngine.js`

Hace memoria de resultados:

- resume outcomes abiertos y resueltos
- separa funciono / fallo / mixto
- deja win rate y muestra util
- obliga a revisar por que una tesis funciono o no

### `src/universeEngine.js`

Hace universe seeding con APIs opcionales:

- usa Polygon para snapshot y earnings cuando hay API key
- usa SEC EDGAR para insider / Form 4 recientes
- usa openFDA para actividad FDA reciente
- acepta Finviz via URL configurable si tenes export/API disponible
- escribe candidatos locales en `data/universe_candidates.json`

## Reporte diario

`node src/cli.js report` genera un Markdown con:

- cartera actual
- watchlist prioritaria
- catalysts activos
- social signals relevantes
- crowding warnings
- top `0-3` outlier candidates
- outcome loop con ideas resueltas y abiertas
- checks de integridad
- cambios desde la ultima revision
- alertas y conflictos
- decision final brutal y clara

## Outcome Backtest Summary WALY 2.5

`node src/cli.js backtest` genera un Markdown separado en `backtests/` con foco en auditar outcomes ya registrados manualmente:

- no es simulacion ex-ante
- no genera senales historicas
- no consulta precios historicos reales
- no tiene checkpoint/resume para corridas largas
- sirve para resumir performance historica que ya fue cargada en `data/outcomes.json`

- corta la muestra por `5d`, `10d`, `20d` y `30d`
- resume `event-swing` y `outlier`
- separa `equity` vs `etf`, dejando ETFs tacticos estandar y apalancados/inversos como modulo aparte
- mide retorno maximo posterior, drawdown antes del pico, hit `+7%`, `+10%`, `+15%`, dias hasta pico y falso positivo
- muestra mezcla de `setupRankAtEntry`, `catalystType`, `playbookType` y `assetType`

Para que el backtest sea mas limpio, conviene cargar estos campos en cada outcome nuevo:

- `assetType`: `equity` o `etf`
- `catalystType`: `earnings`, `insider`, `fda`, `unusual-volume-gap`
- `maxPostEntryReturnPct`: mejor retorno alcanzado dentro de la ventana medida
- `peakPriceWithinWindow`: opcional si queres dejar trazabilidad de precio
- `hit7pct`, `hit10pct`, `hit15pct`
- `falsePositive`

Si queres auditar sin escribir archivos:

```bash
node src/cli.js backtest --dry-run
```

## Historical Signal Backtest MVP

`node src/cli.js historical-backtest <config-json>` crea un modulo separado del Outcome Summary y trabaja sobre senales historicas manuales ex-ante. La idea es probar infraestructura de medicion, checkpoint/resume y metricas auditables sin tocar `data/` ni mezclar este flujo con outcomes ya cargados.

La capa actual soporta dos providers:

- usa un archivo manual de senales historicas
- escribe solo dentro de `backtests/<runId>/`
- guarda `signals.json`, `summary.json`, `summary.md` y `checkpoint.json`
- `dataProvider="mock"` con trayectorias sinteticas deterministicas
- `dataProvider="local-csv"` con precios historicos desde CSV locales

Importante:

- el provider `mock` no usa precios historicos reales y no sirve para validar ventaja estadistica
- el provider `local-csv` si puede medir retornos reales si los CSV cargados contienen history historica real
- si `allowNetwork=false`, WALY no hace requests externos
- el objetivo actual es probar plumbing, audit trail, checkpoint/resume y calculo de metricas posteriores
- WALY todavia no descarga esos CSV automaticamente
- el backtest posterior igual requerira control cada vez mas estricto de look-ahead bias y calidad de datos

Ejemplo rapido:

```bash
node src/cli.js historical-backtest ./examples/historical-backtest-config.example.json
```

Archivos de ejemplo:

- `examples/historical-backtest-config.example.json`
- `examples/historical-signals.example.json`
- `examples/historical-prices/IPX.example.csv`
- `examples/historical-prices/AXSM.example.csv`

## Historical Price Provider `local-csv`

Si queres medir retornos historicos con precios locales, prepara archivos en:

```text
historical_prices/TICKER.csv
```

Columnas requeridas:

- `date`
- `open`
- `high`
- `low`
- `close`
- `volume`

Reglas de uso:

- WALY ordena el CSV por `date` ascendente
- si no existe fila exacta para `signalDate`, usa el primer `close` disponible posterior
- los horizontes `5/10/20/30d` usan ruedas de trading disponibles, no calendario
- los CSV viven solo localmente y `historical_prices/*.csv` queda ignorado por Git
- esto si permite medir retornos reales si el contenido del CSV es historico real
- WALY todavia no descarga history automaticamente ni usa APIs en esta fase

## Sync de universo

`node src/cli.js sync-universe` corre una capa de discovery externa y deja todo local:

- market snapshot y liquidez desde Polygon
- earnings futuros desde Polygon Benzinga Earnings
- insider catalysts desde SEC EDGAR
- actividad FDA reciente desde openFDA
- import opcional desde Finviz si configuraste una URL de export/API

El resultado se guarda en `data/universe_candidates.json`.
Si hay datos validos, WALY tambien actualiza `data/earnings.json`, `data/insiders.json` y `data/fda.json` sin agregar dependencias.

## Variables de entorno

Para correr conectores reales:

- `POLYGON_API_KEY`
- `SEC_USER_AGENT`
- `OPENFDA_API_KEY` opcional
- `FINVIZ_SCREENER_URL` opcional
- `FINVIZ_API_TOKEN` opcional

Notas:

- Las API keys y tokens deben vivir en variables de entorno. No los guardes dentro de `data/*.json`, `examples/*.json` ni commits locales.
- SEC y openFDA pueden funcionar sin key, pero SEC requiere un `User-Agent` identificable.
- Finviz queda como conector configurable porque la URL exacta depende de tu acceso/export oficial.
- Si faltan credenciales, WALY no rompe: marca el provider como no disponible y sigue local.

## Flujo sugerido

1. Actualizar `data/positions.json`.
2. Actualizar `data/watchlist.json`.
3. Actualizar `data/earnings.json`, `data/insiders.json` y `data/fda.json`.
4. Registrar nuevas señales en `data/social_signals.json`.
5. Actualizar `data/outcomes.json` cuando una tesis se resuelve o sigue abierta.
   Tip: podes cargar un outcome nuevo con `node src/cli.js add-outcome <ruta-json>`.
6. Correr `node src/cli.js sync-universe` para ampliar discovery externo.
7. Revisar `data/universe_candidates.json` y promover solo lo que merezca entrar a watchlist.
8. Correr `node src/cli.js state`.
9. Generar el reporte con `node src/cli.js report`.
10. Solo promover a oportunidad final lo que sobreviva a catalyst, liquidez, estructura y downside.
