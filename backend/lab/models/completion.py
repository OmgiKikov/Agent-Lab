"""What one try of a model gave: its text, the model that answered, and what it cost when the model says so."""

from dataclasses import dataclass


@dataclass(frozen=True)
class Completion:
    text: str
    model: str
    input_tokens: int | None = None
    output_tokens: int | None = None
    cost: float | None = None


def usage(data: object) -> dict:
    """The tokens and the cost an answer names in its `usage` (OpenAI's names or the gateway's), whatever is a number;
    an answer that names none costs nothing to read."""
    found = data.get('usage') if isinstance(data, dict) else None
    if not isinstance(found, dict):
        return {}

    def number(*names: str) -> float | None:
        for name in names:
            value = found.get(name)
            if isinstance(value, int | float) and not isinstance(value, bool):
                return value
        return None

    tokens = {
        'input_tokens': number('prompt_tokens', 'input_tokens'),
        'output_tokens': number('completion_tokens', 'output_tokens'),
    }
    return {key: int(value) for key, value in tokens.items() if value is not None} | (
        {'cost': float(cost)} if (cost := number('cost')) is not None else {}
    )
