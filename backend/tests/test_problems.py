import json
import unittest

import support

from lab import storage
from lab.domain import checks, scenarios, was_is
from lab.domain.problems import rule_key
from lab.domain.results import carry_reviews, summarize
from lab.flows import accuracy, answers, inputs
from lab.flows import checks as problems

SOURCE = {'id': 'src-1', 'kind': 'prompt', 'origin': 'prompts/main.txt', 'content': 'Не отправляй клиента в поддержку.'}
QUOTE = 'Не отправляй клиента в поддержку'
RULE = {'id': 't1r1', 'name': 'Не отсылает в поддержку', 'text': 'Агент не отсылает в поддержку', 'quote': QUOTE}


def audit() -> dict:
    """Two topics restating one rule, three conversations: an error, a pass, one the judge could not decide."""
    return {
        'sampled': 4,
        'finishedAt': '2026-09-28T10:00:00+00:00',
        'topics': [
            {'id': 't1', 'title': 'Терминалы', 'rules': [RULE]},
            {'id': 't2', 'title': 'Возвраты', 'rules': [dict(RULE, id='t2r1')]},
        ],
        'results': [
            {
                'dialogueId': 'd1',
                'status': 'FAIL',
                'opening': 'Терминал не работает',
                'rules': [{'ruleId': 't1r1', 'status': 'FAIL', 'reason': 'Отправил', 'agentQuote': 'звоните'}],
                'second': {'status': 'FAIL', 'rules': [{'ruleId': 't1r1', 'status': 'FAIL'}]},
            },
            {
                'dialogueId': 'd2',
                'status': 'PASS',
                'opening': 'Как вернуть деньги',
                'rules': [{'ruleId': 't2r1', 'status': 'PASS', 'reason': 'Ответил', 'agentQuote': 'откройте'}],
            },
            {
                'dialogueId': 'd3',
                'status': 'UNMEASURED',
                'opening': 'Привет',
                'rules': [{'ruleId': 't1r1', 'status': 'UNKNOWN', 'reason': 'Не ясно', 'agentQuote': ''}],
            },
        ],
    }


POLICY = {'id': 'tone-of-voice', 'kind': 'tone-of-voice', 'origin': 'ToV.docx', 'content': 'Обращайтесь на вы.'}
TONE_RULE = {'id': 'pronouns', 'name': 'Обращение', 'text': 'Обращается на вы', 'quote': 'Обращайтесь на вы'}


def tone_result() -> dict:
    """A tone-of-voice result: its one topic, an error in the conversation where the audit found one too."""
    row = {'ruleId': 'pronouns', 'status': 'FAIL', 'reason': 'На ты', 'agentQuote': 'звони'}
    return {
        'purpose': 'tone-of-voice',
        'sampled': 1,
        'finishedAt': '2026-09-29T10:00:00+00:00',
        'topics': [{'id': 't1', 'title': 'Tone of voice', 'rules': [dict(TONE_RULE, sourceId='tone-of-voice')]}],
        'results': [{'dialogueId': 'd1', 'status': 'FAIL', 'opening': 'Терминал не работает', 'rules': [row]}],
    }


def tone_run() -> dict:
    """A finished run of scenarios built from tone of voice, newer than played_run."""
    item = {
        'cardId': 'tone-card',
        'status': 'FAIL',
        'topic': 'Tone of voice',
        'criteria': [TONE_RULE],
        'conversation': [{'role': 'customer', 'text': 'Привет'}],
        'rules': [{'ruleId': 'pronouns', 'status': 'FAIL', 'reason': 'На ты', 'agentQuote': 'звони'}],
    }
    return {
        'id': 'run-tone',
        'check': 'tone',
        'startedAt': '2026-10-01T10:00:00+00:00',
        'finishedAt': '2026-10-01T10:10:00+00:00',
        'status': 'done',
        'items': [item],
    }


