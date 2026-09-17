#!/usr/bin/env python3
"""Испытуемый SkillAgent (репозиторий agent_oc) за контрактом Agent Lab `kind: "command"`.

Живёт здесь, а не в agent_oc: прод-репозиторий остаётся нетронутым, скрипт только читает его
через публичные точки `harness_core.bootstrap_environment` и `harness_core.run_turn`.

    python examples/agent-oc-adapter.py ../agent_oc < /dev/null

Так проверяется окружение: скрипт поднимает agent_oc, печатает замечания в stderr и выходит.

Окружение наследуется от вызывающего процесса (на рабочей машине — активированное conda-окружение
`agent_oc`), а `bootstrap_environment` дополняет его `.env` из корня репозитория, не перекрывая уже
заданные значения, и ставит `DEV_MODE=True`, пути логов и модель.

Протокол (docs/REFERENCE.md), по одной JSON-строке в каждую сторону:

    stdin  → {"type": "respond", "sessionId", "scenarioId", "initialState", "messages", "message"}
    stdout ← {"reply", "events", "records", "eventsComplete", "resetConfirmed", ...}
    stdin  → {"type": "close"}

Поверхность, полномочия и ЕПК приходят в `initialState.records.session`: схема мира Agent Lab
допускает произвольные скалярные поля записи, и это единственный способ передать карточке
контекст канала, которого в самом диалоге нет::

    "initialState": {"records": {"session": {"surface": "GIGAASSISTANT", "authority": "3",
                                             "epk_ul": "1901708997831302125", "epk_fl": "1901709191095505336"}},
                     "writableFields": [], "transientFailures": 0}

Обратно в `records.result` кладутся код ответа и его источник: по ним пишутся объективные
проверки (`state_equals` на `result.status_code`), не полагаясь на мнение судьи.
"""

from __future__ import annotations

import json
import sys
import traceback
from pathlib import Path
from typing import Any, Dict, List, Optional
from uuid import uuid4

# Прод и его библиотеки пишут в stdout; там же живёт протокол Agent Lab. Ответы уходят в
# перехваченный настоящий stdout, всё остальное — в stderr, где Agent Lab это и ожидает.
_PROTOCOL = sys.stdout
sys.stdout = sys.stderr

DEFAULT_SESSION = {"surface": "GIGAASSISTANT", "authority": "3", "epk_ul": 1, "epk_fl": 1, "branch": "B"}
VERSION = "agent-oc-command-adapter-1"
# Какие инструменты агента адаптер вообще умеет наблюдать. Без этой границы проверка
# «инструмент не вызывался» опиралась бы на молчание, а не на полный перечень.
EVENT_SCOPE = ["read", "execute_action"]


class Turn:
    """Один диалог: держит историю реплик и сессию агента между ходами, как это делает прод."""

    def __init__(self, harness: Any, config: Dict[str, Any]) -> None:
        from incass_ckr.new_agent_logic.session import InMemorySessionStorage

        self._harness = harness
        self._config = config
        self._storage = InMemorySessionStorage.get_instance(logger=lambda *_: None)
        self._work_id = str(uuid4())
        self._lines: List[str] = []

    def reply(self, message: str) -> Dict[str, Any]:
        import time

        self._lines.append(f"{self._harness.CLIENT_PREFIX} {message}")
        started = time.time()
        answer, metadata, trace = self._harness.run_turn(
            storage=self._storage,
            work_id=self._work_id,
            dialog_text="\n".join(self._lines),
            sender=self._config["surface"],
            authority=self._config["authority"],
            identity={"epk_id_fl": self._config["epk_fl"], "epk_id_ul": self._config["epk_ul"]},
            branch=self._config["branch"],
            inn=self._config.get("inn"),
            epk_ul_list=self._config.get("epk_ul_list"),
        )
        self._lines.append(f"{self._harness.OPERATOR_PREFIX} {answer}")
        return {
            "answer": answer,
            "status_code": str((metadata or {}).get("status_code")),
            "produced_by": trace.get("produced_by"),
            "actions": trace.get("actions") or [],
            "seconds": round(time.time() - started, 1),
        }


def load_harness(root: Path) -> Any:
    """Подключает agent_oc по его же правилам: sys.path, .env, DEV_MODE, пути логов."""
    tests = root / "src" / "tests"
    if not (tests / "harness_core.py").exists():
        raise SystemExit(f"Не похоже на репозиторий agent_oc: не найден {tests / 'harness_core.py'}")
    sys.path.insert(0, str(tests))

    import harness_core

    environment = harness_core.bootstrap_environment()
    if not environment["pprb_available"]:
        print("agent-oc-adapter: API_PPRB_URL_doc пуст — договоры и документы недоступны, "
              "маршрут будет измерен без данных", file=sys.stderr)
    return harness_core


