// Package auth owns credentials and tokens.
//
// Three rules shape everything here:
//
//   - Nothing reversible is stored. Passwords are argon2id, refresh tokens and
//     API keys are stored as SHA-256 digests, TOTP secrets are sealed by the
//     KMS envelope before they reach the database.
//   - Refresh tokens rotate on every use and belong to a family. Presenting a
//     token that has already been rotated is treated as theft and revokes the
//     whole family, which is the standard defence against a stolen cookie.
//   - Comparisons that involve a secret are constant time, and a login attempt
//     against an unknown address costs the same as one against a known address.
package auth

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha1" //nolint:gosec // RFC 6238 fixes SHA-1 for TOTP interoperability
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base32"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"golang.org/x/crypto/argon2"
)

// Errors callers are expected to branch on. Everything else is opaque so a
// probe cannot tell a missing user from a wrong password.
var (
	ErrInvalidCredentials = errors.New("auth: invalid credentials")
	ErrLocked             = errors.New("auth: account locked")
	ErrMFARequired        = errors.New("auth: multi-factor authentication required")
	ErrTokenReuse         = errors.New("auth: refresh token reuse detected")
	ErrExpired            = errors.New("auth: token expired")
)

/* ── password hashing ─────────────────────────────────────────────────────── */

// PasswordParams follows the OWASP argon2id recommendation. Stored inside the
// encoded hash so parameters can be raised later without invalidating anyone.
type PasswordParams struct {
	Memory      uint32
	Iterations  uint32
	Parallelism uint8
	SaltLength  uint32
	KeyLength   uint32
}

// DefaultPasswordParams is 64 MiB, three passes, two lanes.
var DefaultPasswordParams = PasswordParams{
	Memory: 64 * 1024, Iterations: 3, Parallelism: 2, SaltLength: 16, KeyLength: 32,
}

// HashPassword returns a PHC-formatted argon2id string.
func HashPassword(password string, params PasswordParams) (string, error) {
	salt := make([]byte, params.SaltLength)
	if _, err := rand.Read(salt); err != nil {
		return "", fmt.Errorf("auth: read salt: %w", err)
	}
	key := argon2.IDKey([]byte(password), salt, params.Iterations, params.Memory, params.Parallelism, params.KeyLength)
	return fmt.Sprintf(
		"$argon2id$v=%d$m=%d,t=%d,p=%d$%s$%s",
		argon2.Version, params.Memory, params.Iterations, params.Parallelism,
		base64.RawStdEncoding.EncodeToString(salt),
		base64.RawStdEncoding.EncodeToString(key),
	), nil
}

// VerifyPassword compares a candidate against an encoded hash in constant time.
func VerifyPassword(encoded, candidate string) (bool, error) {
	parts := strings.Split(encoded, "$")
	if len(parts) != 6 || parts[1] != "argon2id" {
		return false, errors.New("auth: unrecognised password hash")
	}
	var version int
	if _, err := fmt.Sscanf(parts[2], "v=%d", &version); err != nil || version != argon2.Version {
		return false, errors.New("auth: unsupported argon2 version")
	}
	var memory, iterations uint32
	var parallelism uint8
	if _, err := fmt.Sscanf(parts[3], "m=%d,t=%d,p=%d", &memory, &iterations, &parallelism); err != nil {
		return false, errors.New("auth: malformed argon2 parameters")
	}
	salt, err := base64.RawStdEncoding.DecodeString(parts[4])
	if err != nil {
		return false, errors.New("auth: malformed salt")
	}
	want, err := base64.RawStdEncoding.DecodeString(parts[5])
	if err != nil {
		return false, errors.New("auth: malformed digest")
	}
	got := argon2.IDKey([]byte(candidate), salt, iterations, memory, parallelism, uint32(len(want)))
	return subtle.ConstantTimeCompare(got, want) == 1, nil
}

// dummyHash is verified when the address is unknown so the response time of a
// failed login does not reveal whether the account exists.
const dummyHash = "$argon2id$v=19$m=65536,t=3,p=2$c29tZXNhbHR2YWx1ZTAx$Zm9yY29uc3RhbnR0aW1lY29tcGFyaXNvbjEyMw"

