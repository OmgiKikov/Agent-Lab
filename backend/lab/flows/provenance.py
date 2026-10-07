"""The inputs a result actually used, kept with the result rather than read from today's UI selection."""

from .. import storage
from ..domain import judges
from ..domain.comparison import comparison, fingerprint
from . import agent_context


def snapshot(check: str) -> dict:
    dataset = storage.dialogues.meta()
    selected = storage.judges.active(check)
    task_id = storage.tasks.current_id()
    task = storage.tasks.get(task_id) if task_id else None
    given = (task or {}).get('input', {})
    context = agent_context.current()
    return {
        **({'agentContext': context} if any(context.values()) else {}),
        **({'dataset': dataset} if dataset.get('datasetId') else {}),
        **(
            {'judge': {key: selected[key] for key in ('id', 'setId', 'name', 'version', 'policy', 'criteria')}}
            if selected
            else {}
        ),
        **({'agentVersion': given['agentVersion']} if given.get('agentVersion') else {}),
    }


def attach(result: dict, record: dict, check: str) -> None:
    """The inputs a check used, kept with its result and its record in the history. The record's line in the list of
    saved checks (record['check']) names the rules by their set and version; their text and the agent's context stay in
    the result."""
    meta = snapshot(check)
    result.update(meta)
    record['check'].update({key: value for key, value in meta.items() if key != 'agentContext'})
    if 'judge' in meta:
        record['check']['judge'] = judges.brief(meta['judge'])
    record['result'].update(meta)
    context = meta.get('agentContext') or {}
    if check == 'code' and (context.get('tools') or context.get('idpIndex')):
        basis = {key: context.get(key) for key in ('idpUrl', 'idpIndex', 'idpEmbedder', 'idpFilter')}
        basis['tools'] = sorted(context.get('tools') or [])
        record['check']['evaluationFingerprint'] = fingerprint(
            {
                'judge': record['check']['evaluationFingerprint'],
                'context': basis,
            }
        )
    if check == 'code' and context.get('idpIndex'):
        evidence = [
            (str(row['dialogueId']), sorted((a['article'], a['text']) for a in row.get('knowledge') or []))
            for row in result['results']
        ]
        record['check']['knowledgeFingerprint'] = fingerprint(sorted(evidence))
    record['check']['comparison'] = comparison(record['check'], storage.history.latest(check))