def session_config(harness: Any, initial_state: Dict[str, Any]) -> Dict[str, Any]:
    """Читает настройки канала из записи `session` карточки; пустые поля берут значение по умолчанию."""
    record = (initial_state or {}).get("records", {}).get("session", {}) or {}
    config: Dict[str, Any] = dict(DEFAULT_SESSION)
    for key in ("surface", "authority", "branch"):
        if str(record.get(key, "")).strip():
            config[key] = str(record[key]).strip()
    for key in ("epk_ul", "epk_fl"):
        if str(record.get(key, "")).strip():
            config[key] = int(str(record[key]).strip())
    if str(record.get("inn", "")).strip():
        config["inn"] = str(record["inn"]).strip()
    if str(record.get("epk_ul_list", "")).strip():
        config["epk_ul_list"] = [int(item) for item in str(record["epk_ul_list"]).replace(" ", "").split(",") if item]

    if config["surface"] not in harness.SURFACES:
        raise ValueError(f"Неизвестная поверхность {config['surface']}; допустимы {', '.join(harness.SURFACES)}")
    if config["authority"] not in harness.AUTHORITIES:
        raise ValueError(f"Неизвестные полномочия {config['authority']}; допустимы {', '.join(harness.AUTHORITIES)}")
    return config


def as_events(actions: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Действия прод-трассы → события инструментов Agent Lab, по одному на действие."""
    events: List[Dict[str, Any]] = []
    for action in actions:
        tool = str(action.get("tool") or "unknown")
        if tool == "read":
            events.append({
                "tool": "read",
                "args": {"name": (action.get("args") or {}).get("name")},
                "result": {"gate_branch": action.get("gate_branch")},
            })
        elif tool == "execute_action":
            events.append({
                "tool": "execute_action",
                "args": {"action_id": action.get("action_id"), **(action.get("args") or {})},
                "result": {
                    "status": action.get("status"),
                    "situation": action.get("situation"),
                    "doc_count": action.get("doc_count"),
                    "use_as_final_answer": action.get("use_as_final_answer"),
                },
            })
        else:
            events.append({"tool": tool, "args": action.get("args")})
    return events[:50]


def scalar(value: Any) -> Any:
    """Запись мира Agent Lab принимает только скаляры; остальное показывается строкой."""
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    return json.dumps(value, ensure_ascii=False)[:8000]


def respond(turn: Turn, request: Dict[str, Any], index: int) -> Dict[str, Any]:
    result = turn.reply(request["message"])
    records = dict((request.get("initialState") or {}).get("records") or {})
    records["result"] = {
        "status_code": scalar(result["status_code"]),
        "produced_by": scalar(result["produced_by"]),
        "seconds": scalar(result["seconds"]),
    }
    return {
        "reply": result["answer"],
        "events": as_events(result["actions"]),
        "records": records,
        "eventsComplete": True,
        "eventScope": EVENT_SCOPE,
        "resetConfirmed": True,
        "version": VERSION,
        "turn": index,
    }


def main(argv: List[str]) -> int:
    if len(argv) != 2:
        print(__doc__, file=sys.stderr)
        return 2
    harness = load_harness(Path(argv[1]).expanduser().resolve())

    turn: Optional[Turn] = None
    index = 0
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except json.JSONDecodeError:
            # Писать сюда должен только Agent Lab. Человек, запускающий проверку руками, чаще всего
            # приносит строку с «ёлочками» вместо кавычек — traceback об этом ничего не говорит.
            print(f"agent-oc-adapter: строка не является JSON протокола: {line[:200]}", file=sys.stderr)
            return 2
        if request.get("type") == "close":
            break
        try:
            if turn is None:
                turn = Turn(harness, session_config(harness, request.get("initialState") or {}))
            index += 1
            reply = respond(turn, request, index)
        except Exception as error:  # noqa: BLE001 — сбой стенда должен стать measurementError, а не провалом агента
            traceback.print_exc(file=sys.stderr)
            reply = {"reply": "", "measurementError": f"{type(error).__name__}: {error}"[:2000], "version": VERSION}
        if request.get("sessionId"):
            reply["sessionId"] = request["sessionId"]
        _PROTOCOL.write(json.dumps(reply, ensure_ascii=False) + "\n")
        _PROTOCOL.flush()
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
