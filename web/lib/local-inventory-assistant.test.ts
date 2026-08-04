import { beforeEach, describe, expect, it, vi } from 'vitest';

const shouldUseLocalSqlitePool = vi.fn();
const query = vi.fn();

vi.mock('./db', () => ({
  shouldUseLocalSqlitePool: () => shouldUseLocalSqlitePool(),
  getPool: () => ({ query }),
}));

import { answerLocalInventoryPrompt } from './local-inventory-assistant';

beforeEach(() => {
  shouldUseLocalSqlitePool.mockReset().mockReturnValue(true);
  query.mockReset().mockResolvedValue({
    rows: [
      {
        resource_id: 'i-001',
        region: 'ap-northeast-2',
        account_id: '123456789012',
        captured_at: '2026-08-04T01:00:00.000Z',
        data: { name: 'web-1', instance_state: 'running', instance_type: 't3.micro' },
      },
      {
        resource_id: 'i-002',
        region: 'ap-northeast-2',
        account_id: '123456789012',
        captured_at: '2026-08-04T01:00:00.000Z',
        data: { name: 'batch-1', instance_state: 'stopped', instance_type: 'm6i.large' },
      },
    ],
  });
});

describe('answerLocalInventoryPrompt', () => {
  it('answers EC2 inventory status from local SQLite', async () => {
    const answer = await answerLocalInventoryPrompt('ec2 리소스 현황 알려줘', 'ko');

    expect(query).toHaveBeenCalledWith(expect.stringContaining('FROM inventory_resources'), ['ec2', 500, 0]);
    expect(answer).toContain('EC2 리소스는 총 2개');
    expect(answer).toContain('running: 1');
    expect(answer).toContain('stopped: 1');
    expect(answer).toContain('web-1');
  });

  it('does not intercept non-local mode', async () => {
    shouldUseLocalSqlitePool.mockReturnValue(false);

    await expect(answerLocalInventoryPrompt('ec2 리소스 현황 알려줘', 'ko')).resolves.toBeNull();
    expect(query).not.toHaveBeenCalled();
  });
});
