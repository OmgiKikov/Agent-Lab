"""The text of an export of conversations as the customer saw it, and the agent's own words in it."""

import re

# A chat button the agent sent, written into the export's text as «` ` ` transition-code CODE ` ` `».
CONTROL = re.compile(r'`\s*`\s*`\s*transition-code\s*([A-Za-z0-9_-]*)\s*`\s*`\s*`')
# The line as_seen puts under a reply for those buttons.
BUTTONS = re.compile(r'\n\[Кнопки: [^\n]*\]\Z')


def as_seen(text: str) -> str:
    """An agent reply as the customer saw it: its words, then the buttons it sent, not the export's control code.
    A judge shown the raw code reads it as the agent's formatting (frontend/src/product/text.ts does the same)."""
    buttons = [code or 'кнопка' for code in CONTROL.findall(text)]
    words = CONTROL.sub('', text).strip()
    return words + ('\n[Кнопки: ' + ' | '.join(buttons) + ']' if buttons else '')


def words(text: str) -> str:
    """What the agent wrote in a reply, raw or as_seen: the line of buttons is the Lab's and the code is the export's,
    so neither is evidence of the agent's words."""
    return BUTTONS.sub('', CONTROL.sub('', text)).strip()
