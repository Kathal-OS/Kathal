package auth

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"fmt"
	"hash"
	"strconv"
	"strings"
)

// PBKDF2-HMAC-SHA256 password hashing. This avoids pulling in an extra
// module dependency (e.g. golang.org/x/crypto/bcrypt) while still being far
// safer than the plaintext hardcoded-password check it replaces.

const (
	pbkdf2Iterations = 210_000 // OWASP 2023 minimum recommendation for PBKDF2-SHA256
	saltLen          = 16
	keyLen           = 32
)

// HashPassword returns a self-describing hash string:
// "pbkdf2-sha256$<iterations>$<base64 salt>$<base64 hash>"
func HashPassword(password string) (string, error) {
	salt := make([]byte, saltLen)
	if _, err := rand.Read(salt); err != nil {
		return "", fmt.Errorf("generate salt: %w", err)
	}

	digest := pbkdf2(password, salt, pbkdf2Iterations, keyLen)

	return fmt.Sprintf("pbkdf2-sha256$%d$%s$%s",
		pbkdf2Iterations,
		base64.RawStdEncoding.EncodeToString(salt),
		base64.RawStdEncoding.EncodeToString(digest),
	), nil
}

// VerifyPassword checks a plaintext password against a hash produced by
// HashPassword, using a constant-time comparison.
func VerifyPassword(password, encoded string) bool {
	parts := strings.Split(encoded, "$")
	if len(parts) != 4 || parts[0] != "pbkdf2-sha256" {
		return false
	}

	iterations, err := strconv.Atoi(parts[1])
	if err != nil || iterations <= 0 {
		return false
	}

	salt, err := base64.RawStdEncoding.DecodeString(parts[2])
	if err != nil {
		return false
	}

	want, err := base64.RawStdEncoding.DecodeString(parts[3])
	if err != nil {
		return false
	}

	got := pbkdf2(password, salt, iterations, len(want))
	return subtle.ConstantTimeCompare(got, want) == 1
}

// pbkdf2 is a minimal stdlib-only implementation of PBKDF2 (RFC 8018) using
// HMAC-SHA256 as the pseudorandom function.
func pbkdf2(password string, salt []byte, iterations, keyLen int) []byte {
	mac := hmac.New(sha256.New, []byte(password))
	hLen := mac.Size()
	numBlocks := (keyLen + hLen - 1) / hLen

	var dk []byte
	for block := 1; block <= numBlocks; block++ {
		dk = append(dk, pbkdf2Block(mac, salt, iterations, block)...)
	}
	return dk[:keyLen]
}

// pbkdf2Block computes the block-th PBKDF2 block (the F function from
// RFC 8018 §5.2). mac is reset and reused across calls.
func pbkdf2Block(mac hash.Hash, salt []byte, iterations, block int) []byte {
	blockIndex := []byte{byte(block >> 24), byte(block >> 16), byte(block >> 8), byte(block)}

	mac.Reset()
	mac.Write(salt)
	mac.Write(blockIndex)
	u := mac.Sum(nil)

	result := make([]byte, len(u))
	copy(result, u)

	for i := 1; i < iterations; i++ {
		mac.Reset()
		mac.Write(u)
		u = mac.Sum(nil)
		for j := range result {
			result[j] ^= u[j]
		}
	}

	return result
}
