import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export type Scenario = 'SUCCESS' | 'DECLINE' | 'HANG';
export type PaymentStatus = 'processing' | 'succeeded' | 'declined';

export interface Payment {
  id: string;
  idempotencyKey: string;
  amountCents: number;
  description: string;
  scenario: Scenario;
  status: PaymentStatus;
  callbackUrl: string;
  createdAt: string;
  resolvedAt: string | null;
  webhook: {
    deliveries: number;
    lastStatus: number | 'network_error' | null;
    lastAttemptAt: string | null;
    delivered: boolean;
    /** Повторы исчерпаны; повторить можно вручную из панели */
    gaveUp: boolean;
  };
}

export interface StoreOptions {
  /** JSON-файл с платежами; null — только память (для тестов) */
  filePath: string | null;
  /**
   * Сколько хранить завершённые платежи (и их ключи идемпотентности). Как у настоящих провайдеров
   * (у Stripe — 24 часа): повтор с тем же ключом в этом окне вернёт тот же платёж.
   * Висящие (processing) платежи не удаляются никогда.
   */
  retentionMs: number;
  now?: () => number;
}

interface FileFormat {
  version: 1;
  payments: Payment[];
}

/**
 * Хранилище платежей заглушки. Платёж записывается на диск ДО ответа «принят», поэтому
 * рестарт заглушки его не теряет: после рестарта тот же id, тот же ключ идемпотентности, тот же статус.
 * Запись атомарная: во временный файл, затем rename (атомарен в пределах одной ФС) —
 * если процесс упадёт посреди записи, на диске останется прежняя целая версия.
 */
export class PaymentStore {
  private readonly byId = new Map<string, Payment>();
  private readonly byKey = new Map<string, string>();
  private readonly now: () => number;
  private readonly opts: StoreOptions;

  constructor(opts: StoreOptions) {
    this.opts = opts;
    this.now = opts.now ?? Date.now;
    this.load();
  }

  /**
   * Идемпотентность: тот же ключ → тот же платёж, второго списания нет.
   * Возвращает [платёж, создан_ли_сейчас].
   */
  create(
    input: Omit<Payment, 'id' | 'status' | 'createdAt' | 'resolvedAt' | 'webhook'>,
  ): [Payment, boolean] {
    const existingId = this.byKey.get(input.idempotencyKey);
    if (existingId) return [this.byId.get(existingId)!, false];

    const payment: Payment = {
      ...input,
      id: `pay_${randomUUID().replaceAll('-', '').slice(0, 20)}`,
      status: 'processing',
      createdAt: new Date(this.now()).toISOString(),
      resolvedAt: null,
      webhook: { deliveries: 0, lastStatus: null, lastAttemptAt: null, delivered: false, gaveUp: false },
    };
    this.byId.set(payment.id, payment);
    this.byKey.set(payment.idempotencyKey, payment.id);
    try {
      this.save();
    } catch (error) {
      // не смогли сохранить — значит, платёж не принят: откатываем и отдаём ошибку клиенту
      this.byId.delete(payment.id);
      this.byKey.delete(payment.idempotencyKey);
      throw error;
    }
    return [payment, true];
  }

  get(id: string): Payment | undefined {
    return this.byId.get(id);
  }

  findByKey(key: string): Payment | undefined {
    const id = this.byKey.get(key);
    return id ? this.byId.get(id) : undefined;
  }

  list(): Payment[] {
    return [...this.byId.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** Разрешить платёж один раз; повторное разрешение — false (результат уже зафиксирован). */
  resolve(id: string, status: 'succeeded' | 'declined'): boolean {
    const p = this.byId.get(id);
    if (!p || p.status !== 'processing') return false;
    p.status = status;
    p.resolvedAt = new Date(this.now()).toISOString();
    this.save();
    return true;
  }

  /** Сохранить текущее состояние (вызывается и после каждой попытки доставки webhook). */
  save(): void {
    if (!this.opts.filePath) return;
    this.prune();
    const data: FileFormat = { version: 1, payments: [...this.byId.values()] };
    const tmp = `${this.opts.filePath}.tmp`;
    mkdirSync(dirname(this.opts.filePath), { recursive: true });
    writeFileSync(tmp, JSON.stringify(data));
    renameSync(tmp, this.opts.filePath);
  }

  private load(): void {
    const file = this.opts.filePath;
    if (!file || !existsSync(file)) return;
    const data = JSON.parse(readFileSync(file, 'utf8')) as FileFormat;
    for (const p of data.payments) {
      p.webhook.gaveUp ??= false; // файлы старого формата
      this.byId.set(p.id, p);
      this.byKey.set(p.idempotencyKey, p.id);
    }
  }

  /** Убрать завершённые платежи старше окна хранения (висящие не трогаем никогда). */
  private prune(): void {
    const cutoff = this.now() - this.opts.retentionMs;
    for (const p of this.byId.values()) {
      const finished = p.status !== 'processing' && (p.webhook.delivered || p.webhook.gaveUp);
      if (finished && p.resolvedAt && Date.parse(p.resolvedAt) < cutoff) {
        this.byId.delete(p.id);
        this.byKey.delete(p.idempotencyKey);
      }
    }
  }
}
