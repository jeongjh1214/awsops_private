import asyncio
import unittest

from agent.private_runtime.config import AgentConfig
from agent.private_runtime.limits import RuntimeLimits


class RuntimeLimitsTests(unittest.TestCase):
    def test_steampipe_limit_blocks_extra_work(self):
        async def scenario():
            limits = RuntimeLimits(AgentConfig(max_concurrent_steampipe_queries=1))
            entered = []
            first_entered = asyncio.Event()
            release_first = asyncio.Event()
            second_entered = asyncio.Event()

            async def first_work():
                async with limits.steampipe:
                    entered.append("first")
                    first_entered.set()
                    await release_first.wait()

            async def second_work():
                async with limits.steampipe:
                    entered.append("second")
                    second_entered.set()

            first = asyncio.create_task(first_work())
            await first_entered.wait()
            second = asyncio.create_task(second_work())
            await asyncio.sleep(0)

            self.assertFalse(second_entered.is_set())
            self.assertEqual(entered, ["first"])

            release_first.set()
            await asyncio.gather(first, second)
            return entered

        self.assertEqual(asyncio.run(scenario()), ["first", "second"])

    def test_rejects_zero_or_negative_concurrency_limits(self):
        cases = [
            ("max_concurrent_bedrock_calls", 0),
            ("max_concurrent_aws_calls", -1),
            ("max_concurrent_steampipe_queries", 0),
        ]

        for field_name, value in cases:
            with self.subTest(field_name=field_name):
                with self.assertRaisesRegex(ValueError, field_name):
                    RuntimeLimits(AgentConfig(**{field_name: value}))


if __name__ == "__main__":
    unittest.main()
