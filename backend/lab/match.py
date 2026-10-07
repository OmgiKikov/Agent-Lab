"""Whether the replayed reply says what production said (spec 2026-10-06-acquiring-replay-service-design.md). The
trace of a replay explains production's reply only when the two match. The criterion is shown under the two replies
and counts in no status and no metric; the knowledge-base summary of a replay (rag.summary) shows how many of the steps
that used the knowledge base matched production."""

FAMILY = 'replay'
CRITERION = {
    'id': f'{FAMILY}:match',
    'family': FAMILY,
    'name': 'Совпадение с продом',
    'observation': 'reply',
    'condition': 'В логе есть ответ агента в проде на это сообщение клиента.',
    'text': 'Ответ агента на повторе по смыслу совпадает с ответом в проде: то же действие, те же шаги, '
    'условия и суммы.',
    'acceptable': 'Другие слова и другой порядок. Другие данные клиента: в повторе системы банка отвечают тестовыми.',
    'quote': '',
}
NO_PROD_REPLY = 'В логе нет ответа прода на это сообщение.'


def skipped() -> dict:
    """The criterion on a step whose message production did not answer in the log."""
    return {
        'ruleId': CRITERION['id'],
        'rule': CRITERION['text'],
        'status': 'NOT_APPLICABLE',
        'reason': NO_PROD_REPLY,
        'agentQuote': '',
        'title': '',
    }


def counted(rows: list[dict]) -> list[dict]:
    """A step's rows that make its status: all but the match with production."""
    return [row for row in rows if not row['ruleId'].startswith(f'{FAMILY}:')]
