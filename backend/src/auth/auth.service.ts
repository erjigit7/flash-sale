import { HttpStatus, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { timingSafeEqual } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service.js';
import { AppConfig } from '../config/app-config.js';
import { AppError } from '../common/app-error.js';
import { SHOP_EMAIL } from './auth.constants.js';
import type { JwtPayload } from './auth.types.js';

type UserRow = { id: string; email: string; name: string; role: 'BUYER' | 'SHOP' };

/**
 * Демо-вход (согласован с заказчиком): покупатель входит по email без пароля —
 * email нужен, чтобы получать письма о заказах. Экран магазина закрыт паролем из env.
 */
@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: AppConfig,
  ) {}

  async loginBuyer(rawEmail: string, rawName?: string) {
    const email = rawEmail.trim().toLowerCase();
    if (email === SHOP_EMAIL) {
      throw new AppError(HttpStatus.FORBIDDEN, 'use_shop_login', 'Для магазина используйте вход по паролю');
    }
    const name = rawName?.trim() || email.split('@')[0];
    const user = await this.prisma.user.upsert({
      where: { email },
      update: {},
      create: { email, name, role: 'BUYER' },
    });
    return this.issue(user);
  }

  async loginShop(password: string) {
    if (!safeEqual(password, this.config.shopPassword)) {
      throw new AppError(HttpStatus.UNAUTHORIZED, 'bad_password', 'Неверный пароль магазина');
    }
    const user = await this.prisma.user.upsert({
      where: { email: SHOP_EMAIL },
      update: { role: 'SHOP' },
      create: { email: SHOP_EMAIL, name: 'Магазин', role: 'SHOP' },
    });
    return this.issue(user);
  }

  private async issue(user: UserRow) {
    const payload: JwtPayload = { sub: user.id, email: user.email, role: user.role };
    const token = await this.jwt.signAsync(payload);
    return { token, user: { id: user.id, email: user.email, name: user.name, role: user.role } };
  }
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
