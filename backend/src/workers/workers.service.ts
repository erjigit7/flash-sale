import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { AppConfig } from '../config/app-config.js';
import { ReservationsService } from '../reservations/reservations.service.js';

/**
 * Фоновые циклы в процессе бэкенда. Каждый шаг идемпотентен и безопасен при нескольких
 * инстансах (условные UPDATE + FOR UPDATE SKIP LOCKED), поэтому лишний запуск ничего не ломает.
 * В e2e-тестах выключены (WORKERS_ENABLED=false): тесты вызывают шаги напрямую.
 */
@Injectable()
export class WorkersService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly log = new Logger(WorkersService.name);
  private readonly timers: NodeJS.Timeout[] = [];

  constructor(
    private readonly config: AppConfig,
    private readonly reservations: ReservationsService,
  ) {}

  onApplicationBootstrap() {
    if (!this.config.workersEnabled) {
      this.log.log('background workers disabled');
      return;
    }
    // Раз в секунду: «не оплатил за 10 минут — вернулся на витрину, и остальные видят это сразу»
    this.every('hold-expirer', 1000, () => this.reservations.expireDue());
  }

  onApplicationShutdown() {
    for (const t of this.timers) clearInterval(t);
  }

  /** Цикл без наложений: если прошлый шаг ещё идёт, очередной тик пропускается. */
  private every(name: string, intervalMs: number, step: () => Promise<unknown>) {
    let running = false;
    const timer = setInterval(() => {
      if (running) return;
      running = true;
      step()
        .catch((error: unknown) => this.log.error(`${name} failed`, error instanceof Error ? error.stack : error))
        .finally(() => {
          running = false;
        });
    }, intervalMs);
    timer.unref();
    this.timers.push(timer);
  }
}
