import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * Ошибка предметной области с машинным кодом: клиент показывает текст по коду
 * (например, sold_out → «Закончилось»), а не парсит сообщение.
 */
export class AppError extends HttpException {
  constructor(
    status: HttpStatus,
    readonly code: string,
    message: string,
    extra: Record<string, unknown> = {},
  ) {
    super({ error: code, message, ...extra }, status);
  }
}
