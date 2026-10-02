import {
  IsDateString,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class CreateSaleDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  title!: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @IsOptional()
  @IsUrl()
  imageUrl?: string;

  /** Цена в копейках */
  @IsInt()
  @Min(1)
  priceCents!: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  oldPriceCents?: number;

  @IsInt()
  @Min(1)
  @Max(100_000)
  totalQty!: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  maxPerOrder?: number;

  /** Абсолютное время старта (ISO 8601). Альтернатива — startsInSeconds. */
  @IsOptional()
  @IsDateString()
  startsAt?: string;

  /** Старт через N секунд по часам сервера (пресет «через 1 минуту»). */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(30 * 24 * 3600)
  startsInSeconds?: number;

  @IsInt()
  @Min(10)
  @Max(7 * 24 * 3600)
  durationSeconds!: number;
}
