"""The prototype's library operations preserve data, rule versions and the old working workflows."""

import asyncio
import json
import os
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

import support

from lab import storage
from lab.domain import checks, export
from lab.domain import judges as rules
from lab.flows import agent_context, connection, datasets, inputs, judges, tone


def dialogue(key='d1', question='Как вернуть терминал?'):
    return {'id': key, 'messages': [{'role': 'user', 'content': question}, {'role': 'assistant', 'content': 'Помогу.'}]}


def criterion(text='Обращайтесь к клиенту на вы.'):
    return {'id': 'r1', 'name': 'Обращение', 'text': text, 'quote': text, 'condition': '', 'acceptable': ''}


class DatasetTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        support.serve(self)

    async def test_two_datasets_coexist_and_selection_restores_their_own_result(self):
        first = datasets.add([dialogue()], 'one.jsonl', 'Первый')
        storage.documents.save(checks.result('tone'), {'result': 'first'})
        second = datasets.add([dialogue('d2', 'Другой вопрос')], 'two.jsonl', 'Второй')
        self.assertEqual(len(datasets.listed()['datasets']), 2)
        self.assertIsNone(storage.documents.load(checks.result('tone')))
        datasets.select(first['id'])
        self.assertEqual(storage.dialogues.ids(), ['d1'])
        self.assertEqual(storage.documents.load(checks.result('tone')), {'result': 'first'})
        datasets.select(second['id'])
        self.assertEqual(storage.dialogues.ids(), ['d2'])
        self.assertIsNone(storage.documents.load(checks.result('tone')))

    async def test_changed_rules_do_not_restore_a_stale_current_result(self):
        first = datasets.add([dialogue()], 'first.jsonl')
        storage.documents.save(checks.result('tone'), {'result': 'first'})
        datasets.add([dialogue('d2')], 'second.jsonl')
        storage.documents.save('sources.json', [{'id': checks.TONE_OF_VOICE, 'content': 'Новые правила'}])
        datasets.select(first['id'])
        self.assertIsNone(storage.documents.load(checks.result('tone')))

    async def test_changing_accuracy_inputs_keeps_tone_result_when_switching_datasets(self):
        first = datasets.add([dialogue()], 'first.jsonl')
        storage.documents.save(checks.result('tone'), {'result': 'tone-first'})
        datasets.add([dialogue('d2')], 'second.jsonl')
        storage.documents.save('sources.json', [{'id': 'prompt', 'kind': 'prompt', 'content': 'Новый код'}])
        datasets.select(first['id'])
        self.assertEqual(storage.documents.load(checks.result('tone')), {'result': 'tone-first'})

    async def test_legacy_export_is_adopted_once_without_losing_its_stamp(self):
        storage.dialogues.replace([dialogue()], 'legacy.jsonl')
        before = storage.dialogues.meta()
        first, second = datasets.listed(), datasets.listed()
        self.assertEqual(first, second)
        self.assertEqual(first['datasets'][0]['total'], 1)
        self.assertEqual(storage.dialogues.meta()['updatedAt'], before['updatedAt'])

    async def test_archiving_preserves_evidence_and_can_be_undone(self):
        item = datasets.add([dialogue()], 'one.jsonl')
        datasets.archive(item['id'])
        self.assertEqual(datasets.listed()['datasets'], [])
        self.assertEqual(storage.datasets.page(item['id'], 0, 10), [dialogue()])
        datasets.archive(item['id'], undo=True)
        datasets.select(item['id'])
        self.assertEqual(storage.dialogues.ids(), ['d1'])

    async def test_any_dataset_is_read_without_becoming_the_one_the_checks_go_by(self):
        first = datasets.add([dialogue(), dialogue('d2', 'Второй вопрос')], 'one.jsonl', 'Первый')
        datasets.add([dialogue('d3')], 'two.jsonl', 'Второй')
        datasets.archive(first['id'])
        page = await self.client.get(f'/api/datasets/{first["id"]}/dialogues?offset=1&limit=5')
        self.assertEqual(page.status_code, 200, page.text)
        self.assertEqual(
            page.json(), {'total': 2, 'offset': 1, 'items': [{'id': 'd2', 'opening': 'Второй вопрос', 'turns': 2}]}
        )
        one = await self.client.get(f'/api/datasets/{first["id"]}/dialogues/d1')
        self.assertEqual(one.json(), dialogue())
        self.assertEqual(storage.dialogues.ids(), ['d3'])
        self.assertEqual((await self.client.get('/api/datasets/nope/dialogues')).status_code, 404)
        self.assertEqual((await self.client.get(f'/api/datasets/{first["id"]}/dialogues/d3')).status_code, 404)

    async def test_a_dataset_keeps_how_many_conversations_its_upload_left_out(self):
        agent_first = {'id': 'a1', 'messages': [{'role': 'assistant', 'content': 'Здравствуйте!'}]}
        body = '\n'.join(json.dumps(item, ensure_ascii=False) for item in (dialogue(), agent_first))
        response = await self.client.post('/api/logs?name=one.jsonl', content=body.encode())
        self.assertEqual(response.json(), {'total': 1, 'skipped': 1})
        listed = (await self.client.get('/api/datasets')).json()['datasets']
        self.assertEqual([(item['total'], item['skipped']) for item in listed], [(1, 1)])
        storage.dialogues.replace([dialogue('d2')], 'legacy.jsonl')
        self.assertIsNone(storage.datasets.get(storage.datasets.adopt_current())['skipped'])

    async def test_a_dataset_holds_the_version_of_the_agent_whose_answers_it_holds(self):
        """The version belongs to the dataset: given with its upload or on its page, trimmed, empty when nobody knows
        it, and listed with it. One longer than 80 characters, none at all, or a dataset that is not there is refused
        in words."""
        body = json.dumps(dialogue())
        response = await self.client.post('/api/logs?name=one.jsonl&agentVersion=%20v1.0%20', content=body)
        self.assertEqual(response.status_code, 200, response.text)
        await self.client.post('/api/logs?name=two.jsonl', content=body)
        listed = (await self.client.get('/api/datasets')).json()['datasets']
        self.assertEqual(
            [(item['name'], item['agentVersion']) for item in listed], [('two.jsonl', ''), ('one.jsonl', 'v1.0')]
        )
        dataset_id = listed[0]['id']
        for given, kept in ((' релиз 5 октября ', 'релиз 5 октября'), ('', '')):
            response = await self.client.post('/api/datasets/version', json={'id': dataset_id, 'agentVersion': given})
            self.assertEqual(response.status_code, 200, response.text)
            self.assertEqual(response.json()['agentVersion'], kept)
        self.assertEqual(storage.datasets.get(dataset_id)['agentVersion'], '')
        for given, refusal in (
            ({'id': dataset_id, 'agentVersion': 'v' * 81}, 'Версия агента должна быть не длиннее 80 символов.'),
            ({'id': dataset_id}, 'Укажите версию агента.'),
            ({'id': 'nope', 'agentVersion': 'v2'}, 'Датасет не найден.'),
        ):
            with self.subTest(given=given):
                response = await self.client.post('/api/datasets/version', json=given)
                self.assertEqual((response.status_code, response.json()['detail']), (400, refusal))
        too_long = await self.client.post(f'/api/logs?name=three.jsonl&agentVersion={"v" * 81}', content=body)
        self.assertEqual(too_long.status_code, 400)
        self.assertIn('Версия агента должна быть не длиннее 80 символов.', too_long.json()['detail'])
        self.assertEqual(len(datasets.listed()['datasets']), 2)

    async def test_a_conversation_longer_than_a_csv_cell_takes_by_default_is_read(self):
        """A CSV export with a reply longer than the 131 072 characters csv takes by default is read, not a 500."""
        long = 'Длинный ответ агента без переносов строк. ' * 4000
        body = f'id,role,content\nd1,user,Вопрос\nd1,assistant,"{long}"\n'
        response = await self.client.post('/api/logs?name=long.csv', content=body.encode())
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(storage.dialogues.read(['d1'])[0]['messages'][1]['content'], long.strip())

    async def test_uploaded_formats_are_real_and_invalid_import_keeps_the_active_dataset(self):
        for name, body in (
            ('one.json', json.dumps([dialogue()])),
            ('two.csv', 'id,role,content\nd2,user,Вопрос\nd2,assistant,Ответ\n'),
        ):
            response = await self.client.post(f'/api/logs?name={name}&title=Название', content=body)
            self.assertEqual(response.status_code, 200, response.text)
        before = storage.dialogues.meta()
        self.assertEqual(len(datasets.listed()['datasets']), 2)
        response = await self.client.post('/api/logs?name=broken.json', content='{')
        self.assertEqual(response.status_code, 400)
        self.assertEqual(storage.dialogues.meta(), before)
        self.assertEqual(export.prepare('single.json', json.dumps(dialogue()).encode()), [dialogue()])


class JudgeLibraryTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        support.serve(self)

    async def test_new_versions_do_not_mutate_old_criteria_and_can_be_selected_again(self):
        policy = 'Всегда обращайтесь к клиенту на вы.'
        first = judges.save('tone', 'Наши правила', policy, [criterion()], None, None)
        second = judges.save(
            'tone', 'Наши правила', policy, [criterion('Не используйте жаргон.')], first['setId'], first['id']
        )
        self.assertEqual(second['version'], 2)
        self.assertEqual(storage.judges.get(first['id'])['criteria'][0]['text'], criterion()['text'])
        judges.activate('tone', first['id'])
        self.assertEqual(
            storage.documents.load('tone-of-voice-criteria.json')['criteria'][0]['text'], criterion()['text']
        )
        self.assertIn('Не используйте жаргон.', judges.markdown(second['id']))
        with self.assertRaisesRegex(ValueError, 'уже изменён'):
            judges.save('tone', 'Наши правила', policy, [criterion()], first['setId'], first['id'])

    async def test_the_lab_offers_no_rules_of_its_own_and_custom_accuracy_is_available(self):
        for kind in ('tone', 'code'):
            listed = (await self.client.get(f'/api/judges/{kind}')).json()
            self.assertEqual(listed, {'versions': [], 'selectedId': None})
        policy = 'Отвечайте только по статьям базы знаний банка.'
        custom = judges.save('code', 'Точность команды', policy, [criterion()], None, None)
        self.assertEqual(storage.judges.active('code')['id'], custom['id'])
        self.assertTrue(any(s['id'] == 'accuracy-judge' for s in storage.documents.load('sources.json')))
        listed = (await self.client.get('/api/judges/code')).json()
        self.assertEqual([version['id'] for version in listed['versions']], [custom['id']])
        self.assertIs(listed['versions'][0]['builtin'], False)
        judges.activate('code', None)
        self.assertIsNone(storage.judges.active('code'))

    async def test_rule_sets_an_earlier_lab_wrote_itself_count_as_none(self):
        """A database may hold the rule sets an earlier Lab wrote itself, selected and copied into the agent's inputs:
        none is offered, found or in force. Tone of voice asks for the person's own rules; accuracy, given no set,
        judges by the agent's code again, without the copied rules."""
        policy = 'Правила, которые написал разработчик Lab, а не банк.'
        written = [
            {
                'id': f'lab-{kind}',
                'setId': f'lab-{kind}-set',
                'kind': kind,
                'name': 'Набор Lab',
                'policy': policy,
                'criteria': [criterion()],
                'builtin': True,
                'version': 1,
                'createdAt': '2026-10-07T08:00:00+00:00',
            }
            for kind in ('tone', 'code')
        ]
        storage.documents.save(storage.judges.LIBRARY, written)
        storage.documents.save('sources.json', [rules.source(kind, 'Набор Lab', policy) for kind in ('tone', 'code')])
        storage.documents.save('tone-of-voice-criteria.json', {'revision': 'lab-tone', 'criteria': [criterion()]})
        storage.documents.save(checks.result('code'), {'checkId': 'judged-by-lab-rules'})
        for kind in ('tone', 'code'):
            storage.judges.select(kind, f'lab-{kind}')
        for kind in ('tone', 'code'):
            with self.subTest(kind=kind):
                self.assertEqual(judges.library(kind), {'versions': [], 'selectedId': None})
                self.assertIsNone(storage.judges.active(kind))
                self.assertIsNone(storage.judges.get(f'lab-{kind}'))
                with self.assertRaisesRegex(ValueError, 'не найден'):
                    judges.activate(kind, f'lab-{kind}')
        judges.activate('code', None)  # «Критерии из кода агента», as a launch of Точность without a set
        self.assertNotIn('accuracy-judge', [source['id'] for source in storage.documents.load('sources.json')])
        self.assertIsNone(storage.documents.load(checks.result('code')))
        mine = judges.save('code', 'Точность команды', policy, [criterion()], 'lab-code-set', 'lab-code')
        self.assertEqual((mine['version'], mine['builtin']), (1, False))
        self.assertEqual([version['id'] for version in storage.judges.listed('code')], [mine['id']])

    async def test_criteria_made_before_the_library_keep_the_day_they_were_made(self):
        """Criteria of tone of voice made before the library are adopted as its first version, dated when they were
        made; a version a person saves later is dated when it is saved."""
        made = '2026-10-05T09:30:00.000+00:00'
        policy = rules.source('tone', 'Правила общения банка', 'Всегда обращайтесь к клиенту на вы.')
        storage.documents.save('sources.json', [policy])
        storage.documents.save(
            'tone-of-voice-criteria.json',
            {'revision': 'r1', 'createdAt': made, 'sourceSha256': policy['sha256'], 'criteria': [criterion()]},
        )
        listed = (await self.client.get('/api/judges/tone')).json()
        adopted = listed['versions'][0]
        self.assertEqual((len(listed['versions']), listed['selectedId']), (1, adopted['id']))
        self.assertEqual(adopted['createdAt'], made)
        later = judges.save(
            'tone', adopted['name'], policy['content'], [criterion('Не используйте жаргон.')], adopted['setId'], None
        )
        self.assertEqual(later['version'], 2)
        self.assertGreater(later['createdAt'], made)

    async def test_an_updated_document_under_the_same_name_is_the_next_version_of_its_set(self):
        """The bank's document of rules is updated and its criteria collected again under the same name: the set it
        made gets its next version, never a second set of that name; rules under another name make a set of their
        own."""
        first = rules.source('tone', 'tov.docx', 'Всегда обращайтесь к клиенту на вы.')
        storage.documents.save('sources.json', [first])
        draft = {
            'revision': 'r1',
            'createdAt': storage.now(),
            'sourceSha256': first['sha256'],
            'criteria': [criterion()],
        }
        v1 = storage.judges.capture_tone(draft, first)
        updated = rules.source('tone', 'tov.docx', 'Всегда обращайтесь к клиенту на вы. Не используйте жаргон.')
        v2 = storage.judges.capture_tone(draft | {'criteria': [criterion('Не используйте жаргон.')]}, updated)
        self.assertEqual((v2['setId'], v2['version'], v2['name']), (v1['setId'], 2, 'tov.docx'))
        other = rules.source('tone', 'Правила чата', 'Отвечайте коротко и по делу, без канцелярита.')
        v3 = storage.judges.capture_tone(draft | {'criteria': [criterion('Коротко.')]}, other)
        self.assertNotEqual(v3['setId'], v1['setId'])
        self.assertEqual(v3['version'], 1)

    async def test_an_updated_document_given_on_the_screens_is_the_next_version_of_its_set(self):
        """The rules replaced on «Критерии» with the bank's document updated under the same name: the new text deselects
        the set in force first (inputs.replace_sources), and the criteria collected from it are still the next version
        of that set, not a second set of the same name."""
        first = rules.source('tone', 'tov.docx', 'Всегда обращайтесь к клиенту на вы.')
        storage.documents.save('sources.json', [first])
        made = storage.now()
        draft = {'revision': 'r1', 'createdAt': made, 'sourceSha256': first['sha256'], 'criteria': [criterion()]}
        v1 = storage.judges.capture_tone(draft, first)
        updated = rules.source('tone', 'tov.docx', 'Всегда обращайтесь к клиенту на вы. Не используйте жаргон.')
        inputs.replace_sources([updated])
        self.assertIsNone(storage.judges.active('tone'))
        v2 = storage.judges.capture_tone(draft | {'criteria': [criterion('Не используйте жаргон.')]}, updated)
        self.assertEqual((v2['setId'], v2['version'], v2['name']), (v1['setId'], 2, 'tov.docx'))
        self.assertEqual([v['setId'] for v in storage.judges.listed('tone')], [v1['setId']] * 2)

    async def test_rules_saved_as_they_were_stay_the_rules_the_checks_went_by(self):
        """«Изменить критерии» sends every criterion back with the fields its form fills in (empty clarifications). A
        set renamed keeps its criteria the very same records, its revision and its result, so the next check compares
        with the ones before and the answers carry over; one criterion edited changes that one alone."""
        policy = 'Всегда обращайтесь к клиенту на вы. Не используйте жаргон в ответах.'
        two = [criterion(), criterion('Не используйте жаргон в ответах.') | {'id': 'r2', 'name': 'Жаргон'}]
        judges.save('tone', 'Правила', policy, two, None, None)
        before = storage.documents.load(tone.DRAFT)
        storage.documents.save(checks.result('tone'), {'checkId': 'c1'})
        current = (await self.client.get('/api/judges/tone')).json()['versions'][0]
        body = {'policy': policy, 'setId': current['setId']}
        renamed = await self.client.post(
            '/api/judges/tone',
            json=body | {'name': 'Правила банка', 'criteria': current['criteria'], 'baseId': current['id']},
        )
        self.assertEqual(renamed.status_code, 200, renamed.text)
        after = storage.documents.load(tone.DRAFT)
        self.assertEqual((after['criteria'], after['revision']), (before['criteria'], before['revision']))
        self.assertEqual(storage.documents.load(checks.result('tone')), {'checkId': 'c1'})
        edited = [current['criteria'][0] | {'text': 'Обращайтесь к клиенту только на вы.'}, current['criteria'][1]]
        response = await self.client.post(
            '/api/judges/tone',
            json=body | {'name': 'Правила банка', 'criteria': edited, 'baseId': renamed.json()['id']},
        )
        self.assertEqual(response.status_code, 200, response.text)
        final = storage.documents.load(tone.DRAFT)['criteria']
        self.assertEqual(final[1], before['criteria'][1])
        self.assertNotEqual(final[0], before['criteria'][0])
        self.assertIsNone(storage.documents.load(checks.result('tone')))

    async def test_the_library_asked_twice_at_once_adopts_the_criteria_once(self):
        """The screens ask for the library twice at once on their first look after the update: the criteria made
        before the library become one version, not one per request."""
        policy = rules.source('tone', 'Правила общения банка', 'Всегда обращайтесь к клиенту на вы.')
        storage.documents.save('sources.json', [policy])
        storage.documents.save(
            'tone-of-voice-criteria.json',
            {'revision': 'r1', 'createdAt': storage.now(), 'sourceSha256': policy['sha256'], 'criteria': [criterion()]},
        )
        await asyncio.gather(*(asyncio.to_thread(judges.library, 'tone') for _ in range(6)))
        self.assertEqual(len(storage.judges.listed('tone')), 1)

    async def test_long_conditions_and_exceptions_of_a_rubric_can_be_saved(self):
        """A bank's rubric puts a whole section of principles into what is acceptable: «Изменить критерии» saves it."""
        principles = 'Не считай нарушением юридически значимые формулировки. ' * 120
        body = {
            'name': 'Рубрика банка',
            'policy': 'Всегда обращайтесь к клиенту на вы. ' + principles,
            'criteria': [criterion() | {'acceptable': principles, 'condition': principles}],
        }
        self.assertGreater(len(principles), 5000)
        response = await self.client.post('/api/judges/tone', json=body)
        self.assertEqual(response.status_code, 200, response.text)

    async def test_the_knowledge_base_is_asked_over_https_but_on_this_computer(self):
        """The key and the certificate of the knowledge base go with every request to it."""
        with self.assertRaisesRegex(ValueError, 'https://'):
            agent_context.save({'idpUrl': 'http://idp.bank.test/search'})
        for url in ('https://idp.bank.test/search', 'http://localhost:8080/search', 'http://127.0.0.1:9000'):
            with self.subTest(url=url):
                self.assertEqual(agent_context.save({'idpUrl': url})['idpUrl'], url)

    async def test_git_never_asks_in_the_labs_terminal(self):
        """A clone or a fetch asks for no password or passphrase and takes no unknown host: ssh in batch mode."""
        process = AsyncMock()
        process.communicate.return_value = (b'', b'')
        process.returncode = 0
        with (
            patch.dict(os.environ),
            patch('asyncio.create_subprocess_exec', AsyncMock(return_value=process)) as started,
        ):
            os.environ.pop('GIT_SSH_COMMAND', None)  # a person's own ssh command for git would be kept
            await agent_context._git(['git', 'fetch'])
        options = started.await_args.kwargs
        self.assertEqual(options['stdin'], asyncio.subprocess.DEVNULL)
        self.assertEqual(options['env']['GIT_TERMINAL_PROMPT'], '0')
        self.assertIn('BatchMode=yes', options['env']['GIT_SSH_COMMAND'])

    async def test_failed_rule_save_is_atomic_and_export_is_the_selected_version(self):
        policy = 'Всегда обращайтесь к клиенту на вы.'
        mine = judges.save('tone', 'Наши правила', policy, [criterion()], None, None)
        response = await self.client.post('/api/judges/tone/select', json={'id': mine['id']})
        self.assertEqual(response.status_code, 200)
        before = storage.documents.load('tone-of-voice-criteria.json')
        response = await self.client.post(
            '/api/judges/tone',
            json={
                'name': 'Новые',
                'policy': policy,
                'criteria': [criterion(), criterion()],
            },
        )
        self.assertEqual(response.status_code, 400)
        self.assertEqual(storage.documents.load('tone-of-voice-criteria.json'), before)
        download = await self.client.get(f'/api/judge-versions/{mine["id"]}/download')
        self.assertIn(policy, download.text)
        self.assertIn('Обращение', download.text)

    async def test_secrets_in_repository_or_idp_urls_are_not_saved_into_versions(self):
        for key in ('repositoryUrl', 'idpUrl'):
            with self.subTest(key=key), self.assertRaises(ValueError):
                agent_context.save({key: 'https://secret-token@example.test/project'})
        self.assertEqual(agent_context.current()['repositoryUrl'], '')
        self.assertEqual(agent_context.current()['idpUrl'], '')

    async def test_a_saved_repository_is_the_agents_code_only_once_it_is_cloned(self):
        """Until its repository is cloned (or when the clone failed), the agent's code is in the folder of the settings,
        never in an empty folder kept for the clone."""
        connection.save_settings({'repo': '~/agents/bank'})
        agent_context.save({'repositoryUrl': 'https://git.example.test/bank/agent.git'})
        self.assertEqual(connection.repo(), Path('~/agents/bank').expanduser())
        (agent_context.checkout_path() / '.git').mkdir(parents=True)
        self.assertEqual(connection.repo(), agent_context.checkout_path())

    async def test_agent_rename_preserves_its_identity_and_database(self):
        agent = storage.registry.create('Первый', '')
        with storage.registry.using(agent['id']):
            storage.dialogues.replace([dialogue()])
        response = await self.client.post(
            '/api/agents/update',
            json={
                'id': agent['id'],
                'name': 'Новое имя',
                'description': 'Описание',
            },
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()['id'], agent['id'])
        with storage.registry.using(agent['id']):
            self.assertEqual(storage.dialogues.ids(), ['d1'])
