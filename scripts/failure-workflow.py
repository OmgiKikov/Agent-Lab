#!/usr/bin/env python3
"""Move grounded log findings through a human review into LangWatch scenarios.

`prepare` writes a LangWatch dataset import. Its rows are judge suggestions,
never confirmed failures. A reviewer changes owner_decision to confirmed or
disputed in LangWatch and may edit the proposed situation and criterion.
`promote` creates a scenario only from confirmed rows; it never runs the bot.
"""

import argparse
import hashlib
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import unquote, urlparse


ROOT = Path(__file__).resolve().parent.parent


def json_lines(path: Path) -> list[dict]:
    with path.open(encoding="utf-8") as source:
        return [json.loads(line) for line in source if line.strip()]


def relevant_turns(dialogue: dict, finding: dict) -> tuple[list[str], str]:
    events = dialogue["events"]
    cited = {item["seq"] for item in finding.get("evidence", [])}
    answers = [event for event in events if event.get("type") == "message" and event.get("role") == "assistant"]
    answer = next((event for event in answers if event["index"] in cited), answers[-1] if answers else None)
    before = answer["index"] if answer else float("inf")
    questions = [event for event in events if event.get("type") == "message" and event.get("role") == "user" and event["index"] < before]
    customer = list(dict.fromkeys(event.get("content", "").strip() for event in questions if event.get("content", "").strip()))
    return customer, answer.get("content", "") if answer else ""


def prepare(args: argparse.Namespace) -> None:
    analysis = json.loads(args.analysis.read_text(encoding="utf-8"))
    batch_path = args.analysis.parent.parent / "imports" / f"{analysis['logs']['importId']}.json"
    batch = json.loads(batch_path.read_text(encoding="utf-8"))
    if batch["contentHash"] != analysis["logs"]["contentHash"]:
        raise SystemExit("The analysis and its import do not match; no review rows written")
    imported = {row["dialogue_id"]: row for row in json_lines(args.dialogues)}
    dialogues = {item["id"]: item for item in batch["dialogues"]}
    scenarios = {item["id"]: item for item in analysis["scenarios"]}
    requirements = {item["id"]: item for item in analysis["requirements"]}
    sources = {item["id"]: item for item in analysis["sources"]}
    reviews = {item["key"]: item["verdict"] for item in analysis["reviews"]}
    needle = args.rule_contains.casefold()
    rows = []
    seen = set()
    for finding in analysis["findings"]:
        if finding["result"] != "fail" or not finding["complete"] or reviews.get(finding["key"]) == "disputed":
            continue
        scenario = scenarios.get(finding["scenarioId"])
        expectation = next((item for item in scenario["expectations"] if item["id"] == finding["expectationId"]), None) if scenario else None
        if not expectation:
            continue
        rule = next((requirements.get(id) for id in expectation["requirementIds"]
                     if requirements.get(id, {}).get("kind") == "behavior" and needle in requirements[id]["quote"].casefold()), None)
        dialogue_id = finding["dialogueId"]
        if not rule or dialogue_id in seen:
            continue
        if dialogue_id not in imported or dialogue_id not in dialogues:
            raise SystemExit(f"Conversation {dialogue_id} is missing from a source; no review rows written")
        seen.add(dialogue_id)
        original = imported[dialogue_id]
        questions, answer = relevant_turns(dialogues[dialogue_id], finding)
        opening = questions[0] if questions else ""
        follow_up = questions[-1] if len(questions) > 1 else ""
        candidate_id = hashlib.sha256(f"{analysis['id']}:{dialogue_id}:{rule['id']}".encode()).hexdigest()[:16]
        # The spreadsheet's short summary can name a different product; the
        # plan's topic is the one this finding was actually judged under.
        title = scenario["topic"]
        rows.append({
            "candidate_id": candidate_id,
            "pattern": args.pattern,
            "problem": expectation.get("violation") or expectation["text"],
            "dialogue_id": dialogue_id,
            "customer_message": " → ".join(questions[:1] + ([follow_up] if follow_up else [])),
            "agent_reply": answer,
            "conversation": original["conversation"],
            "rule_quote": rule["quote"],
            "rule_source": sources[rule["sourceId"]]["name"],
            "judge_reason": finding.get("rationale", ""),
            "owner_decision": "needs_review",
            "owner_reason": "",
            "scenario_name": f"{args.pattern}: {title} [{candidate_id[:8]}]"[:180],
            "draft_situation": f"Клиент обращается по теме «{title}». Он начинает: «{opening[:350]}»."
            + (f" На уточняющий вопрос клиент может ответить: «{follow_up[:200]}»." if follow_up else "")
            + " Продолжайте разговор естественно; не подсказывайте агенту правило проверки.",
            "draft_criterion": rule["quote"],
            "analysis_id": analysis["id"],
            "finding_key": finding["key"],
            "source": "Agent Lab DISCOVER archive — unconfirmed judge finding",
        })
        if len(rows) >= args.limit:
            break
    if not rows:
        raise SystemExit("No complete findings matched this behavior rule")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("w", encoding="utf-8") as target:
        for row in rows:
            target.write(json.dumps(row, ensure_ascii=False) + "\n")
    args.output.chmod(0o600)
    print(f"Prepared {len(rows)} review candidates in {args.output}. All require owner review.")


def reviewed_rows(args: argparse.Namespace) -> list[dict]:
    if args.input:
        return json_lines(args.input)
    if not args.dataset:
        raise SystemExit("Specify --dataset in LangWatch or --input for a local review file")
    env = {**os.environ, "LANGWATCH_ENDPOINT": args.endpoint, "LANGWATCH_API_KEY": project_api_key(args)}
    result = subprocess.run([str(args.cli), "dataset", "download", args.dataset, "-f", "jsonl"],
                            env=env, text=True, capture_output=True, timeout=60, check=False)
    if result.returncode:
        raise SystemExit(f"Cannot read review dataset: {result.stderr[:300]}")
    return [json.loads(line) for line in result.stdout.splitlines() if line.strip()]


