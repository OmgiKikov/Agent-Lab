import asyncio
import unittest

from lab import agents


class FakeAgent:
    def __init__(self) -> None:
        self.events = []
        self.open_error = None
        self.close_error = None
        self.closing = asyncio.Event()
        self.release_close = asyncio.Event()
        self.release_close.set()

    async def open(self) -> None:
        self.events.append('open')
        if self.open_error is not None:
            raise self.open_error

    async def close(self) -> None:
        self.events.append('closing')
        self.closing.set()
        await self.release_close.wait()
        self.events.append('closed')
        if self.close_error is not None:
            raise self.close_error


class AgentSessionTests(unittest.IsolatedAsyncioTestCase):
    async def test_session_opens_yields_and_closes_the_same_agent(self) -> None:
        agent = FakeAgent()
        async with agents.session(agent) as opened:
            self.assertIs(opened, agent)
            agent.events.append('conversation')
        self.assertEqual(agent.events, ['open', 'conversation', 'closing', 'closed'])

    async def test_partially_failed_open_still_closes_acquired_resource(self) -> None:
        agent = FakeAgent()
        agent.open_error = agents.AgentError('process started, health failed')
        with self.assertRaisesRegex(agents.AgentError, 'health failed'):
            async with agents.session(agent):
                self.fail('An agent that failed to open must not be yielded')
        self.assertEqual(agent.events, ['open', 'closing', 'closed'])

    async def test_close_failure_propagates_after_conversation(self) -> None:
        agent = FakeAgent()
        agent.close_error = RuntimeError('cannot close process')
        with self.assertRaisesRegex(RuntimeError, 'cannot close process'):
            async with agents.session(agent):
                agent.events.append('conversation')
        self.assertEqual(agent.events, ['open', 'conversation', 'closing', 'closed'])

    async def test_cancelled_conversation_waits_for_cleanup_before_propagating(self) -> None:
        agent = FakeAgent()
        agent.release_close.clear()
        entered = asyncio.Event()

        async def conversation() -> None:
            async with agents.session(agent):
                entered.set()
                await asyncio.Event().wait()

        task = asyncio.create_task(conversation())
        await entered.wait()
        task.cancel()
        await agent.closing.wait()
        self.assertFalse(task.done())
        agent.release_close.set()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertEqual(agent.events[-1], 'closed')

    async def test_repeated_cancellation_during_close_does_not_interrupt_cleanup(self) -> None:
        agent = FakeAgent()
        agent.release_close.clear()

        async def conversation() -> None:
            async with agents.session(agent):
                agent.events.append('conversation')

        task = asyncio.create_task(conversation())
        await agent.closing.wait()
        for _ in range(3):
            task.cancel()
            await asyncio.sleep(0)
            self.assertFalse(task.done())
        agent.release_close.set()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertEqual(agent.events, ['open', 'conversation', 'closing', 'closed'])

    async def test_cleanup_failure_does_not_replace_user_cancellation(self) -> None:
        agent = FakeAgent()
        agent.close_error = RuntimeError('cleanup failed')
        entered = asyncio.Event()

        async def conversation() -> None:
            async with agents.session(agent):
                entered.set()
                await asyncio.Event().wait()

        task = asyncio.create_task(conversation())
        await entered.wait()
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertEqual(agent.events[-1], 'closed')
