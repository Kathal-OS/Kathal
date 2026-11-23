import crypto from 'node:crypto'
import bcrypt from 'bcryptjs'

// Memory-hard scrypt parameters (N=32768, r=8, p=1 => ~32 MiB RAM per hash)
const SCRYPT_N = 32768
const SCRYPT_R = 8
const SCRYPT_P = 1
const SCRYPT_KEYLEN = 64
const SCRYPT_MAXMEM = 64 * 1024 * 1024

export function safeEqualStrings(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  if (ba.length !== bb.length || ba.length === 0) return false
  return crypto.timingSafeEqual(ba, bb)
}

export function sha256Hex(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex')
}

export function validatePasswordStrength(
  password: string,
  options: { strict?: boolean } = {}
): { ok: boolean; error?: string } {
  if (typeof password !== 'string') {
    return { ok: false, error: 'Password must be a string.' }
  }
  const minLen = options.strict ? 8 : 6
  if (password.length < minLen || password.length > 128) {
    return { ok: false, error: `Password must be between ${minLen} and 128 characters.` }
  }
  if (options.strict) {
    const classes = [
      /[a-z]/.test(password),
      /[A-Z]/.test(password),
      /[0-9]/.test(password),
      /[^a-zA-Z0-9]/.test(password),
    ].filter(Boolean).length
    if (classes < 2) {
      return {
        ok: false,
        error: 'Password must combine at least two character classes (letters, numbers, or symbols).',
      }
    }
  }
  return { ok: true }
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16).toString('hex')
  const derived = await new Promise<Buffer>((resolve, reject) => {
    crypto.scrypt(
      password,
      salt,
      SCRYPT_KEYLEN,
      { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: SCRYPT_MAXMEM },
      (err, key) => {
        if (err) reject(err)
        else resolve(key)
      }
    )
  })
  return `$scrypt$v=1$N=${SCRYPT_N},r=${SCRYPT_R},p=${SCRYPT_P}$${salt}$${derived.toString('hex')}`
}

export function hashPasswordSync(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex')
  const derived = crypto.scryptSync(password, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  })
  return `$scrypt$v=1$N=${SCRYPT_N},r=${SCRYPT_R},p=${SCRYPT_P}$${salt}$${derived.toString('hex')}`
}

export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  if (!password || !storedHash) return false
  if (storedHash.startsWith('$scrypt$')) {
    const parts = storedHash.split('$')
    // ['', 'scrypt', 'v=1', 'N=32768,r=8,p=1', '<salt>', '<hex>']
    if (parts.length !== 6) return false
    const paramPairs = Object.fromEntries(
      parts[3].split(',').map((kv) => {
        const [k, v] = kv.split('=')
        return [k, Number(v)]
      })
    )
    const N = paramPairs.N || SCRYPT_N
    const r = paramPairs.r || SCRYPT_R
    const p = paramPairs.p || SCRYPT_P
    const salt = parts[4]
    const expectedHex = parts[5]
    if (!salt || !expectedHex) return false
    const expectedBuf = Buffer.from(expectedHex, 'hex')
    const derived = await new Promise<Buffer>((resolve, reject) => {
      crypto.scrypt(
        password,
        salt,
        expectedBuf.length,
        { N, r, p, maxmem: Math.max(SCRYPT_MAXMEM, 128 * N * r * 2) },
        (err, key) => {
          if (err) reject(err)
          else resolve(key)
        }
      )
    })
    if (derived.length !== expectedBuf.length) return false
    return crypto.timingSafeEqual(derived, expectedBuf)
  }

  if (storedHash.startsWith('$2a$') || storedHash.startsWith('$2b$') || storedHash.startsWith('$2y$')) {
    return bcrypt.compare(password, storedHash)
  }

  return false
}

export function needsPasswordRehash(storedHash: string): boolean {
  return !storedHash.startsWith('$scrypt$v=1$')
}
