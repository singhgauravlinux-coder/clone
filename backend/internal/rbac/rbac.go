// Package rbac decides whether a caller may perform an action at a scope.
//
// Permissions are dotted verbs: "deployment.apply", "cluster.read". A grant may
// use "*" for everything, or a "resource.*" prefix. Denials are never inferred
// from absence of data — an unresolvable scope is a denial, not a pass.
package rbac

import (
	"fmt"
	"strings"

	"github.com/google/uuid"
)

// ScopeType narrows how far a binding reaches.
type ScopeType string

// Scope levels, ordered from widest to narrowest.
const (
	ScopeOrganization ScopeType = "organization"
	ScopeProject      ScopeType = "project"
	ScopeCluster      ScopeType = "cluster"
	ScopeNamespace    ScopeType = "namespace"
)

// Scope identifies where an action happens.
type Scope struct {
	Type      ScopeType
	ID        uuid.UUID
	Namespace string
}

// Grant is one resolved role binding.
type Grant struct {
	Permissions []string
	Scope       Scope
}

// Subject is the authenticated caller with every grant already resolved.
type Subject struct {
	UserID         uuid.UUID
	OrganizationID uuid.UUID
	Grants         []Grant
	// APIKeyScopes further narrows a request made with a personal access token.
	// An empty slice means the key inherits the user's full permissions.
	APIKeyScopes []string
}

// Error describes why a request was refused. It carries the missing permission
// so the API can return something actionable without leaking what exists.
type Error struct {
	Permission string
	Scope      Scope
}

func (e *Error) Error() string {
	return fmt.Sprintf("permission %q denied at %s scope", e.Permission, e.Scope.Type)
}

// Can reports whether the subject holds permission at the given scope.
func (s Subject) Can(permission string, scope Scope) bool {
	if len(s.APIKeyScopes) > 0 && !matchAny(s.APIKeyScopes, permission) {
		return false
	}
	for _, grant := range s.Grants {
		if !covers(grant.Scope, scope) {
			continue
		}
		if matchAny(grant.Permissions, permission) {
			return true
		}
	}
	return false
}

// Authorize returns nil or an *Error, so handlers can return it directly.
func (s Subject) Authorize(permission string, scope Scope) error {
	if s.Can(permission, scope) {
		return nil
	}
	return &Error{Permission: permission, Scope: scope}
}

// Permissions flattens every verb the subject holds, for embedding in a token.
func (s Subject) Permissions() []string {
	seen := map[string]bool{}
	var out []string
	for _, grant := range s.Grants {
		for _, permission := range grant.Permissions {
			if !seen[permission] {
				seen[permission] = true
				out = append(out, permission)
			}
		}
	}
	return out
}

// covers reports whether a grant at `held` reaches an action at `wanted`.
// An organization grant covers everything beneath it; a namespace grant covers
// only the exact namespace.
func covers(held, wanted Scope) bool {
	switch held.Type {
	case ScopeOrganization:
		return true
	case ScopeProject:
		return wanted.Type == ScopeProject && held.ID == wanted.ID
	case ScopeCluster:
		if wanted.Type == ScopeCluster {
			return held.ID == wanted.ID
		}
		return wanted.Type == ScopeNamespace && held.ID == wanted.ID
	case ScopeNamespace:
		return wanted.Type == ScopeNamespace &&
			held.ID == wanted.ID &&
			strings.EqualFold(held.Namespace, wanted.Namespace)
	default:
		return false
	}
}

func matchAny(held []string, permission string) bool {
	for _, candidate := range held {
		if candidate == "*" || candidate == permission {
			return true
		}
		if strings.HasSuffix(candidate, ".*") {
			prefix := strings.TrimSuffix(candidate, "*")
			if strings.HasPrefix(permission, prefix) {
				return true
			}
		}
	}
	return false
}

// Known permissions. Keeping the list in code means a typo in a role definition
// is caught by a test rather than silently granting nothing.
var Known = []string{
	"organization.read", "organization.update",
	"user.read", "user.create", "user.update", "user.delete", "user.invite",
	"team.read", "team.create", "team.update", "team.delete",
	"project.read", "project.create", "project.update", "project.delete",
	"cluster.read", "cluster.create", "cluster.update", "cluster.delete",
	"manifest.read", "manifest.create", "manifest.update", "manifest.delete",
	"deployment.read", "deployment.dry_run", "deployment.apply",
	"deployment.delete", "deployment.rollback",
	"git.commit",
	"activity.read", "activity.export",
	"settings.read", "settings.update",
	"apikey.create", "apikey.revoke",
}

// Validate reports permissions in a role that are not recognised.
func Validate(permissions []string) []string {
	known := map[string]bool{"*": true}
	for _, permission := range Known {
		known[permission] = true
		known[strings.SplitN(permission, ".", 2)[0]+".*"] = true
	}
	var unknown []string
	for _, permission := range permissions {
		if !known[permission] {
			unknown = append(unknown, permission)
		}
	}
	return unknown
}