// EqualiseTiming burns the same work as a real verification.
func EqualiseTiming(candidate string) {
	_, _ = VerifyPassword(dummyHash, candidate)
}

/* ── access tokens ────────────────────────────────────────────────────────── */

// Claims is the access token body. Permissions are embedded so the common
// authorisation check needs no database round trip; the short lifetime is what
// bounds how stale they can get.
type Claims struct {
	jwt.RegisteredClaims
	OrganizationID string   `json:"org"`
	SessionID      string   `json:"sid"`
	Email          string   `json:"email"`
	Roles          []string `json:"roles,omitempty"`
	Permissions    []string `json:"perms,omitempty"`
	AuthMethod     string   `json:"amr,omitempty"`
	MFASatisfied   bool     `json:"mfa,omitempty"`
}

// TokenIssuer mints and validates access tokens.
type TokenIssuer struct {
	signingKey []byte
	issuer     string
	audience   string
	ttl        time.Duration
}

// NewTokenIssuer builds an HS256 issuer. Production deployments that federate
// tokens to other services should swap this for an asymmetric key so verifiers
// never hold signing material.
func NewTokenIssuer(signingKey []byte, issuer, audience string, ttl time.Duration) (*TokenIssuer, error) {
	if len(signingKey) < 32 {
		return nil, errors.New("auth: signing key must be at least 32 bytes")
	}
	if ttl <= 0 || ttl > time.Hour {
		return nil, errors.New("auth: access token ttl must be positive and at most one hour")
	}
	return &TokenIssuer{signingKey: signingKey, issuer: issuer, audience: audience, ttl: ttl}, nil
}

// Issue returns a signed access token for a session.
func (t *TokenIssuer) Issue(claims Claims) (string, time.Time, error) {
	now := time.Now()
	expires := now.Add(t.ttl)
	claims.RegisteredClaims = jwt.RegisteredClaims{
		Issuer:    t.issuer,
		Subject:   claims.RegisteredClaims.Subject,
		Audience:  jwt.ClaimStrings{t.audience},
		IssuedAt:  jwt.NewNumericDate(now),
		NotBefore: jwt.NewNumericDate(now),
		ExpiresAt: jwt.NewNumericDate(expires),
		ID:        randomHex(16),
	}
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, &claims)
	signed, err := token.SignedString(t.signingKey)
	if err != nil {
		return "", time.Time{}, fmt.Errorf("auth: sign token: %w", err)
	}
	return signed, expires, nil
}

// Parse validates a token and returns its claims.
func (t *TokenIssuer) Parse(raw string) (*Claims, error) {
	claims := &Claims{}
	_, err := jwt.ParseWithClaims(raw, claims, func(token *jwt.Token) (any, error) {
		if _, ok := token.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, fmt.Errorf("auth: unexpected signing method %v", token.Header["alg"])
		}
		return t.signingKey, nil
	},
		jwt.WithIssuer(t.issuer),
		jwt.WithAudience(t.audience),
		jwt.WithValidMethods([]string{jwt.SigningMethodHS256.Alg()}),
	)
	if err != nil {
		if errors.Is(err, jwt.ErrTokenExpired) {
			return nil, ErrExpired
		}
		return nil, ErrInvalidCredentials
	}
	return claims, nil
}

/* ── refresh tokens and sessions ──────────────────────────────────────────── */

// Session is the persisted half of a login. The refresh token itself is only
// ever held by the client.
type Session struct {
	ID               string
	UserID           string
	OrganizationID   string
	FamilyID         string
	ParentSessionID  string
	RefreshTokenHash []byte
	IP               string
	UserAgent        string
	MFASatisfied     bool
	IssuedAt         time.Time
	ExpiresAt        time.Time
	RevokedAt        *time.Time
	RevokedReason    string
}

// SessionStore is the persistence contract. The Postgres implementation lives
// in internal/store; keeping it an interface here is what makes this package
// testable without a database.
type SessionStore interface {
	Create(ctx context.Context, session Session) error
	FindByRefreshHash(ctx context.Context, hash []byte) (Session, error)
	Revoke(ctx context.Context, sessionID, reason string) error
	RevokeFamily(ctx context.Context, familyID, reason string) error
	Touch(ctx context.Context, sessionID string, at time.Time) error
}