def played_run() -> dict:
    """A finished run whose item keeps the criterion frozen when it was played."""
    criterion = {'id': 'c1', 'text': 'Агент не отсылает в поддержку', 'quote': QUOTE}
    return {
        'id': 'run-1',
        'startedAt': '2026-09-30T10:00:00+00:00',
        'finishedAt': '2026-09-30T10:10:00+00:00',
        'status': 'done',
        'items': [
            {
                'cardId': 'gone',
                'status': 'FAIL',
                'topic': 'Терминалы',
                'name': 'Нет связи',
                'criteria': [criterion],
                'conversation': [{'role': 'customer', 'text': 'Не работает'}],
                'rules': [{'ruleId': 'c1', 'status': 'FAIL', 'reason': 'Отправил', 'agentQuote': 'звоните'}],
            }
        ],
    }


class ProblemsTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        support.serve(self)
        storage.documents.save(inputs.SOURCES, [SOURCE])
        storage.documents.save(accuracy.RESULT, audit())

    def test_a_rule_restated_in_two_topics_is_one_rule_counted_per_conversation(self) -> None:
        value = problems.problems('code')
        self.assertEqual(len(value['rules']), 1)
        rule = value['rules'][0]
        self.assertEqual(rule['topics'], ['Терминалы', 'Возвраты'])
        self.assertEqual(rule['rule']['name'], 'Не отсылает в поддержку')
        self.assertEqual(rule['rule']['origin'], 'prompts/main.txt')
        # d3, which the check could not decide, is no conversation of its count: its verdict stays an example.
        counts = [rule['log'][key] for key in ('failed', 'passed', 'unknown', 'notApplicable')]
        self.assertEqual(counts, [1, 1, 0, 0])
        self.assertEqual([e['dialogueId'] for e in rule['log']['examples']], ['d1', 'd2', 'd3'])
        self.assertEqual(rule['log']['examples'][0]['second'], 'agree')
        self.assertEqual(value['log'], {
            'sampled': 4,
            'assessed': 2,
            'withViolations': 1,
            'unassessed': 2,
            'finishedAt': '2026-09-28T10:00:00+00:00',
            'rulesSince': None,
        })  # fmt: skip
        self.assertEqual(value['problems'], [rule['id']])
        self.assertIsNone(value['sim'])

    def test_a_rule_names_the_ids_its_verdicts_carry_in_each_stage(self) -> None:
        # A verdict keeps the wording the check saw (a clarified criterion's text grows): screens match it by id.
        value = audit()
        value['results'][0]['rules'][0]['rule'] = RULE['text'] + '\n\nУточнения, подтверждённые человеком:\n…'
        storage.documents.save(accuracy.RESULT, value)
        storage.runs.create(played_run())
        rule = problems.problems('code', 'run-1')['rules'][0]
        self.assertEqual((rule['log']['ruleIds'], rule['sim']['ruleIds']), (['t1r1', 't2r1'], ['c1']))

    def test_a_criterion_is_counted_only_in_the_conversations_its_check_counts_as_checked(self) -> None:
        """«57 из 95» beside «92 проверенных» is a part bigger than the whole: a criterion decided in a conversation the
        check could not decide (another criterion unknown there) is counted nowhere, its verdict stays an example; a
        checked conversation without a verdict of the criterion is one it does not apply to. The four counts of each
        criterion add up to the check's own."""
        other = {'id': 't1r2', 'name': 'Здоровается', 'text': 'Агент здоровается', 'quote': 'Здоровайся с клиентом'}

        def talk(dialogue_id: str, status: str, first: str, second: str) -> dict:
            rows = [
                {'ruleId': rule_id, 'status': verdict, 'reason': 'Так', 'agentQuote': 'Здравствуйте, звоните'}
                for rule_id, verdict in (('t1r1', first), ('t1r2', second))
            ]
            return {'dialogueId': dialogue_id, 'status': status, 'opening': dialogue_id, 'rules': rows}

        value = audit() | {
            'topics': [{'id': 't1', 'title': 'Терминалы', 'rules': [RULE, other]}],
            'results': [
                talk('d1', 'FAIL', 'FAIL', 'NOT_APPLICABLE'),
                talk('d2', 'PASS', 'PASS', 'PASS'),
                talk('d3', 'UNMEASURED', 'PASS', 'UNKNOWN'),
                talk('d4', 'FAIL', 'UNKNOWN', 'FAIL'),
            ],
        }
        storage.documents.save(accuracy.RESULT, value)
        found = problems.problems('code')
        self.assertEqual(found['log']['assessed'], 3)
        counted = ('failed', 'passed', 'unknown', 'notApplicable')
        by_name = {rule['rule']['name']: rule['log'] for rule in found['rules']}
        self.assertEqual([by_name['Не отсылает в поддержку'][key] for key in counted], [1, 1, 1, 0])
        self.assertEqual([by_name['Здоровается'][key] for key in counted], [1, 1, 0, 1])
        for side in by_name.values():
            self.assertEqual(sum(side[key] for key in counted), found['log']['assessed'])
        passed = [e['dialogueId'] for e in by_name['Не отсылает в поддержку']['examples'] if e['status'] == 'PASS']
        self.assertEqual(passed, ['d2', 'd3'])
        # Each example says whether the counts count it: a screen lists exactly the verdicts it counts.
        listed = {e['dialogueId']: e['counted'] for e in by_name['Не отсылает в поддержку']['examples']}
        self.assertEqual(listed, {'d1': True, 'd2': True, 'd3': False, 'd4': True})
        # «Было → стало» counts a criterion the same way.
        criteria = was_is.criteria(value, [SOURCE])
        self.assertEqual(criteria[rule_key(QUOTE)]['counts'], {'failed': 1, 'measured': 2})

    def test_a_run_counts_a_criterion_only_in_the_conversations_it_measured(self) -> None:
        """The run's side as the audit's: a played conversation the judge could not decide counts nowhere, a measured
        one whose scenario does not check the criterion is one it does not apply to; a criterion only the run checked
        has nothing «not applicable» among the recorded answers, which never checked it."""
        record = played_run()
        greets = {'id': 'c2', 'text': 'Агент здоровается', 'quote': ''}
        undecided = dict(record['items'][0], status='UNMEASURED', criteria=[*record['items'][0]['criteria'], greets])
        undecided['rules'] = [
            {'ruleId': 'c1', 'status': 'PASS', 'reason': 'Не отправил', 'agentQuote': 'поможем сами'},
            {'ruleId': 'c2', 'status': 'UNKNOWN', 'reason': 'Не ясно', 'agentQuote': ''},
        ]
        greeted = dict(record['items'][0], cardId='greets', status='PASS', criteria=[greets])
        greeted['rules'] = [{'ruleId': 'c2', 'status': 'PASS', 'reason': 'Поздоровался', 'agentQuote': 'Здравствуйте'}]
        record['items'] += [undecided, greeted]
        storage.runs.create(record)
        found = problems.problems('code', 'run-1')
        self.assertEqual(found['sim']['assessed'], 2)
        by_text = {rule['rule']['text']: rule for rule in found['rules']}
        counted = ('failed', 'passed', 'unknown', 'notApplicable')
        support_rule = by_text['Агент не отсылает в поддержку']
        self.assertEqual([support_rule['sim'][key] for key in counted], [1, 0, 0, 1])
        self.assertEqual(
            [(e['status'], e['counted']) for e in support_rule['sim']['examples']], [('FAIL', True), ('PASS', False)]
        )
        self.assertEqual([by_text['Агент здоровается']['sim'][key] for key in counted], [0, 1, 0, 1])
        self.assertEqual([by_text['Агент здоровается']['log'][key] for key in counted], [0, 0, 0, 0])

    def test_a_criterion_a_run_checked_stands_on_its_side_though_it_never_applied(self) -> None:
        """A criterion frozen in a played conversation was checked in it, whatever its verdicts: like the audit's
        criteria, it stands on the run's side, where it did not apply in any conversation the run measured."""
        record = played_run()
        refund = {'id': 'c3', 'text': 'Агент называет срок возврата денег', 'quote': ''}
        item = record['items'][0]
        item['criteria'] = [*item['criteria'], refund]
        item['rules'] = [*item['rules'], {'ruleId': 'c3', 'status': 'NOT_APPLICABLE', 'reason': '', 'agentQuote': ''}]
        storage.runs.create(record)
        found = problems.problems('code', 'run-1')
        side = next(rule for rule in found['rules'] if rule['rule']['text'] == refund['text'])['sim']
        counted = [side[key] for key in ('failed', 'passed', 'unknown', 'notApplicable')]
        self.assertEqual((side['ruleIds'], counted), (['c3'], [0, 0, 0, found['sim']['assessed']]))

    def test_the_first_example_of_a_problem_shows_what_its_title_says(self) -> None:
        def failed(dialogue_id: str, title: str, second: dict | None = None) -> dict:
            row = {'ruleId': 't1r1', 'status': 'FAIL', 'reason': title, 'agentQuote': 'звоните', 'title': title}
            result = {'dialogueId': dialogue_id, 'status': 'FAIL', 'opening': dialogue_id, 'rules': [row]}
            return {**result, 'second': second} if second else result

        value = audit()
        agreed = {'model': 'm', 'status': 'FAIL', 'rules': [{'ruleId': 't1r1', 'status': 'FAIL'}]}
        value['results'] = [
            failed('d1', 'Отправляет звонить', agreed),
            failed('d2', 'Пишет канцеляритом'),
            failed('d3', 'Пишет канцеляритом'),
        ]
        storage.documents.save(accuracy.RESULT, value)
        rule = problems.problems('code')['rules'][0]
        self.assertEqual(rule['title'], 'Пишет канцеляритом')
        self.assertEqual(rule['log']['examples'][0]['title'], 'Пишет канцеляритом')

    def test_an_example_the_person_refuted_is_never_shown_first(self) -> None:
        def failed(dialogue_id: str, title: str, review: str) -> dict:
            row = {'ruleId': 't1r1', 'status': 'FAIL', 'reason': title, 'agentQuote': 'звоните', 'title': title}
            row['review'] = review
            return {'dialogueId': dialogue_id, 'status': 'FAIL', 'opening': dialogue_id, 'rules': [row]}

        value = audit()
        value['results'] = [
            failed('d1', 'Отправляет звонить', 'agree'),
            failed('d2', 'Пишет канцеляритом', 'disagree'),
            failed('d3', 'Пишет канцеляритом', 'disagree'),
        ]
        storage.documents.save(accuracy.RESULT, value)
        rule = problems.problems('code')['rules'][0]
        self.assertEqual(rule['log']['examples'][0]['dialogueId'], 'd1')

    def test_a_second_check_without_a_verdict_is_not_a_disagreement(self) -> None:
        value = audit()
        value['results'][0]['second'] = {'model': 'm', 'status': 'UNMEASURED'}
        storage.documents.save(accuracy.RESULT, value)
        example = problems.problems('code')['rules'][0]['log']['examples'][0]
        self.assertEqual(example['status'], 'FAIL')
        self.assertIsNone(example['second'])

    def test_a_second_verdict_on_the_whole_conversation_says_what_it_found(self) -> None:
        value = audit()
        value['results'][1]['second'] = {'model': 'm', 'status': 'PASS'}
        storage.documents.save(accuracy.RESULT, value)
        example = next(e for e in problems.problems('code')['rules'][0]['log']['examples'] if e['dialogueId'] == 'd2')
        self.assertEqual(
            (example['second'], example['secondScope'], example['secondStatus']), ('agree', 'dialogue', 'PASS')
        )

    def test_agreement_of_the_two_checks_counts_only_conversations_both_decided(self) -> None:
        results = [
            {'status': 'FAIL', 'rules': [], 'second': {'model': 'm', 'status': 'FAIL'}},
            {'status': 'FAIL', 'rules': [], 'second': {'model': 'm', 'status': 'UNMEASURED'}},
            {'status': 'UNMEASURED', 'rules': [], 'second': {'model': 'm', 'status': 'UNMEASURED'}},
        ]
        self.assertEqual(summarize(results, [])['secondJudge'], {'model': 'm', 'checked': 1, 'agree': 1})

    def test_run_side_uses_the_criterion_frozen_in_the_item(self) -> None:
        storage.runs.create(played_run())
        value = problems.problems('code')
        rule = value['rules'][0]
        self.assertEqual(rule['sim']['failed'], 1)
        self.assertEqual(rule['sim']['examples'][0]['opening'], 'Не работает')
        self.assertEqual(value['sim']['runId'], 'run-1')
        self.assertEqual(value['sim']['withViolations'], 1)

    def test_legacy_general_rule_survives_a_rebuilt_deck(self) -> None:
        record = played_run()
        item = record['items'][0]
        del item['criteria']
        criterion = scenarios.FOLLOWS_KNOWLEDGE
        item['rules'] = [{'ruleId': criterion['id'], 'rule': criterion['text'], 'status': 'FAIL'}]
        storage.runs.create(record)
        value = problems.problems('code', 'run-1')
        found = next(rule for rule in value['rules'] if rule['sim']['failed'])
        self.assertEqual(found['rule']['quote'], criterion['quote'])
        self.assertEqual(found['sim']['failed'], 1)

    def test_legacy_custom_verdicts_count_without_fabricated_source_quotes(self) -> None:
        record = played_run()
        item = record['items'][0]
        del item['criteria']
        item['rules'] = [
            {'ruleId': 'lost-1', 'rule': 'Уточняет реквизиты клиента', 'status': 'FAIL'},
            {'ruleId': 'lost-2', 'rule': 'Сообщает время работы', 'status': 'FAIL'},
        ]
        storage.runs.create(record)
        found = [rule for rule in problems.problems('code', 'run-1')['rules'] if rule['sim']['failed']]
        self.assertEqual(len(found), 2)
        self.assertEqual(len({rule['id'] for rule in found}), 2)
        self.assertTrue(all(rule['rule']['quote'] == '' and rule['sim']['failed'] == 1 for rule in found))

    async def test_the_problems_are_those_of_one_check_with_its_runs_and_its_scenarios(self) -> None:
        storage.documents.save(inputs.SOURCES, [SOURCE, POLICY])
        storage.documents.save('tone-result.json', tone_result())
        storage.runs.create(played_run())  # of Точность
        storage.runs.create(tone_run())  # of tone of voice, the newest run
        deck = {'check': 'code', 'cards': [{'id': 'card-1', 'sourceDialogueId': 'd1', 'criteria': []}]}
        storage.documents.save(checks.DECK, deck)
        code = (await self.client.get('/api/problems?check=code')).json()
        tone = (await self.client.get('/api/problems?check=tone')).json()
        self.assertEqual((code['check'], tone['check']), ('code', 'tone'))
        self.assertEqual([rule['rule']['text'] for rule in code['rules']], [RULE['text']])
        self.assertEqual([rule['rule']['text'] for rule in tone['rules']], [TONE_RULE['text']])
        self.assertEqual(tone['rules'][0]['rule']['origin'], 'ToV.docx')
        self.assertEqual(
            (code['log']['finishedAt'], tone['log']['finishedAt']), (audit()['finishedAt'], '2026-09-29T10:00:00+00:00')
        )
        self.assertEqual((code['sim']['runId'], tone['sim']['runId']), ('run-1', 'run-tone'))
        # The scenarios built from Точность's errors are named only among its problems.
        self.assertEqual((code['rules'][0]['scenarioIds'], tone['rules'][0]['scenarioIds']), (['card-1'], []))
        # Old links name no check: tone of voice. A run's problems are those of its own check.
        self.assertEqual((await self.client.get('/api/problems')).json(), tone)
        by_run = (await self.client.get('/api/problems?run=run-1&check=tone')).json()
        self.assertEqual(
            (by_run['check'], by_run['log']['finishedAt'], by_run['sim']['runId']),
            ('code', audit()['finishedAt'], 'run-1'),
        )
        self.assertEqual((await self.client.get('/api/problems?check=accuracy')).status_code, 422)

    async def test_a_newer_run_the_model_checked_nothing_of_is_not_the_latest_result(self) -> None:
        unchecked = played_run() | {
            'id': 'run-2',
            'startedAt': '2026-10-01T10:00:00+00:00',
            'finishedAt': '2026-10-01T10:10:00+00:00',
        }
        unchecked['items'] = [dict(unchecked['items'][0], status='UNMEASURED', rules=[])]
        storage.runs.create(unchecked)
        latest = '/api/problems?check=code'
        self.assertEqual((await self.client.get(latest)).json()['sim']['runId'], 'run-2')  # the only one there is
        storage.runs.create(played_run())  # older, with a conversation checked: as «Обзор» shows it
        self.assertEqual((await self.client.get(latest)).json()['sim']['runId'], 'run-1')
        self.assertEqual((await self.client.get('/api/problems?run=run-2')).json()['sim']['runId'], 'run-2')

    async def test_run_summary_excludes_unmeasured_conversations_from_checked_count(self) -> None:
        record = played_run()
        record['items'].extend([{'status': 'PASS', 'cardId': 'pass'}, {'status': 'UNMEASURED', 'cardId': 'unknown'}])
        storage.runs.create(record)
        summary = (await self.client.get('/api/problems?run=run-1')).json()['sim']
        self.assertEqual((summary['dialogs'], summary['assessed'], summary['unassessed']), (3, 2, 1))
        self.assertEqual(summary['assessed'] - summary['withViolations'], 1)

    async def test_a_run_recorded_under_an_older_name_of_its_agent_is_reported_under_the_current_one(self) -> None:
        storage.runs.create(played_run() | {'target': 'prod', 'targetName': 'Агент на ИФТ'})
        summary = (await self.client.get('/api/problems?run=run-1')).json()['sim']
        self.assertEqual(summary['target'], 'Тестовый стенд банка')

    async def test_state_exposes_the_revision_used_by_source_cache(self) -> None:
        inputs.replace_sources([dict(SOURCE, sha256='source-revision')])
        state = (await self.client.get('/api/state')).json()
        source = (await self.client.get('/api/sources/src-1')).json()
        self.assertEqual(state['sources'][0]['sha256'], source['sha256'])

    async def test_new_export_does_not_reuse_old_verdicts_for_the_same_dialogue_id(self) -> None:
        dialogue = {
            'id': 'd1',
            'messages': [{'role': 'user', 'content': 'Новый вопрос'}, {'role': 'assistant', 'content': 'Новый ответ'}],
        }
        response = await self.client.post('/api/logs?name=new.jsonl', content=json.dumps(dialogue))
        self.assertEqual(response.status_code, 200, response.text)
        state = (await self.client.get('/api/state')).json()
        self.assertEqual(state['checks'], {'tone': None, 'code': None})
        detail = (await self.client.get('/api/logs/d1')).json()
        self.assertIsNone(detail['evaluation'])
        self.assertEqual(detail['messages'][1]['content'], 'Новый ответ')
        self.assertIsNone((await self.client.get('/api/problems?check=code')).json()['log'])

    async def test_problems_and_source_routes(self) -> None:
        response = await self.client.get('/api/problems?check=code')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(response.json()['rules']), 1)
        self.assertEqual((await self.client.get('/api/problems?run=missing')).status_code, 404)
        response = await self.client.get('/api/sources/src-1')
        self.assertEqual(response.json()['content'], SOURCE['content'])
        self.assertEqual((await self.client.get('/api/sources/missing')).status_code, 404)

    async def test_a_person_answers_on_one_criterion_of_a_logged_conversation(self) -> None:
        body = {'source': 'log', 'dialogueId': 'd1', 'ruleId': 't1r1', 'decision': 'disagree'}
        response = await self.client.post('/api/review', json=body)
        self.assertEqual(response.status_code, 200, response.text)
        example = (await self.client.get('/api/problems?check=code')).json()['rules'][0]['log']['examples']
        failed = next(e for e in example if e['status'] == 'FAIL')
        self.assertEqual((failed['review'], failed['reviewScope']), ('disagree', 'rule'))
        missing = await self.client.post('/api/review', json=dict(body, ruleId='nope'))
        self.assertEqual(missing.status_code, 404)
        self.assertEqual((await self.client.post('/api/review', json={'source': 'log'})).status_code, 422)

    async def test_an_answer_on_a_verdict_that_changed_meanwhile_is_refused(self) -> None:
        # The person saw «без ошибки» in an earlier result; the current one says the agent erred here.
        body = {'source': 'log', 'dialogueId': 'd1', 'ruleId': 't1r1', 'decision': 'agree', 'status': 'PASS'}
        for stale in ({}, {'finishedAt': audit()['finishedAt']}):
            response = await self.client.post('/api/review', json={**body, **stale})
            self.assertEqual(response.status_code, 409, response.text)
            self.assertEqual(response.json()['detail'], 'Ответ не сохранён: оценка изменилась. Обновите страницу.')
        self.assertNotIn('review', storage.documents.load(accuracy.RESULT)['results'][0]['rules'][0])
        response = await self.client.post('/api/review', json={**body, 'status': 'FAIL'})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(problems.current('code')['results'][0]['rules'][0].get('review'), 'agree')
        storage.runs.create(played_run())
        body = {'source': 'sim', 'run': 'run-1', 'index': 0, 'ruleId': 'c1', 'decision': 'agree', 'status': 'PASS'}
        self.assertEqual((await self.client.post('/api/review', json=body)).status_code, 409)
        self.assertNotIn('review', storage.runs.get('run-1')['items'][0]['rules'][0])
        self.assertEqual((await self.client.post('/api/review', json={**body, 'status': 'FAIL'})).status_code, 200)

    async def test_an_answer_given_meanwhile_elsewhere_is_never_overwritten_unseen(self) -> None:
        """Two tabs show «без ответа» on the same case: the first answer stands, the second is refused (409) and the
        screen gets the first one. A request that names no previous answer (an older screen) is not compared."""
        body = {'source': 'log', 'dialogueId': 'd1', 'ruleId': 't1r1', 'status': 'FAIL', 'before': None}
        first = await self.client.post('/api/review', json={**body, 'decision': 'agree'})
        self.assertEqual(first.status_code, 200, first.text)
        second = await self.client.post('/api/review', json={**body, 'decision': 'disagree'})
        self.assertEqual(second.status_code, 409, second.text)
        self.assertEqual(second.json()['detail'], answers.ANSWERED)
        self.assertEqual(problems.current('code')['results'][0]['rules'][0].get('review'), 'agree')
        changed = await self.client.post('/api/review', json={**body, 'before': 'agree', 'decision': 'disagree'})
        self.assertEqual(changed.status_code, 200, changed.text)
        older = {key: value for key, value in body.items() if key != 'before'}
        self.assertEqual((await self.client.post('/api/review', json={**older, 'decision': None})).status_code, 200)
        self.assertNotIn(problems.current('code')['results'][0]['rules'][0].get('review'), ('agree', 'disagree'))
        storage.runs.create(played_run())
        sim = {'source': 'sim', 'run': 'run-1', 'index': 0, 'ruleId': 'c1', 'status': 'FAIL', 'before': None}
        self.assertEqual((await self.client.post('/api/review', json={**sim, 'decision': 'agree'})).status_code, 200)
        refused = await self.client.post('/api/review', json={**sim, 'decision': 'disagree'})
        self.assertEqual(refused.status_code, 409, refused.text)
        self.assertEqual(storage.runs.get('run-1')['items'][0]['rules'][0]['review'], 'agree')

    async def test_log_answers_wait_for_a_running_audit(self) -> None:
        with support.running('discover'):
            body = {'source': 'log', 'dialogueId': 'd1', 'ruleId': 't1r1', 'decision': 'agree'}
            response = await self.client.post('/api/review', json=body)
        self.assertEqual(response.status_code, 409)
        self.assertNotIn('review', storage.documents.load(accuracy.RESULT)['results'][0]['rules'][0])

    async def test_a_person_answers_on_one_criterion_of_a_simulated_conversation(self) -> None:
        storage.runs.create(played_run())
        body = {'source': 'sim', 'run': 'run-1', 'index': 0, 'ruleId': 'c1', 'decision': 'agree'}
        response = await self.client.post('/api/review', json=body)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()['metric']['human'], {'reviewed': 1, 'agree': 1})
        self.assertEqual(storage.runs.get('run-1')['items'][0]['rules'][0]['review'], 'agree')
        self.assertEqual((await self.client.post('/api/review', json=dict(body, ruleId='nope'))).status_code, 404)

    async def test_upload_remembers_the_export(self) -> None:
        dialogue = {'id': 'x', 'messages': [{'role': 'user', 'content': 'q'}, {'role': 'assistant', 'content': 'a'}]}
        await self.client.post('/api/logs?name=export.jsonl', content=json.dumps(dialogue))
        logs = (await self.client.get('/api/state')).json()['logs']
        self.assertEqual((logs['total'], logs['file']), (1, 'export.jsonl'))
        self.assertTrue(logs['updatedAt'])


