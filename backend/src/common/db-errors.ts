/**
 * Распознаёт нарушение уникальности Postgres (SQLSTATE 23505) в ошибке Prisma.
 * В $queryRaw через driver adapter Prisma заворачивает ошибку БД, и её код лежит
 * в разных местах в зависимости от пути, поэтому проверяем все известные варианты.
 */
export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  if (!error || typeof error !== 'object') return false;
  const e = error as {
    code?: string;
    message?: string;
    meta?: { code?: string; driverAdapterError?: { cause?: { kind?: string; constraint?: unknown; originalCode?: string } } };
    cause?: { code?: string; constraint?: string };
  };
  const cause = e.meta?.driverAdapterError?.cause;
  const isUnique =
    e.code === 'P2002' ||
    e.meta?.code === '23505' ||
    cause?.kind === 'UniqueConstraintViolation' ||
    cause?.originalCode === '23505' ||
    e.cause?.code === '23505' ||
    (e.message ?? '').includes('23505');
  if (!isUnique) return false;
  if (!constraint) return true;
  return JSON.stringify(error, Object.getOwnPropertyNames(error)).includes(constraint) ||
    (e.message ?? '').includes(constraint);
}
