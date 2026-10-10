"""The kinds of the errors one criterion found: the judge names every error in its own words, so one mistake comes under
many names; the model groups the names by the mistake. A reading of the judge's verdicts, never a verdict: what the
judge found and how often stays as it is."""

from pydantic import BaseModel, ConfigDict

from .base import Answer, NonBlank, Role, ask, instructions

KINDS_AT_MOST = 6
NAME_AT_MOST = 120  # characters of a kind's name: the instructions ask for 60, a little more is still a name


class Kind(BaseModel):
    model_config = ConfigDict(strict=True)

    name: NonBlank
    titles: list[int]


class Kinds(BaseModel):
    model_config = ConfigDict(strict=True)

    kinds: list[Kind]


KINDS = Role('tone.kinds', instructions('tone.kinds'), Kinds)


async def grouped(criterion: dict, names: list[tuple[str, int]]) -> Answer[list[dict]]:
    """[{name, titles}]: the names of the criterion's errors (with how many errors bear each) grouped by the mistake,
    each name in one kind at most, the kinds as the model ordered them. A name the model left out belongs to no kind."""
    payload = {
        'criterion': {'name': criterion.get('name') or '', 'text': criterion['text']},
        'titles': [{'n': n, 'title': title, 'errors': errors} for n, (title, errors) in enumerate(names, 1)],
    }

    def usable(reply: Kinds) -> list[dict]:
        if not 1 <= len(reply.kinds) <= KINDS_AT_MOST:
            raise ValueError(f'expected 1..{KINDS_AT_MOST} kinds')
        numbered = set(range(1, len(names) + 1))
        taken: set[int] = set()
        kinds = []
        for kind in reply.kinds:
            name = kind.name.strip()
            numbers = set(kind.titles)
            if len(name) > NAME_AT_MOST or not numbers:
                raise ValueError('a kind needs a short name and its titles')
            if len(numbers) < len(kind.titles) or numbers & taken or not numbers <= numbered:
                raise ValueError('every title goes into one kind at most')
            taken |= numbers
            kinds.append({'name': name, 'titles': [names[n - 1][0] for n in kind.titles]})
        return kinds

    return await ask(KINDS, payload, accept=usable)