class RuleReviewStoreTests(unittest.TestCase):
    def setUp(self) -> None:
        support.lab(self)

    def test_a_decision_stays_with_an_unchanged_verdict_and_leaves_a_changed_one(self) -> None:
        storage.runs.create(played_run())
        answers.on_run('run-1', 0, 'agree', 'c1')
        same = {'ruleId': 'c1', 'status': 'FAIL', 'reason': 'Снова отправил', 'agentQuote': 'звоните'}
        record = storage.runs.update_item('run-1', 0, {'rules': [same]})
        self.assertEqual(record['items'][0]['rules'][0]['review'], 'agree')
        flipped = dict(same, status='PASS')
        record = storage.runs.update_item('run-1', 0, {'rules': [flipped], 'status': 'PASS'})
        self.assertIsNone(record['items'][0]['rules'][0].get('review'))

    def test_the_producer_copy_cannot_restore_a_withdrawn_decision(self) -> None:
        storage.runs.create(played_run())
        stale = dict(played_run()['items'][0]['rules'][0], review='agree')
        record = storage.runs.update_item('run-1', 0, {'rules': [stale]})
        self.assertIsNone(record['items'][0]['rules'][0].get('review'))

    def test_a_repeated_audit_with_frozen_rules_keeps_the_answers(self) -> None:
        previous = audit()
        previous['results'][0]['rules'][0]['review'] = 'disagree'
        results = audit()['results']
        carry_reviews(previous, results)
        self.assertEqual(results[0]['rules'][0]['review'], 'disagree')
        changed = audit()['results']
        changed[0]['rules'][0]['status'] = 'PASS'
        carry_reviews(previous, changed)
        self.assertNotIn('review', changed[0]['rules'][0])

    def test_an_answer_on_an_error_stays_with_the_words_it_pointed_at(self) -> None:
        """«Нет, это не ошибка» on «Здравствуйте!!!» says nothing of «Вы сами виноваты»: a new error by the same
        criterion in the same conversation, citing other words, waits for its own answer. An answer on «без ошибки»
        is about the conversation, whatever words show it."""
        previous = audit()
        previous['results'][0]['rules'][0].update(agentQuote='Здравствуйте!!!', review='disagree')
        previous['results'][1]['rules'][0]['review'] = 'disagree'  # the person found an error the check missed
        results = audit()['results']
        results[0]['rules'][0]['agentQuote'] = 'Вы сами виноваты, читайте договор'
        results[1]['rules'][0]['agentQuote'] = 'зайдите в раздел «Возвраты»'
        carry_reviews(previous, results)
        self.assertNotIn('review', results[0]['rules'][0])
        self.assertEqual(results[1]['rules'][0]['review'], 'disagree')
        # The same in a run judged again.
        storage.runs.create(played_run())
        answers.on_run('run-1', 0, 'agree', 'c1')
        other = {'ruleId': 'c1', 'status': 'FAIL', 'reason': 'Грубит', 'agentQuote': 'сами разбирайтесь'}
        record = storage.runs.update_item('run-1', 0, {'rules': [other]})
        self.assertIsNone(record['items'][0]['rules'][0].get('review'))
