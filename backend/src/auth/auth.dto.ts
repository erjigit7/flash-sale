import { IsEmail, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

export class BuyerLoginDto {
  @IsEmail({}, { message: 'Некорректный email' })
  @MaxLength(254)
  email!: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  name?: string;
}

export class ShopLoginDto {
  @IsString()
  @IsNotEmpty()
  password!: string;
}