// RefreshTTL is how long a refresh token stays valid without use.
const RefreshTTL = 14 * 24 * time.Hour

// NewRefreshToken returns the opaque token and the digest to store.
func NewRefreshToken() (token string, hash []byte) {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		panic("auth: system entropy unavailable: " + err.Error())
	}
	token = base64.RawURLEncoding.EncodeToString(raw)
	sum := sha256.Sum256([]byte(token))
	return token, sum[:]
}

// HashRefreshToken digests a presented token for lookup.
func HashRefreshToken(token string) []byte {
	sum := sha256.Sum256([]byte(token))
	return sum[:]
}

// Rotate exchanges a refresh token for a new session in the same family.
//
// A token that resolves to an already-revoked session means someone is
// replaying: the entire family is revoked so both the thief and the legitimate
// holder are forced to log in again.
func Rotate(ctx context.Context, store SessionStore, presented, ip, userAgent string) (Session, string, error) {
	current, err := store.FindByRefreshHash(ctx, HashRefreshToken(presented))
	if err != nil {
		return Session{}, "", ErrInvalidCredentials
	}
	if current.RevokedAt != nil {
		_ = store.RevokeFamily(ctx, current.FamilyID, "refresh token reuse")
		return Session{}, "", ErrTokenReuse
	}
	if time.Now().After(current.ExpiresAt) {
		_ = store.Revoke(ctx, current.ID, "expired")
		return Session{}, "", ErrExpired
	}

	token, hash := NewRefreshToken()
	next := Session{
		ID:               randomHex(16),
		UserID:           current.UserID,
		OrganizationID:   current.OrganizationID,
		FamilyID:         current.FamilyID,
		ParentSessionID:  current.ID,
		RefreshTokenHash: hash,
		IP:               ip,
		UserAgent:        userAgent,
		MFASatisfied:     current.MFASatisfied,
		IssuedAt:         time.Now(),
		ExpiresAt:        time.Now().Add(RefreshTTL),
	}
	if err := store.Create(ctx, next); err != nil {
		return Session{}, "", err
	}
	if err := store.Revoke(ctx, current.ID, "rotated"); err != nil {
		return Session{}, "", err
	}
	return next, token, nil
}

/* ── API keys and personal access tokens ──────────────────────────────────── */

// APIKeyPrefix identifies the token format in logs and secret scanners.
const APIKeyPrefix = "mw"

// NewAPIKey returns the token to show once, its indexable prefix, and the hash
// to store. The prefix is what makes revocation possible without a table scan.
func NewAPIKey() (token, prefix string, hash []byte) {
	prefixBytes := make([]byte, 6)
	secretBytes := make([]byte, 32)
	if _, err := rand.Read(prefixBytes); err != nil {
		panic("auth: system entropy unavailable: " + err.Error())
	}
	if _, err := rand.Read(secretBytes); err != nil {
		panic("auth: system entropy unavailable: " + err.Error())
	}
	prefix = hex.EncodeToString(prefixBytes)
	secret := base64.RawURLEncoding.EncodeToString(secretBytes)
	token = fmt.Sprintf("%s_%s_%s", APIKeyPrefix, prefix, secret)
	sum := sha256.Sum256([]byte(token))
	return token, prefix, sum[:]
}

// SplitAPIKey pulls the lookup prefix out of a presented token.
func SplitAPIKey(token string) (prefix string, ok bool) {
	parts := strings.Split(token, "_")
	if len(parts) != 3 || parts[0] != APIKeyPrefix {
		return "", false
	}
	return parts[1], true
}

// VerifyAPIKey compares a presented token against a stored digest.
func VerifyAPIKey(token string, storedHash []byte) bool {
	sum := sha256.Sum256([]byte(token))
	return subtle.ConstantTimeCompare(sum[:], storedHash) == 1
}

/* ── multi-factor authentication ──────────────────────────────────────────── */

// TOTPSecret generates a base32 secret for an authenticator app.
func TOTPSecret() string {
	raw := make([]byte, 20)
	if _, err := rand.Read(raw); err != nil {
		panic("auth: system entropy unavailable: " + err.Error())
	}
	return base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(raw)
}

