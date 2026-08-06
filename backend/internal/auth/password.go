// Password policy lives beside the hashing code in auth.go. Keeping the rules
// separate from the primitive makes it obvious that changing "what we accept"
// never changes "how we store it".
package auth

import (
	"errors"
	"fmt"
	"strings"
	"unicode"
)

// PasswordPolicy is deliberately length-first. Composition rules push people
// towards predictable substitutions; length and a breach list do more.
type PasswordPolicy struct {
	MinLength        int
	MaxLength        int
	RequireMixed     bool
	DeniedSubstrings []string
}

// DefaultPolicy follows the NIST 800-63B guidance.
var DefaultPolicy = PasswordPolicy{MinLength: 12, MaxLength: 256}

// Validate reports why a password is unacceptable, or nil.
func (p PasswordPolicy) Validate(password string, personal ...string) error {
	if len([]rune(password)) < p.MinLength {
		return fmt.Errorf("password must be at least %d characters", p.MinLength)
	}
	if p.MaxLength > 0 && len(password) > p.MaxLength {
		return fmt.Errorf("password must be at most %d characters", p.MaxLength)
	}
	lower := strings.ToLower(password)
	for _, denied := range p.DeniedSubstrings {
		if denied != "" && strings.Contains(lower, strings.ToLower(denied)) {
			return errors.New("password contains a commonly used phrase")
		}
	}
	for _, value := range personal {
		if value != "" && strings.Contains(lower, strings.ToLower(value)) {
			return errors.New("password must not contain your name or email")
		}
	}
	if p.RequireMixed {
		var hasUpper, hasLower, hasOther bool
		for _, r := range password {
			switch {
			case unicode.IsUpper(r):
				hasUpper = true
			case unicode.IsLower(r):
				hasLower = true
			default:
				hasOther = true
			}
		}
		if !(hasUpper && hasLower && hasOther) {
			return errors.New("password must mix upper case, lower case and at least one other character")
		}
	}
	return nil
}
