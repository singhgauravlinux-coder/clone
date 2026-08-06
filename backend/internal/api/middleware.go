package api

import (
	"context"
	"database/sql"
	"errors"
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"github.com/example/manifest-workbench/internal/audit"
	"github.com/example/manifest-workbench/internal/auth"
	"github.com/example/manifest-workbench/internal/rbac"
)

/*
Ports.

The handlers depend on these interfaces, never on a database driver or a
Kubernetes client. That is what lets the same router run in three shapes: with
everything wired for production, with fakes in tests, and with Services left nil
for the generator-only deployment that has no database at all.
*/

// Principal is the authenticated caller for one request.
type Principal struct {
	UserID         uuid.UUID
	OrganizationID uuid.UUID
	Email          string
	SessionID      *uuid.UUID
	APIKeyID       *uuid.UUID
	Subject        rbac.Subject
	MFASatisfied   bool
	Method         string // password | oidc | saml | ldap | api_key
}

// AuthService resolves credentials into principals and owns the login flows.
type AuthService interface {
	Authenticate(ctx context.Context, email, password, ip, userAgent string) (Principal, LoginResult, error)
	VerifyMFA(ctx context.Context, challengeID, code, ip, userAgent string) (Principal, LoginResult, error)
	ResolveAccessToken(ctx context.Context, claims *auth.Claims) (Principal, error)
	ResolveAPIKey(ctx context.Context, presented string) (Principal, error)
	Refresh(ctx context.Context, refreshToken, ip, userAgent string) (LoginResult, error)
	Logout(ctx context.Context, sessionID uuid.UUID) error
	ListSessions(ctx context.Context, userID uuid.UUID) ([]SessionView, error)
	RevokeSession(ctx context.Context, userID, sessionID uuid.UUID) error
	StartPasswordReset(ctx context.Context, email string) error
	CompletePasswordReset(ctx context.Context, token, newPassword string) error
	VerifyEmail(ctx context.Context, token string) error
}

// LoginResult is what a successful (or partially successful) login returns.
type LoginResult struct {
	AccessToken  string    `json:"accessToken,omitempty"`
	ExpiresAt    time.Time `json:"expiresAt,omitempty"`
	RefreshToken string    `json:"-"` // delivered as an HttpOnly cookie
	// Set when the password was right but a second factor is still owed.
	MFAChallengeID string `json:"mfaChallengeId,omitempty"`
	MFARequired    bool   `json:"mfaRequired"`
}

// SessionView is the redacted session shown on the security screen.
type SessionView struct {
	ID           uuid.UUID `json:"id"`
	IP           string    `json:"ip"`
	UserAgent    string    `json:"userAgent"`
	Current      bool      `json:"current"`
	IssuedAt     time.Time `json:"issuedAt"`
	LastUsedAt   time.Time `json:"lastUsedAt"`
	MFASatisfied bool      `json:"mfaSatisfied"`
}

// DirectoryService reads the tenancy tree.
type DirectoryService interface {
	Bootstrap(ctx context.Context, principal Principal) (any, error)
	ListClusters(ctx context.Context, organizationID uuid.UUID) (any, error)
	ConnectCluster(ctx context.Context, principal Principal, payload []byte) (any, error)
}

// ApplicationService serves the topology view.
type ApplicationService interface {
	List(ctx context.Context, organizationID uuid.UUID) (any, error)
	Get(ctx context.Context, organizationID, applicationID uuid.UUID, refresh bool) (any, error)
	Deployments(ctx context.Context, applicationID uuid.UUID) (any, error)
}

// DeploymentService performs the four verbs that change a cluster.
type DeploymentService interface {
	Apply(ctx context.Context, principal Principal, request ApplyPayload) (any, error)
	Rollback(ctx context.Context, principal Principal, applicationID uuid.UUID, revision int) (any, error)
	DeleteResource(ctx context.Context, principal Principal, applicationID, resourceID uuid.UUID) error
}

// ApplyPayload is the body of an apply or dry run.
type ApplyPayload struct {
	ApplicationID uuid.UUID `json:"applicationId"`
	ClusterID     uuid.UUID `json:"clusterId"`
	Namespace     string    `json:"namespace"`
	Files         []struct {
		Path    string `json:"path"`
		Content string `json:"content"`
	} `json:"files"`
	DryRun  bool   `json:"dryRun"`
	Message string `json:"message"`
}

// ActivityService reads the immutable trail. There is deliberately no update or
// delete method: the port cannot express one.
type ActivityService interface {
	Search(ctx context.Context, organizationID uuid.UUID, filter ActivityQuery) ([]audit.Entry, error)
}

// ActivityQuery mirrors the filters on the activity screen.
type ActivityQuery struct {
	Query    string
	Actions  []string
	Statuses []string
	Actors   []string
	Clusters []string
	Since    *time.Time
	Until    *time.Time
	Limit    int
}

// Services is the set of ports the router needs. A nil field disables the
// routes that depend on it rather than panicking at request time.
type Services struct {
	Auth         AuthService
	Directory    DirectoryService
	Applications ApplicationService
	Deployments  DeploymentService
	Activity     ActivityService
	Inventory    InventoryService
	Audit        *audit.Recorder
	Tokens       *auth.TokenIssuer
	DB           *sql.DB
}

const (
	principalKey = "principal"
	requestIDKey = "requestID"
)

// PrincipalFrom returns the authenticated caller, if any.
func PrincipalFrom(c *gin.Context) (Principal, bool) {
	value, ok := c.Get(principalKey)
	if !ok {
		return Principal{}, false
	}
	principal, ok := value.(Principal)
	return principal, ok
}

