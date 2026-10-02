import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import nodemailer, { type Transporter } from 'nodemailer';
import { AppConfig } from '../config/app-config.js';
import { PrismaService } from '../prisma/prisma.service.js';

interface OutboxRow {
  id: string;
  dedupKey: string;
  toEmail: string;
  subject: string;
  body: string;
  attempts: number;
}

const MAX_ATTEMPTS = 5;

/**
 * Отправитель писем из outbox.
 *
 * «Каждое письмо уходит ровно один раз»:
 *  - запись создаётся в той же транзакции, что и событие (переход заказа, окончание распродажи),
 *    а unique(dedup_key) не даёт создать вторую на то же событие;
 *  - запись захватывается FOR UPDATE SKIP LOCKED — два отправителя (два инстанса, два тика) одну запись не возьмут;
 *  - отправка в SMTP и пометка SENT — внутри той же транзакции, что держит блокировку.
 * Честная оговорка: если процесс упадёт ровно между ответом SMTP «250 OK» и commit, запись останется PENDING
 * и уйдёт повторно (at-least-once на этом узком окне). Exactly-once поверх SMTP невозможен в принципе;
 * окно смягчает детерминированный Message-ID (<dedup_key@flash-sale.local>), по которому почтовые системы
 * и клиенты распознают дубль.
 */
@Injectable()
export class MailService implements OnModuleDestroy {
  private readonly log = new Logger(MailService.name);
  private readonly transport: Transporter;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfig,
  ) {
    this.transport = nodemailer.createTransport({
      host: config.smtpHost,
      port: config.smtpPort,
      secure: false,
      ignoreTLS: true,
      connectionTimeout: 5000,
      socketTimeout: 10_000,
    });
  }

  onModuleDestroy() {
    this.transport.close();
  }

  /** Шаг воркера: отправить до `limit` писем. Возвращает, сколько отправлено. */
  async sendDue(limit = 20): Promise<number> {
    let sent = 0;
    for (let i = 0; i < limit; i++) {
      const result = await this.sendOne();
      if (result === 'sent') sent++;
      // пусто — всё отправлено; ошибка — SMTP, скорее всего, недоступен: попробуем на следующем тике
      else break;
    }
    return sent;
  }

  private sendOne(): Promise<'sent' | 'failed' | 'empty'> {
    return this.prisma.$transaction(
      async (tx) => {
        const rows = await tx.$queryRaw<OutboxRow[]>`
          SELECT id, dedup_key AS "dedupKey", to_email AS "toEmail", subject, body, attempts
            FROM email_outbox
           WHERE status = 'PENDING'
           ORDER BY created_at
           LIMIT 1
           FOR UPDATE SKIP LOCKED`;
        const mail = rows[0];
        if (!mail) return 'empty' as const;

        try {
          await this.transport.sendMail({
            from: this.config.mailFrom,
            to: mail.toEmail,
            subject: mail.subject,
            text: mail.body,
            messageId: `<${mail.dedupKey.replaceAll(':', '.')}@flash-sale.local>`,
          });
        } catch (error) {
          const attempts = mail.attempts + 1;
          await tx.$executeRaw`
            UPDATE email_outbox
               SET attempts = ${attempts}, last_error = ${(error as Error).message},
                   status = CASE WHEN ${attempts} >= ${MAX_ATTEMPTS} THEN 'FAILED'::"EmailStatus" ELSE status END
             WHERE id = ${mail.id}::uuid`;
          this.log.warn(`email ${mail.dedupKey} failed (attempt ${attempts}): ${(error as Error).message}`);
          return 'failed' as const;
        }

        await tx.$executeRaw`
          UPDATE email_outbox SET status = 'SENT', sent_at = now(), attempts = attempts + 1
           WHERE id = ${mail.id}::uuid`;
        return 'sent' as const;
      },
      { timeout: 20_000 },
    );
  }
}
