import { strict as assert } from 'node:assert';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { PaymentStore } from './store.ts';

/** «Рестарт» = новый экземпляр хранилища поверх того же файла. */
describe('PaymentStore: платежи переживают рестарт заглушки', () => {
  let dir: string;
  let file: string;
  const DAY = 24 * 3600_000;
  const input = (key: string) => ({
    idempotencyKey: key,
    amountCents: 4990_00,
    description: 'test',
    scenario: 'HANG' as const,
    callbackUrl: 'http://backend/webhook',
  });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'stub-store-'));
    file = join(dir, 'payments.json');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('после рестарта тот же платёж: тот же id, статус, и повтор с тем же ключом не создаёт второй', () => {
    const before = new PaymentStore({ filePath: file, retentionMs: DAY });
    const [created, isNew] = before.create(input('order-1'));
    assert.equal(isNew, true);

    const after = new PaymentStore({ filePath: file, retentionMs: DAY });
    assert.deepEqual(after.get(created.id), created);
    const [again, isNewAgain] = after.create(input('order-1'));
    assert.equal(isNewAgain, false);
    assert.equal(again.id, created.id);
    assert.equal(after.list().length, 1);
  });

  it('решение по платежу сохраняется; повторно разрешить после рестарта нельзя', () => {
    const before = new PaymentStore({ filePath: file, retentionMs: DAY });
    const [p] = before.create(input('order-2'));
    assert.equal(before.resolve(p.id, 'succeeded'), true);

    const after = new PaymentStore({ filePath: file, retentionMs: DAY });
    assert.equal(after.get(p.id)?.status, 'succeeded');
    assert.equal(after.resolve(p.id, 'declined'), false);
    assert.equal(after.get(p.id)?.status, 'succeeded');
  });

  it('висящий платёж после рестарта остаётся висеть и разрешается как обычно', () => {
    const before = new PaymentStore({ filePath: file, retentionMs: DAY });
    const [p] = before.create(input('order-3'));

    const after = new PaymentStore({ filePath: file, retentionMs: DAY });
    assert.equal(after.get(p.id)?.status, 'processing');
    assert.equal(after.resolve(p.id, 'declined'), true);
  });

  it('запись атомарная: на диске валидный JSON, временный файл не остаётся', () => {
    const store = new PaymentStore({ filePath: file, retentionMs: DAY });
    for (let i = 0; i < 20; i++) store.create(input(`order-${i}`));
    const data = JSON.parse(readFileSync(file, 'utf8')) as { version: number; payments: unknown[] };
    assert.equal(data.version, 1);
    assert.equal(data.payments.length, 20);
    assert.equal(existsSync(`${file}.tmp`), false);
  });

  it('окно хранения: старые завершённые удаляются, висящие — никогда', () => {
    let now = Date.parse('2026-10-01T00:00:00Z');
    const store = new PaymentStore({ filePath: file, retentionMs: DAY, now: () => now });
    const [done] = store.create(input('done'));
    const [hung] = store.create(input('hung'));
    store.resolve(done.id, 'succeeded');
    store.get(done.id)!.webhook.delivered = true;

    now += 2 * DAY;
    store.save();

    const after = new PaymentStore({ filePath: file, retentionMs: DAY, now: () => now });
    assert.equal(after.get(done.id), undefined);
    assert.equal(after.get(hung.id)?.status, 'processing');
  });

  it('без файла (только память) тоже работает', () => {
    const store = new PaymentStore({ filePath: null, retentionMs: DAY });
    const [p] = store.create(input('mem'));
    assert.equal(store.findByKey('mem')?.id, p.id);
  });
});