func requestID(c *gin.Context) string {
	if value, ok := c.Get(requestIDKey); ok {
		if id, ok := value.(string); ok {
			return id
		}
	}
	return ""
}

// withRequestID stamps every request so a log line, an audit row and a client
// error message can all be joined afterwards.
func withRequestID() gin.HandlerFunc {
	return func(c *gin.Context) {
		id := c.GetHeader("X-Request-Id")
		if id == "" {
			id = uuid.NewString()
		}
		c.Set(requestIDKey, id)
		c.Header("X-Request-Id", id)
		c.Next()
	}
}

// securityHeaders are cheap and catch a whole class of mistakes.
func securityHeaders() gin.HandlerFunc {
	return func(c *gin.Context) {
		c.Header("X-Content-Type-Options", "nosniff")
		c.Header("X-Frame-Options", "DENY")
		c.Header("Referrer-Policy", "no-referrer")
		c.Header("Content-Security-Policy",
			"default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; connect-src 'self'")
		c.Next()
	}
}

// authenticate accepts either a bearer access token or an API key. It never
// reveals which one failed.
func (s Services) authenticate(required bool) gin.HandlerFunc {
	return func(c *gin.Context) {
		if s.Auth == nil {
			if required {
				c.AbortWithStatusJSON(http.StatusServiceUnavailable, gin.H{"error": "authentication is not configured"})
				return
			}
			c.Next()
			return
		}

		header := c.GetHeader("Authorization")
		var principal Principal
		var err error

		switch {
		case strings.HasPrefix(header, "Bearer "):
			raw := strings.TrimPrefix(header, "Bearer ")
			if strings.HasPrefix(raw, auth.APIKeyPrefix+"_") {
				principal, err = s.Auth.ResolveAPIKey(c.Request.Context(), raw)
			} else if s.Tokens == nil {
				err = errors.New("token verification is not configured")
			} else {
				var claims *auth.Claims
				claims, err = s.Tokens.Parse(raw)
				if err == nil {
					principal, err = s.Auth.ResolveAccessToken(c.Request.Context(), claims)
				}
			}
		default:
			err = auth.ErrInvalidCredentials
		}

		if err != nil {
			if required {
				c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "unauthenticated"})
				return
			}
			c.Next()
			return
		}

		c.Set(principalKey, principal)
		c.Next()
	}
}

// tenantScope pins the database connection to the caller's organization so the
// row level security policies in 0003_rls.sql have something to enforce.
func (s Services) tenantScope() gin.HandlerFunc {
	return func(c *gin.Context) {
		principal, ok := PrincipalFrom(c)
		if !ok || s.DB == nil {
			c.Next()
			return
		}
		ctx := context.WithValue(c.Request.Context(), tenantContextKey{}, principal.OrganizationID)
		c.Request = c.Request.WithContext(ctx)
		c.Next()
	}
}

type tenantContextKey struct{}

// TenantFrom is used by the store layer when it checks out a connection.
func TenantFrom(ctx context.Context) (uuid.UUID, bool) {
	value, ok := ctx.Value(tenantContextKey{}).(uuid.UUID)
	return value, ok
}

// require guards a route with one permission at one scope. A denial is audited
// exactly like a success, because "who tried to do what" is the interesting
// half of an audit trail.
func (s Services) require(permission string, scope func(c *gin.Context) rbac.Scope) gin.HandlerFunc {
	return func(c *gin.Context) {
		principal, ok := PrincipalFrom(c)
		if !ok {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "unauthenticated"})
			return
		}
		if err := principal.Subject.Authorize(permission, scope(c)); err != nil {
			s.record(c, audit.Entry{
				Action: permission,
				Status: audit.Denied,
				Error:  err.Error(),
			})
			c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"error": "forbidden", "permission": permission})
			return
		}
		c.Next()
	}
}

func orgScope(c *gin.Context) rbac.Scope {
	principal, _ := PrincipalFrom(c)
	return rbac.Scope{Type: rbac.ScopeOrganization, ID: principal.OrganizationID}
}

func clusterScope(c *gin.Context) rbac.Scope {
	if id, err := uuid.Parse(c.Param("clusterID")); err == nil {
		return rbac.Scope{Type: rbac.ScopeCluster, ID: id, Namespace: c.Query("namespace")}
	}
	return orgScope(c)
}

// record writes one audit row, filling in everything that can be taken from the
// request so handlers only supply what is specific to the action.
func (s Services) record(c *gin.Context, entry audit.Entry) {
	if s.Audit == nil {
		return
	}
	if principal, ok := PrincipalFrom(c); ok {
		if entry.UserID == nil {
			id := principal.UserID
			entry.UserID = &id
		}
		if entry.OrganizationID == nil {
			id := principal.OrganizationID
			entry.OrganizationID = &id
		}
		if entry.ActorEmail == "" {
			entry.ActorEmail = principal.Email
		}
		entry.SessionID = principal.SessionID
		entry.APIKeyID = principal.APIKeyID
	}
	entry.IP = clientIP(c)
	entry.UserAgent = c.Request.UserAgent()
	entry.RequestID = requestID(c)

	// The trail must not be able to fail a request it is describing. A write
	// failure is logged loudly and the response continues.
	ctx, cancel := context.WithTimeout(context.WithoutCancel(c.Request.Context()), 3*time.Second)
	defer cancel()
	if err := s.Audit.Record(ctx, entry); err != nil {
		_ = c.Error(err)
	}
}

func clientIP(c *gin.Context) net.IP {
	return net.ParseIP(c.ClientIP())
}