// TOTPURI builds the otpauth:// string an authenticator app scans.
func TOTPURI(issuer, account, secret string) string {
	return fmt.Sprintf(
		"otpauth://totp/%s:%s?secret=%s&issuer=%s&algorithm=SHA1&digits=6&period=30",
		issuer, account, secret, issuer,
	)
}

// VerifyTOTP checks a six digit code, allowing one step of clock skew on each
// side. Callers must also reject a code that was already used in this window,
// otherwise an observer can replay it for the remaining seconds.
func VerifyTOTP(secret, code string, at time.Time) bool {
	if len(code) != 6 {
		return false
	}
	key, err := base32.StdEncoding.WithPadding(base32.NoPadding).DecodeString(strings.ToUpper(secret))
	if err != nil {
		return false
	}
	counter := uint64(at.Unix() / 30)
	for _, step := range []int64{-1, 0, 1} {
		if subtle.ConstantTimeCompare([]byte(hotp(key, uint64(int64(counter)+step))), []byte(code)) == 1 {
			return true
		}
	}
	return false
}

func hotp(key []byte, counter uint64) string {
	buffer := make([]byte, 8)
	binary.BigEndian.PutUint64(buffer, counter)
	mac := hmac.New(sha1.New, key)
	mac.Write(buffer)
	sum := mac.Sum(nil)
	offset := sum[len(sum)-1] & 0x0f
	value := binary.BigEndian.Uint32(sum[offset:offset+4]) & 0x7fffffff
	return fmt.Sprintf("%06d", value%1_000_000)
}

// RecoveryCodes returns codes to show once and the digests to store.
func RecoveryCodes(count int) (codes []string, hashes []string) {
	for i := 0; i < count; i++ {
		raw := make([]byte, 5)
		if _, err := rand.Read(raw); err != nil {
			panic("auth: system entropy unavailable: " + err.Error())
		}
		code := strings.ToLower(base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(raw))
		codes = append(codes, code)
		sum := sha256.Sum256([]byte(code))
		hashes = append(hashes, hex.EncodeToString(sum[:]))
	}
	return codes, hashes
}

// ConsumeRecoveryCode reports whether the code matched, and returns the
// remaining digests. A used code is removed, never reusable.
func ConsumeRecoveryCode(stored []string, candidate string) (bool, []string) {
	sum := sha256.Sum256([]byte(strings.ToLower(strings.TrimSpace(candidate))))
	digest := hex.EncodeToString(sum[:])
	matched := false
	remaining := make([]string, 0, len(stored))
	for _, entry := range stored {
		if !matched && subtle.ConstantTimeCompare([]byte(entry), []byte(digest)) == 1 {
			matched = true
			continue
		}
		remaining = append(remaining, entry)
	}
	return matched, remaining
}

/* ── lockout ──────────────────────────────────────────────────────────────── */

// LockoutPolicy throttles password guessing without giving an attacker a way to
// lock a known account out permanently.
type LockoutPolicy struct {
	Threshold int
	BaseDelay time.Duration
	MaxDelay  time.Duration
}

// DefaultLockout backs off exponentially from five failures, capped at fifteen
// minutes.
var DefaultLockout = LockoutPolicy{Threshold: 5, BaseDelay: time.Minute, MaxDelay: 15 * time.Minute}

// LockUntil returns when the next attempt may be made.
func (p LockoutPolicy) LockUntil(failures int, now time.Time) time.Time {
	if failures < p.Threshold {
		return time.Time{}
	}
	delay := p.BaseDelay << uint(min(failures-p.Threshold, 8))
	if delay > p.MaxDelay {
		delay = p.MaxDelay
	}
	return now.Add(delay)
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

func randomHex(n int) string {
	raw := make([]byte, n)
	if _, err := rand.Read(raw); err != nil {
		panic("auth: system entropy unavailable: " + err.Error())
	}
	return hex.EncodeToString(raw)
}

// FormatDuration is used in lockout messages.
func FormatDuration(d time.Duration) string {
	return strconv.Itoa(int(d.Round(time.Second).Seconds())) + "s"
}
