import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import httpx

from lab import api, cards, discover, problems, store
from lab.jobs import Jobs

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
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        for mocked in (
            patch.object(store, 'DB', Path(directory.name) / 'lab.sqlite3'),
            patch.object(api, 'jobs', Jobs()),
        ):
            mocked.start()
            self.addCleanup(mocked.stop)
        store.save(api.sources.FILE, [SOURCE])
        store.save(discover.RESULT, audit())
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=api.app), base_url='http://test')

    async def asyncTearDown(self) -> None:
        await api.jobs.close()
        await self.client.aclose()

    def test_a_rule_restated_in_two_topics_is_one_rule_counted_per_conversation(self) -> None:
        value = problems.build('code')
        self.assertEqual(len(value['rules']), 1)
        rule = value['rules'][0]
        self.assertEqual(rule['topics'], ['Терминалы', 'Возвраты'])
        self.assertEqual(rule['rule']['name'], 'Не отсылает в поддержку')
        self.assertEqual(rule['rule']['origin'], 'prompts/main.txt')
        self.assertEqual((rule['log']['failed'], rule['log']['passed'], rule['log']['unknown']), (1, 1, 1))
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
        store.save(discover.RESULT, value)
        store.create_run(played_run())
        rule = problems.build('code', 'run-1')['rules'][0]
        self.assertEqual((rule['log']['ruleIds'], rule['sim']['ruleIds']), (['t1r1', 't2r1'], ['c1']))

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
        store.save(discover.RESULT, value)
        rule = problems.build('code')['rules'][0]
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
        store.save(discover.RESULT, value)
        rule = problems.build('code')['rules'][0]
        self.assertEqual(rule['log']['examples'][0]['dialogueId'], 'd1')

    def test_a_second_check_without_a_verdict_is_not_a_disagreement(self) -> None:
        value = audit()
        value['results'][0]['second'] = {'model': 'm', 'status': 'UNMEASURED'}
        store.save(discover.RESULT, value)
        example = problems.build('code')['rules'][0]['log']['examples'][0]
        self.assertEqual(example['status'], 'FAIL')
        self.assertIsNone(example['second'])

    def test_a_second_verdict_on_the_whole_conversation_says_what_it_found(self) -> None:
        value = audit()
        value['results'][1]['second'] = {'model': 'm', 'status': 'PASS'}
        store.save(discover.RESULT, value)
        example = next(e for e in problems.build('code')['rules'][0]['log']['examples'] if e['dialogueId'] == 'd2')
        self.assertEqual(
            (example['second'], example['secondScope'], example['secondStatus']), ('agree', 'dialogue', 'PASS')
        )

    def test_agreement_of_the_two_checks_counts_only_conversations_both_decided(self) -> None:
        results = [
            {'status': 'FAIL', 'rules': [], 'second': {'model': 'm', 'status': 'FAIL'}},
            {'status': 'FAIL', 'rules': [], 'second': {'model': 'm', 'status': 'UNMEASURED'}},
            {'status': 'UNMEASURED', 'rules': [], 'second': {'model': 'm', 'status': 'UNMEASURED'}},
        ]
        self.assertEqual(discover.summarize(results, [])['secondJudge'], {'model': 'm', 'checked': 1, 'agree': 1})

    def test_run_side_uses_the_criterion_frozen_in_the_item(self) -> None:
        store.create_run(played_run())
        value = problems.build('code')
        rule = value['rules'][0]
        self.assertEqual(rule['sim']['failed'], 1)
        self.assertEqual(rule['sim']['examples'][0]['opening'], 'Не работает')
        self.assertEqual(value['sim']['runId'], 'run-1')
        self.assertEqual(value['sim']['withViolations'], 1)

    def test_legacy_general_rule_survives_a_rebuilt_deck(self) -> None:
        record = played_run()
        item = record['items'][0]
        del item['criteria']
        criterion = cards.FOLLOWS_KNOWLEDGE
        item['rules'] = [{'ruleId': criterion['id'], 'rule': criterion['text'], 'status': 'FAIL'}]
        store.create_run(record)
        value = problems.build('code', 'run-1')
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
        store.create_run(record)
        found = [rule for rule in problems.build('code', 'run-1')['rules'] if rule['sim']['failed']]
        self.assertEqual(len(found), 2)
        self.assertEqual(len({rule['id'] for rule in found}), 2)
        self.assertTrue(all(rule['rule']['quote'] == '' and rule['sim']['failed'] == 1 for rule in found))

    async def test_the_problems_are_those_of_one_check_with_its_runs_and_its_scenarios(self) -> None:
        store.save(api.sources.FILE, [SOURCE, POLICY])
        store.save('tone-result.json', tone_result())
        store.create_run(played_run())  # of Точность
        store.create_run(tone_run())  # of tone of voice, the newest run
        deck = {'check': 'code', 'cards': [{'id': 'card-1', 'sourceDialogueId': 'd1', 'criteria': []}]}
        store.save(cards.DECK, deck)
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
        store.create_run(unchecked)
        latest = '/api/problems?check=code'
        self.assertEqual((await self.client.get(latest)).json()['sim']['runId'], 'run-2')  # the only one there is
        store.create_run(played_run())  # older, with a conversation checked: as «Обзор» shows it
        self.assertEqual((await self.client.get(latest)).json()['sim']['runId'], 'run-1')
        self.assertEqual((await self.client.get('/api/problems?run=run-2')).json()['sim']['runId'], 'run-2')

    async def test_run_summary_excludes_unmeasured_conversations_from_checked_count(self) -> None:
        record = played_run()
        record['items'].extend([{'status': 'PASS', 'cardId': 'pass'}, {'status': 'UNMEASURED', 'cardId': 'unknown'}])
        store.create_run(record)
        summary = (await self.client.get('/api/problems?run=run-1')).json()['sim']
        self.assertEqual((summary['dialogs'], summary['assessed'], summary['unassessed']), (3, 2, 1))
        self.assertEqual(summary['assessed'] - summary['withViolations'], 1)

    async def test_a_run_recorded_under_an_older_name_of_its_agent_is_reported_under_the_current_one(self) -> None:
        store.create_run(played_run() | {'target': 'prod', 'targetName': 'Агент на ИФТ'})
        summary = (await self.client.get('/api/problems?run=run-1')).json()['sim']
        self.assertEqual(summary['target'], 'Тестовый стенд банка')

    async def test_state_exposes_the_revision_used_by_source_cache(self) -> None:
        store.replace_inputs(api.sources.FILE, [dict(SOURCE, sha256='source-revision')])
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
        self.assertNotIn('review', store.load(discover.RESULT)['results'][0]['rules'][0])
        response = await self.client.post('/api/review', json={**body, 'status': 'FAIL'})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(store.load(discover.RESULT)['results'][0]['rules'][0]['review'], 'agree')
        store.create_run(played_run())
        body = {'source': 'sim', 'run': 'run-1', 'index': 0, 'ruleId': 'c1', 'decision': 'agree', 'status': 'PASS'}
        self.assertEqual((await self.client.post('/api/review', json=body)).status_code, 409)
        self.assertNotIn('review', store.run('run-1')['items'][0]['rules'][0])
        self.assertEqual((await self.client.post('/api/review', json={**body, 'status': 'FAIL'})).status_code, 200)

    async def test_log_answers_wait_for_a_running_audit(self) -> None:
        with patch.dict(api.jobs.state, {'running': True, 'kind': 'discover'}):
            body = {'source': 'log', 'dialogueId': 'd1', 'ruleId': 't1r1', 'decision': 'agree'}
            response = await self.client.post('/api/review', json=body)
        self.assertEqual(response.status_code, 409)
        self.assertNotIn('review', store.load(discover.RESULT)['results'][0]['rules'][0])

    async def test_a_person_answers_on_one_criterion_of_a_simulated_conversation(self) -> None:
        store.create_run(played_run())
        body = {'source': 'sim', 'run': 'run-1', 'index': 0, 'ruleId': 'c1', 'decision': 'agree'}
        response = await self.client.post('/api/review', json=body)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()['metric']['human'], {'reviewed': 1, 'agree': 1})
        self.assertEqual(store.run('run-1')['items'][0]['rules'][0]['review'], 'agree')
        self.assertEqual((await self.client.post('/api/review', json=dict(body, ruleId='nope'))).status_code, 404)

    async def test_upload_remembers_the_export(self) -> None:
        dialogue = {'id': 'x', 'messages': [{'role': 'user', 'content': 'q'}, {'role': 'assistant', 'content': 'a'}]}
        await self.client.post('/api/logs?name=export.jsonl', content=json.dumps(dialogue))
        logs = (await self.client.get('/api/state')).json()['logs']
        self.assertEqual((logs['total'], logs['file']), (1, 'export.jsonl'))
        self.assertTrue(logs['updatedAt'])


