import asyncio
import unittest

from agent.private_runtime.config import AgentConfig
from agent.private_runtime.limits import RuntimeLimits


class RuntimeLimitsTests(unittest.TestCase):
    def test_steampipe_limit_blocks_extra_work(self):
        async def scenario():
            limits = RuntimeLimits(AgentConfig(max_concurrent_steampipe_queries=1))
            entered = []

            async def work(name):
                async with limits.steampipe:
                    entered.append(name)
                    await asyncio.sleep(0.05)

            first = asyncio.create_task(work("first"))
            await asyncio.sleep(0.01)
            second = asyncio.create_task(work("second"))
            await asyncio.gather(first, second)
            return entered

        self.assertEqual(asyncio.run(scenario()), ["first", "second"])


if __name__ == "__main__":
    unittest.main()
