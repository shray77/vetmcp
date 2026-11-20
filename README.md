# VetMCP — ветеринарная экосистема как MCP-сервер

Model Context Protocol-сервер: живые данные витрин экосистемы shray77 для ИИ-агентов
(Claude Desktop, Cursor, Cline и любые MCP-клиенты). Ноль зависимостей — Node ≥ 20,
единый файл `vetmcp.mjs`, гейт 20 known-answer в CI.

## Первый ветеринарный MCP-сервер в РФ

Проверено 20.11.2026. В русскоязычных каталогах MCP-серверов ветеринарии нет:
mcpgate.ru (Союзтелеком, ~130 серверов, 14 бизнес-ролей) и mcp-catalog.ru (Atomno,
3176 серверов, 27 категорий) — ноль ветеринарных записей и самой категории;
полнотекстовый поиск ветеринаpных MCP-серверов на русском тоже пуст. В мире
ветеринарные MCP существуют (интеграции ezyVet, Pet Care AI) — поэтому статус
сформулирован точно: **первый в России**, а не «в мире». Даты фиксируют листинги
ниже и веб-архив; если найдётся более ранний российский ветеринарный MCP —
статус будет переформулирован, это условие честности.

## Листинги

- **Официальный реестр MCP** — `io.github.shray77/vetmcp`: MCPB-бандл
  `vetmcp.mcpb` ассетом релиза v1.1.0, публикация из CI по OIDC
  (`.github/workflows/publish-mcp.yml`, без токенов в репо).
  [Запись в реестре (API)](https://registry.modelcontextprotocol.io/v0.1/servers/io.github.shray77%2Fvetmcp/versions/1.1.0).
- **awesome-mcp-servers** — категория Biology, Medicine and Bioinformatics
  ([PR №20138](https://github.com/punkpeye/awesome-mcp-servers/pull/20138)).
- **mcpgate.ru** и **mcp-catalog.ru** — заявки в русскоязычные каталоги
  (у обоих сабмит только через поддержку).

## Инструменты (10)

| Инструмент | Что даёт | Источник (обновление) |
|---|---|---|
| `vet_weather_now` | Погода и тепловая нагрузка КРС: 49 станций Ростовской обл. — THI/THIadj, ветер, осадки, BRD-риск; сводка области или детально по станции | ВетРадар-61, срез ~каждые 20 мин |
| `vet_weather_forecast` | Почасовой прогноз 48 ч по станции: THI/THIadj/осадки/ветер + окна тепловой нагрузки THI>72 | ВетРадар-61 |
| `vet_weather_ensemble` | Вероятностный прогноз 7 дней: ДВА ансамбля ECMWF — физический IFS и ИИ-модель AIFS (по 50 членов): p10/p50/p90 THImax, P(THImax>72/80), расхождение медиан | ВетРадар-61, раз в 3 ч |
| `vet_forecast_quality` | Ретро-проверка прогнозов: бэктест модели vs ERA5 (слой А), бэктест AIFS (слой А2), собственные выпуски 48 ч по горизонтам (слой Б) | ВетРадар-61, раз в 12 ч |
| `vet_flu_windows` | Окна риска заноса ВПГП в РФ: уровень тревоги, пороги, топ регионов-узлов по вероятности | VetFlu, ежедневно |
| `vet_outbreaks_russia` | Сигналы отзывов и вспышек РФ: неблагонадёжные партии, карантинные мероприятия, регионы, фильтр по словам | ВетОтзывы, ежедневно |
| `vet_biothreats` | Мировые биоугрозы: карантинные болезни животных с ИИ-сводками, уровнем, дистанцией от РО; фильтры по болезни/стране | БиоУгрозы мира, ежедневно |
| `vet_digest` | Дайджест ветеринарной науки: свежие публикации с извлечённой пользой (impact/takeaways) и DOI, фильтр по словам | ВетДайджест, ежедневно |
| `vet_epimap` | Эпидкарта вспышек карантинных болезней животных РФ 2005→сегодня (WAHIS+ФСВПС: бешенство, лейкоз, бруцеллёз, АЧС, ящур и др.): сводка по стране или выборка — фильтры по болезни/региону/округу/статусу/дате | ВетКарта, 4 раза в сутки |
| `vet_drug_reference` | Справочник ветпрепаратов: свойства 180+ молекул из среза ChEMBL (MW, logP, PSA, нарушения Липинского, фаза, механизмы) и предсказанные аффинности Boltz-2 для пар препарат–мишень (IC50, ΔG, confidence) | VetInSilico (ChEMBL — еженедельно, Boltz-2 — по прогонам) |

Все инструменты возвращают JSON-текст; ошибки — `isError` с понятным сообщением
(например, «станция не найдена»), агент продолжает работу.

## Подключение

**Один клик (.mcpb)** — скачайте `vetmcp.mcpb` с
[релиза v1.1.0](https://github.com/shray77/vetmcp/releases/tag/v1.1.0) и откройте
файл — Claude Desktop установит расширение сам (Settings → Extensions). Нужен
установленный Node ≥ 20.

**Из клона** — Claude Desktop (`claude_desktop_config.json` → `mcpServers`):

```json
{
  "mcpServers": {
    "vetmcp": {
      "command": "node",
      "args": ["/полный/путь/к/vetmcp.mjs"]
    }
  }
}
```

**Cursor / Cline** (`.cursor/mcp.json` / `cline_mcp_settings.json`, тот же блок).

После перезапуска клиента спросите, например:
- «Какой THI сейчас на Ростове и есть ли станции в стрессе?»
- «Вероятность THImax>72 на неделе по Сальску по обоим ансамблям?»
- «Свежие мировые биоугрозы по африканской чуме свиней»
- «Сколько вспышек бешенства в ДФО за 2026 год и где свежие?»
- «Карточка римантадина: свойства и предсказанное сродство к M2 гриппа»

## Как это работает

- Транспорт: stdio, newline-delimited JSON-RPC 2.0 (транспорт MCP); версии протокола
  2024-11-05 / 2025-03-26 / 2025-06-18.
- Данные: открытые JSON-каналы `raw.githubusercontent.com` витрин; в памяти сервера —
  кэш TTL 5 мин, таймаут запроса 15 с; на один источник — один запрос в окне кэша.
- Сервер только читает публичные данные: ничего не пишет наружу и не пересылает
  ввод пользователя.

## Гейты и качество

`node --test tests/vetmcp.test.mjs` — 20 проверок: кэш (TTL/404), валидаторы,
JSON-RPC-слой (initialize/ping/notifications/−32601/−32602), все 10 инструментов на
фикстурах реальной формы данных (окна THI, веера, фильтры эпикарты и справочника,
честные ошибки), смоук реестра источников. CI гоняет гейт на каждый пуш.

## Источники данных

Витрины обновляются CI-ботами экосистемы: [ВетРадар-61](https://shray77.github.io/vet-meteo/)
· [VetFlu](https://shray77.github.io/vetflu-site/) · [ВетОтзывы](https://shray77.github.io/vetrecall-site/)
· [БиоУгрозы мира](https://shray77.github.io/biothreat-site/) · [ВетДайджест](https://shray77.github.io/vetdigest-site/)
· [ВетКарта](https://shray77.github.io/vet-heatmap/) · [VetInSilico](https://shray77.github.io/vet-insilico/).
Данные «как есть», не ветеринарная консультация; первоисточники — на витринах.

Лицензия MIT. Сборка: ИИ-агент экосистемы (Tasks 250, 252 — v1.1.0: эпикарта и
справочник препаратов; Task 254 — реестр MCP, MCPB-бандл, листинги), гейты зелёные.

## English (for aggregators)

**VetMCP** — the first veterinary MCP server in Russia. 10 tools on live data
from the open shray77 ecosystem: livestock heat stress (THI/THIadj, 49 stations of
the Rostov region), 48 h forecasts, probabilistic 7-day fans from two ECMWF
ensembles (physical IFS + AI model AIFS, 50 members each), avian influenza risk
windows, world bioterror watch, animal disease outbreak surveillance in Russia
2005→today (WAHIS+FSVPS), veterinary science digest, and a veterinary drug
reference (ChEMBL properties + Boltz-2 predicted affinities). Zero dependencies,
single `vetmcp.mjs`, Node ≥ 20, stdio transport, read-only public data. Tool
descriptions are in Russian. MIT license.
