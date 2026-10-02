import { Body, Controller, Get, HttpCode, Post, UseGuards } from '@nestjs/common';
import { AuthService } from './auth.service.js';
import { BuyerLoginDto, ShopLoginDto } from './auth.dto.js';
import { AuthGuard, CurrentUser } from './auth.guard.js';
import type { AuthUser } from './auth.types.js';
import { PrismaService } from '../prisma/prisma.service.js';

@Controller()
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly prisma: PrismaService,
  ) {}

  @Post('auth/login')
  @HttpCode(200)
  login(@Body() dto: BuyerLoginDto) {
    return this.auth.loginBuyer(dto.email, dto.name);
  }

  @Post('auth/shop-login')
  @HttpCode(200)
  shopLogin(@Body() dto: ShopLoginDto) {
    return this.auth.loginShop(dto.password);
  }

  @Get('me')
  @UseGuards(AuthGuard)
  me(@CurrentUser() user: AuthUser) {
    return this.prisma.user.findUniqueOrThrow({
      where: { id: user.id },
      select: { id: true, email: true, name: true, role: true },
    });
  }
}