class RuleReviewStoreTests(unittest.TestCase):
    def setUp(self) -> None:
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        database = patch.object(store, 'DB', Path(directory.name) / 'lab.sqlite3')
        database.start()
        self.addCleanup(database.stop)

    def test_a_decision_stays_with_an_unchanged_verdict_and_leaves_a_changed_one(self) -> None:
        store.create_run(played_run())
        store.set_review('run-1', 0, 'agree', 'c1')
        same = {'ruleId': 'c1', 'status': 'FAIL', 'reason': 'Снова отправил', 'agentQuote': 'звоните'}
        record = store.update_item('run-1', 0, {'rules': [same]})
        self.assertEqual(record['items'][0]['rules'][0]['review'], 'agree')
        flipped = dict(same, status='PASS')
        record = store.update_item('run-1', 0, {'rules': [flipped], 'status': 'PASS'})
        self.assertNotIn('review', record['items'][0]['rules'][0])

    def test_the_producer_copy_cannot_restore_a_withdrawn_decision(self) -> None:
        store.create_run(played_run())
        stale = dict(played_run()['items'][0]['rules'][0], review='agree')
        record = store.update_item('run-1', 0, {'rules': [stale]})
        self.assertNotIn('review', record['items'][0]['rules'][0])

    def test_a_repeated_audit_with_frozen_rules_keeps_the_answers(self) -> None:
        previous = audit()
        previous['results'][0]['rules'][0]['review'] = 'disagree'
        results = audit()['results']
        discover.carry_reviews(previous, results)
        self.assertEqual(results[0]['rules'][0]['review'], 'disagree')
        changed = audit()['results']
        changed[0]['rules'][0]['status'] = 'PASS'
        discover.carry_reviews(previous, changed)
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
        discover.carry_reviews(previous, results)
        self.assertNotIn('review', results[0]['rules'][0])
        self.assertEqual(results[1]['rules'][0]['review'], 'disagree')
        # The same in a run judged again.
        store.create_run(played_run())
        store.set_review('run-1', 0, 'agree', 'c1')
        other = {'ruleId': 'c1', 'status': 'FAIL', 'reason': 'Грубит', 'agentQuote': 'сами разбирайтесь'}
        record = store.update_item('run-1', 0, {'rules': [other]})
        self.assertNotIn('review', record['items'][0]['rules'][0])
