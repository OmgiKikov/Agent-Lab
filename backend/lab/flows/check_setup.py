"""One immutable set of criteria for direct recorded questions, without inventing a synthetic customer."""

from .. import storage
from ..domain import checks
from . import Progress, accuracy, inputs, tone


async def topics(check: str, dialogues: list[dict], progress: Progress) -> list[dict]:
    if check == checks.TONE:
        draft = storage.documents.load(tone.DRAFT)
        if not draft or not draft.get('criteria'):
            raise ValueError('Сначала сформируйте или выберите критерии Tone of voice.')
        return [
            {
                'id': 'tone',
                'title': checks.NAMES[check],
                'rules': draft['criteria'],
                'dialogueIds': [d['id'] for d in dialogues],
            }
        ]
    previous = storage.documents.load(checks.result(check)) or storage.documents.load(checks.CODE_CRITERIA) or {}
    sources = [s for s in inputs.sources() if s['kind'] != checks.TONE_OF_VOICE]
    if not sources:
        raise ValueError('Для точности выберите набор правил или прочитайте код агента.')
    planned = await accuracy.plan(previous, previous, sources, dialogues, progress, False)
    return planned['topics']
