"""Agent Lab's HTTP commands, a router per section of the product. A handler checks its input and calls a process
(flows/); long work goes to the owner of the agent's work (base.jobs_of), which gives it progress and a stop.

- state: what every screen polls, and stopping the task;
- agents: the agents the Lab checks;
- agent: the agent under test: how it is reached, its code and knowledge;
- settings: the models;
- exports: the exports of real conversations, each upload one;
- logs: one conversation of an export with its evaluation;
- checks: Точность, a check's result, problems, «было → стало», the history of checks;
- tone: tone of voice: the rules, their criteria, the check, suggestions;
- severity: serious and minor errors;
- scenarios: the deck of scenarios;
- runs: runs of the scenarios against the agent;
- replays: the live agent on the same customers;
- reviews: a person's answer on a verdict.
"""

from fastapi import APIRouter

from . import agent, agents, checks, exports, logs, replays, reviews, runs, scenarios, settings, severity, state, tone

router = APIRouter()
for section in (
    state,
    agents,
    agent,
    settings,
    exports,
    logs,
    checks,
    tone,
    severity,
    scenarios,
    runs,
    replays,
    reviews,
):
    router.include_router(section.router)
