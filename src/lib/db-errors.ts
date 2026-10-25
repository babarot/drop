// drizzle wraps D1 errors in DrizzleQueryError, so follow cause as well

export const isUniqueViolation = (e: unknown): boolean => {
  if (!(e instanceof Error)) return false
  return /UNIQUE/i.test(e.message) || isUniqueViolation(e.cause)
}

export const isNotNullViolation = (e: unknown): boolean => {
  if (!(e instanceof Error)) return false
  return /NOT NULL/i.test(e.message) || isNotNullViolation(e.cause)
}
