import {
  CanActivate,
  ExecutionContext,
  HttpStatus,
  Injectable,
  SetMetadata,
  createParamDecorator,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';
import { AppError } from '../common/app-error.js';
import type { AuthUser, JwtPayload } from './auth.types.js';

const ROLES_KEY = 'roles';
/** Ограничить эндпоинт ролями (без декоратора — любой вошедший пользователь). */
export const Roles = (...roles: AuthUser['role'][]) => SetMetadata(ROLES_KEY, roles);

type AuthedRequest = Request & { user?: AuthUser };

export function bearerToken(header: string | undefined): string | undefined {
  const [scheme, token] = (header ?? '').split(' ');
  return scheme === 'Bearer' && token ? token : undefined;
}

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const token = bearerToken(req.headers.authorization);
    if (!token) throw new AppError(HttpStatus.UNAUTHORIZED, 'unauthorized', 'Нужно войти');

    let payload: JwtPayload;
    try {
      payload = await this.jwt.verifyAsync<JwtPayload>(token);
    } catch {
      throw new AppError(HttpStatus.UNAUTHORIZED, 'unauthorized', 'Сессия истекла, войдите снова');
    }
    req.user = { id: payload.sub, email: payload.email, role: payload.role };

    const roles = this.reflector.getAllAndOverride<AuthUser['role'][] | undefined>(ROLES_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (roles && !roles.includes(payload.role)) {
      throw new AppError(HttpStatus.FORBIDDEN, 'forbidden', 'Недостаточно прав');
    }
    return true;
  }
}

export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthUser => {
  return ctx.switchToHttp().getRequest<AuthedRequest>().user!;
});