def project_api_key(args: argparse.Namespace) -> str:
    """Use an explicit key, or the current user's local LangWatch project key without printing it."""
    if os.environ.get("LANGWATCH_API_KEY"):
        return os.environ["LANGWATCH_API_KEY"]
    if args.endpoint.rstrip("/") not in {"http://localhost:5560", "http://127.0.0.1:5560"}:
        raise SystemExit("Set LANGWATCH_API_KEY for a non-local LangWatch endpoint")
    env_file = ROOT / "langwatch/.local/.env"
    if not env_file.exists():
        raise SystemExit("Set LANGWATCH_API_KEY; no local LangWatch database configuration was found")
    database = next((line.split("=", 1)[1].strip('"') for line in env_file.read_text().splitlines() if line.startswith("DATABASE_URL=")), None)
    if not database:
        raise SystemExit("Set LANGWATCH_API_KEY; the local database is not configured")
    parsed = urlparse(database)
    environment = {**os.environ, "PGHOST": parsed.hostname or "localhost", "PGPORT": str(parsed.port or 5432),
                   "PGUSER": parsed.username or "", "PGPASSWORD": unquote(parsed.password or ""), "PGDATABASE": parsed.path.lstrip("/")}
    slug = args.project_slug.replace("'", "''")
    query = f'SELECT "apiKey" FROM langwatch_db."Project" WHERE slug = \'{slug}\' LIMIT 1'
    result = subprocess.run(["psql", "-Atc", query], env=environment, text=True, capture_output=True, timeout=15, check=False)
    if result.returncode or not result.stdout.strip():
        raise SystemExit("Set LANGWATCH_API_KEY; the local project key could not be read")
    return result.stdout.strip()


def promote(args: argparse.Namespace) -> None:
    rows = reviewed_rows(args)
    decisions = {"needs_review", "confirmed", "disputed"}
    if any(row.get("owner_decision") not in decisions for row in rows):
        raise SystemExit("Every owner_decision must be needs_review, confirmed or disputed")
    confirmed = [row for row in rows if row["owner_decision"] == "confirmed"]
    for row in confirmed:
        for field in ("candidate_id", "dialogue_id", "finding_key", "scenario_name", "draft_situation", "draft_criterion", "owner_reason"):
            if not str(row.get(field, "")).strip():
                raise SystemExit(f"Confirmed candidate {row.get('candidate_id')} needs {field}; no scenarios created")
    print(f"Review: {len(rows)} candidates, {len(confirmed)} confirmed, {sum(row['owner_decision'] == 'disputed' for row in rows)} disputed.")
    if args.dry_run or not confirmed:
        for row in confirmed:
            print(f"Would create: {row['scenario_name']} from conversation {row['dialogue_id']}")
        return
    key = project_api_key(args)
    headers = {"X-Auth-Token": key, "Content-Type": "application/json"}
    with urllib.request.urlopen(urllib.request.Request(args.endpoint + "/api/scenarios", headers=headers), timeout=30) as response:
        existing = json.load(response)
    listed = existing if isinstance(existing, list) else existing.get("data", [])
    known = {item["name"]: item["id"] for item in listed if isinstance(item, dict)}
    for row in confirmed:
        name = row["scenario_name"]
        if name in known:
            print(f"Already exists: {name} ({known[name]})")
            continue
        situation = row["draft_situation"].strip() + f"\n\nИсточник: разговор {row['dialogue_id']}, находка {row['finding_key'][:12]}."
        body = json.dumps({"name": name, "situation": situation, "criteria": [row["draft_criterion"].strip()],
                           "labels": ["from-real-logs", "owner-confirmed", f"candidate-{row['candidate_id']}"]}, ensure_ascii=False).encode()
        request = urllib.request.Request(args.endpoint + "/api/scenarios", data=body, headers=headers, method="POST")
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                scenario = json.load(response)
        except urllib.error.HTTPError as error:
            raise SystemExit(f"Scenario creation failed for {row['candidate_id']}: HTTP {error.code} {error.read().decode()[:250]}")
        print(f"Created: {name} ({scenario['id']}) {scenario.get('platformUrl', '')}")
        known[name] = scenario["id"]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    source = commands.add_parser("prepare", help="Prepare unconfirmed findings for a LangWatch review dataset")
    source.add_argument("--analysis", type=Path, required=True)
    source.add_argument("--dialogues", type=Path, required=True, help="Exact imported LangWatch JSONL conversations")
    source.add_argument("--rule-contains", required=True, help="Distinctive verbatim words of one behavior rule")
    source.add_argument("--pattern", required=True, help="Short failure pattern title shown to the reviewer")
    source.add_argument("--output", type=Path, required=True)
    source.add_argument("--limit", type=int, default=12)
    source.set_defaults(run=prepare)
    promotion = commands.add_parser("promote", help="Create scenarios only for owner-confirmed review rows")
    promotion.add_argument("--dataset", help="LangWatch review dataset id or slug")
    promotion.add_argument("--input", type=Path, help="Local JSONL review file, for preview")
    promotion.add_argument("--endpoint", default="http://localhost:5560")
    promotion.add_argument("--cli", type=Path, default=ROOT / "langwatch/.local/bin/langwatch")
    promotion.add_argument("--project-slug", default="local-dev-project-se7hbx", help="Local project for the key fallback")
    promotion.add_argument("--dry-run", action="store_true")
    promotion.set_defaults(run=promote)
    args = parser.parse_args()
    args.run(args)


if __name__ == "__main__":
    main()
