package api

import (
	"encoding/csv"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"github.com/example/manifest-workbench/internal/audit"
	"github.com/example/manifest-workbench/internal/auth"
)

const refreshCookie = "mw_refresh"

// mountAuth registers the login surface. Every route here writes to the audit
// trail, including the ones that fail, because a failed login is the single
// most useful row in the table.
func (s Services) mountAuth(group *gin.RouterGroup) {
	group.POST("/login", s.login)
	group.POST("/login/mfa", s.loginMFA)
	group.POST("/refresh", s.refresh)
	group.POST("/logout", s.authenticate(true), s.logout)
	group.POST("/password/forgot", s.startPasswordReset)
	group.POST("/password/reset", s.completePasswordReset)
	group.POST("/email/verify", s.verifyEmail)

	authenticated := group.Group("", s.authenticate(true))
	authenticated.GET("/sessions", s.listSessions)
	authenticated.DELETE("/sessions/:sessionID", s.revokeSession)
}

func (s Services) setRefreshCookie(c *gin.Context, token string, ttl time.Duration) {
	secure := c.Request.TLS != nil || c.GetHeader("X-Forwarded-Proto") == "https"
	c.SetSameSite(http.SameSiteStrictMode)
	c.SetCookie(refreshCookie, token, int(ttl.Seconds()), "/api/auth", "", secure, true)
}

func (s Services) login(c *gin.Context) {
	var body struct {
		Email    string `json:"email" binding:"required"`
		Password string `json:"password" binding:"required"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "email and password are required"})
		return
	}

	principal, result, err := s.Auth.Authenticate(
		c.Request.Context(), body.Email, body.Password, c.ClientIP(), c.Request.UserAgent(),
	)
	if err != nil {
		// The audit row carries the address that was tried; the response does
		// not say whether it exists.
		s.record(c, audit.Entry{
			Action: "auth.login.failed", ActorEmail: body.Email, Status: audit.Failure, Error: err.Error(),
		})
		switch {
		case errors.Is(err, auth.ErrLocked):
			c.JSON(http.StatusTooManyRequests, gin.H{"error": "too many attempts, try again shortly"})
		default:
			c.JSON(http.StatusUnauthorized, gin.H{"error": "invalid email or password"})
		}
		return
	}

	if result.MFARequired {
		s.record(c, audit.Entry{
			Action: "auth.mfa.challenged", ActorEmail: principal.Email, UserID: &principal.UserID,
			OrganizationID: &principal.OrganizationID, Status: audit.Success,
		})
		c.JSON(http.StatusOK, result)
		return
	}

	s.setRefreshCookie(c, result.RefreshToken, auth.RefreshTTL)
	s.record(c, audit.Entry{
		Action: "auth.login", ActorEmail: principal.Email, UserID: &principal.UserID,
		OrganizationID: &principal.OrganizationID, Status: audit.Success,
		Metadata: map[string]any{"method": principal.Method},
	})
	c.JSON(http.StatusOK, result)
}

func (s Services) loginMFA(c *gin.Context) {
	var body struct {
		ChallengeID string `json:"challengeId" binding:"required"`
		Code        string `json:"code" binding:"required"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "challengeId and code are required"})
		return
	}
	principal, result, err := s.Auth.VerifyMFA(
		c.Request.Context(), body.ChallengeID, body.Code, c.ClientIP(), c.Request.UserAgent(),
	)
	if err != nil {
		s.record(c, audit.Entry{Action: "auth.mfa.failed", Status: audit.Failure, Error: err.Error()})
		c.JSON(http.StatusUnauthorized, gin.H{"error": "invalid code"})
		return
	}
	s.setRefreshCookie(c, result.RefreshToken, auth.RefreshTTL)
	s.record(c, audit.Entry{
		Action: "auth.mfa.verified", ActorEmail: principal.Email, UserID: &principal.UserID,
		OrganizationID: &principal.OrganizationID, Status: audit.Success,
	})
	c.JSON(http.StatusOK, result)
}

func (s Services) refresh(c *gin.Context) {
	token, err := c.Cookie(refreshCookie)
	if err != nil || token == "" {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "no refresh token"})
		return
	}
	result, err := s.Auth.Refresh(c.Request.Context(), token, c.ClientIP(), c.Request.UserAgent())
	if err != nil {
		// Reuse of a rotated token is a security event, not a routine 401.
		status := audit.Failure
		action := "auth.refresh.failed"
		if errors.Is(err, auth.ErrTokenReuse) {
			action = "auth.refresh.reuse_detected"
		}
		s.record(c, audit.Entry{Action: action, Status: status, Error: err.Error()})
		c.SetCookie(refreshCookie, "", -1, "/api/auth", "", false, true)
		c.JSON(http.StatusUnauthorized, gin.H{"error": "session expired"})
		return
	}
	s.setRefreshCookie(c, result.RefreshToken, auth.RefreshTTL)
	c.JSON(http.StatusOK, result)
}

func (s Services) logout(c *gin.Context) {
	principal, _ := PrincipalFrom(c)
	if principal.SessionID != nil {
		if err := s.Auth.Logout(c.Request.Context(), *principal.SessionID); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "could not end the session"})
			return
		}
	}
	c.SetCookie(refreshCookie, "", -1, "/api/auth", "", false, true)
	s.record(c, audit.Entry{Action: "auth.logout", Status: audit.Success})
	c.Status(http.StatusNoContent)
}

func (s Services) startPasswordReset(c *gin.Context) {
	var body struct {
		Email string `json:"email" binding:"required"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "email is required"})
		return
	}
	// Always the same answer: whether the address exists is not public.
	_ = s.Auth.StartPasswordReset(c.Request.Context(), body.Email)
	s.record(c, audit.Entry{Action: "auth.password.reset_requested", ActorEmail: body.Email, Status: audit.Success})
	c.JSON(http.StatusAccepted, gin.H{"status": "if that address exists, a reset link is on its way"})
}

func (s Services) completePasswordReset(c *gin.Context) {
	var body struct {
		Token    string `json:"token" binding:"required"`
		Password string `json:"password" binding:"required"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "token and password are required"})
		return
	}
	if err := s.Auth.CompletePasswordReset(c.Request.Context(), body.Token, body.Password); err != nil {
		s.record(c, audit.Entry{Action: "auth.password.reset", Status: audit.Failure, Error: err.Error()})
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	s.record(c, audit.Entry{Action: "auth.password.reset", Status: audit.Success})
	c.JSON(http.StatusOK, gin.H{"status": "password updated, all other sessions were revoked"})
}

func (s Services) verifyEmail(c *gin.Context) {
	var body struct {
		Token string `json:"token" binding:"required"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "token is required"})
		return
	}
	if err := s.Auth.VerifyEmail(c.Request.Context(), body.Token); err != nil {
		s.record(c, audit.Entry{Action: "auth.email.verify", Status: audit.Failure, Error: err.Error()})
		c.JSON(http.StatusBadRequest, gin.H{"error": "this link is no longer valid"})
		return
	}
	s.record(c, audit.Entry{Action: "auth.email.verify", Status: audit.Success})
	c.JSON(http.StatusOK, gin.H{"status": "verified"})
}

func (s Services) listSessions(c *gin.Context) {
	principal, _ := PrincipalFrom(c)
	sessions, err := s.Auth.ListSessions(c.Request.Context(), principal.UserID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not list sessions"})
		return
	}
	c.JSON(http.StatusOK, sessions)
}

func (s Services) revokeSession(c *gin.Context) {
	principal, _ := PrincipalFrom(c)
	sessionID, err := uuid.Parse(c.Param("sessionID"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "bad session id"})
		return
	}
	if err := s.Auth.RevokeSession(c.Request.Context(), principal.UserID, sessionID); err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "no such session"})
		return
	}
	s.record(c, audit.Entry{
		Action: "auth.session.revoke", Status: audit.Success,
		TargetKind: "Session", TargetName: sessionID.String(),
	})
	c.Status(http.StatusNoContent)
}

/* ── platform ─────────────────────────────────────────────────────────────── */

func (s Services) mountPlatform(group *gin.RouterGroup) {
	authenticated := group.Group("", s.authenticate(true), s.tenantScope())

	authenticated.GET("/bootstrap", s.bootstrap)

	authenticated.GET("/clusters", s.require("cluster.read", orgScope), s.listClusters)
	authenticated.POST("/clusters", s.require("cluster.create", orgScope), s.connectCluster)

	authenticated.GET("/applications", s.require("deployment.read", orgScope), s.listApplications)
	authenticated.GET("/applications/:applicationID", s.require("deployment.read", orgScope), s.getApplication)
	authenticated.GET("/applications/:applicationID/deployments", s.require("deployment.read", orgScope), s.listDeployments)
	authenticated.POST("/applications/:applicationID/rollback", s.require("deployment.rollback", orgScope), s.rollback)
	authenticated.DELETE("/applications/:applicationID/resources/:resourceID", s.require("deployment.delete", orgScope), s.deleteResource)

	// Dry run and apply share a handler because they share a code path in the
	// cluster package: the only difference is the field manager option.
	authenticated.POST("/deployments/apply", s.applyOrDryRun)

	authenticated.GET("/activity", s.require("activity.read", orgScope), s.listActivity)
	authenticated.GET("/activity/export", s.require("activity.export", orgScope), s.exportActivity)
}

func (s Services) bootstrap(c *gin.Context) {
	principal, _ := PrincipalFrom(c)
	payload, err := s.Directory.Bootstrap(c.Request.Context(), principal)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not load the workspace"})
		return
	}
	c.JSON(http.StatusOK, payload)
}

func (s Services) listClusters(c *gin.Context) {
	principal, _ := PrincipalFrom(c)
	clusters, err := s.Directory.ListClusters(c.Request.Context(), principal.OrganizationID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not list clusters"})
		return
	}
	c.JSON(http.StatusOK, clusters)
}

func (s Services) connectCluster(c *gin.Context) {
	principal, _ := PrincipalFrom(c)
	body, err := c.GetRawData()
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "unreadable body"})
		return
	}
	cluster, err := s.Directory.ConnectCluster(c.Request.Context(), principal, body)
	if err != nil {
		s.record(c, audit.Entry{Action: "cluster.connect", Status: audit.Failure, Error: err.Error()})
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	// The kubeconfig never reaches the audit trail: Redact drops it, and the
	// new value recorded here is only the connection metadata.
	s.record(c, audit.Entry{
		Action: "cluster.connect", Status: audit.Success, TargetKind: "Cluster",
		NewValue: audit.Redact(cluster),
	})
	c.JSON(http.StatusCreated, cluster)
}

func (s Services) listApplications(c *gin.Context) {
	principal, _ := PrincipalFrom(c)
	apps, err := s.Applications.List(c.Request.Context(), principal.OrganizationID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not list applications"})
		return
	}
	c.JSON(http.StatusOK, apps)
}

func (s Services) getApplication(c *gin.Context) {
	principal, _ := PrincipalFrom(c)
	id, err := uuid.Parse(c.Param("applicationID"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "bad application id"})
		return
	}
	app, err := s.Applications.Get(c.Request.Context(), principal.OrganizationID, id, c.Query("refresh") == "true")
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "no such application"})
		return
	}
	c.JSON(http.StatusOK, app)
}

func (s Services) listDeployments(c *gin.Context) {
	id, err := uuid.Parse(c.Param("applicationID"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "bad application id"})
		return
	}
	records, err := s.Applications.Deployments(c.Request.Context(), id)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not list deployments"})
		return
	}
	c.JSON(http.StatusOK, records)
}

func (s Services) applyOrDryRun(c *gin.Context) {
	principal, _ := PrincipalFrom(c)
	var payload ApplyPayload
	if err := c.ShouldBindJSON(&payload); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	// A dry run changes nothing, so it is guarded by a weaker permission. This
	// is the whole point of separating the verbs: a developer can prove a change
	// is valid without holding the right to make it.
	permission := "deployment.apply"
	if payload.DryRun {
		permission = "deployment.dry_run"
	}
	if err := principal.Subject.Authorize(permission, orgScope(c)); err != nil {
		s.record(c, audit.Entry{Action: permission, Status: audit.Denied, Error: err.Error()})
		c.JSON(http.StatusForbidden, gin.H{"error": "forbidden", "permission": permission})
		return
	}

	result, err := s.Deployments.Apply(c.Request.Context(), principal, payload)
	if err != nil {
		s.record(c, audit.Entry{
			Action: permission, Status: audit.Failure, Error: err.Error(),
			Namespace: payload.Namespace, ClusterID: &payload.ClusterID,
		})
		c.JSON(http.StatusUnprocessableEntity, gin.H{"error": err.Error()})
		return
	}
	s.record(c, audit.Entry{
		Action: permission, Status: audit.Success, Namespace: payload.Namespace,
		ClusterID: &payload.ClusterID, NewValue: audit.Redact(result),
		Metadata: map[string]any{"files": len(payload.Files), "message": payload.Message},
	})
	c.JSON(http.StatusOK, result)
}

func (s Services) rollback(c *gin.Context) {
	principal, _ := PrincipalFrom(c)
	id, err := uuid.Parse(c.Param("applicationID"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "bad application id"})
		return
	}
	var body struct {
		Revision int `json:"revision" binding:"required"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "revision is required"})
		return
	}
	record, err := s.Deployments.Rollback(c.Request.Context(), principal, id, body.Revision)
	if err != nil {
		s.record(c, audit.Entry{Action: "deployment.rollback", Status: audit.Failure, Error: err.Error()})
		c.JSON(http.StatusUnprocessableEntity, gin.H{"error": err.Error()})
		return
	}
	s.record(c, audit.Entry{
		Action: "deployment.rollback", Status: audit.Success, TargetKind: "Application",
		TargetID: &id, Metadata: map[string]any{"revision": body.Revision},
	})
	c.JSON(http.StatusOK, record)
}

func (s Services) deleteResource(c *gin.Context) {
	principal, _ := PrincipalFrom(c)
	applicationID, err1 := uuid.Parse(c.Param("applicationID"))
	resourceID, err2 := uuid.Parse(c.Param("resourceID"))
	if err1 != nil || err2 != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "bad identifier"})
		return
	}
	if err := s.Deployments.DeleteResource(c.Request.Context(), principal, applicationID, resourceID); err != nil {
		s.record(c, audit.Entry{Action: "deployment.delete", Status: audit.Failure, Error: err.Error()})
		c.JSON(http.StatusUnprocessableEntity, gin.H{"error": err.Error()})
		return
	}
	s.record(c, audit.Entry{
		Action: "deployment.delete", Status: audit.Success,
		TargetKind: "Resource", TargetID: &resourceID,
	})
	c.Status(http.StatusNoContent)
}

/* ── activity ─────────────────────────────────────────────────────────────── */

func parseActivityQuery(c *gin.Context) ActivityQuery {
	query := ActivityQuery{
		Query:    c.Query("query"),
		Actions:  c.QueryArray("actions"),
		Statuses: c.QueryArray("statuses"),
		Actors:   c.QueryArray("actors"),
		Clusters: c.QueryArray("clusters"),
		Limit:    500,
	}
	if raw := c.Query("limit"); raw != "" {
		if value, err := strconv.Atoi(raw); err == nil && value > 0 && value <= 10000 {
			query.Limit = value
		}
	}
	if raw := c.Query("since"); raw != "" {
		if value, err := time.Parse(time.RFC3339, raw); err == nil {
			query.Since = &value
		}
	}
	if raw := c.Query("until"); raw != "" {
		if value, err := time.Parse(time.RFC3339, raw); err == nil {
			query.Until = &value
		}
	}
	return query
}

func (s Services) listActivity(c *gin.Context) {
	principal, _ := PrincipalFrom(c)
	entries, err := s.Activity.Search(c.Request.Context(), principal.OrganizationID, parseActivityQuery(c))
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not search the activity log"})
		return
	}
	c.JSON(http.StatusOK, entries)
}

// exportActivity streams CSV or JSON. Exporting an audit trail is itself an
// audited action, which is the point at which most implementations stop.
func (s Services) exportActivity(c *gin.Context) {
	principal, _ := PrincipalFrom(c)
	query := parseActivityQuery(c)
	query.Limit = 50000
	entries, err := s.Activity.Search(c.Request.Context(), principal.OrganizationID, query)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not export the activity log"})
		return
	}

	format := strings.ToLower(c.DefaultQuery("format", "csv"))
	stamp := time.Now().UTC().Format("20060102-150405")
	s.record(c, audit.Entry{
		Action: "activity.export", Status: audit.Success,
		Metadata: map[string]any{"format": format, "rows": len(entries)},
	})

	if format == "json" {
		c.Header("Content-Disposition", `attachment; filename="activity-`+stamp+`.json"`)
		c.Header("Content-Type", "application/json")
		_ = json.NewEncoder(c.Writer).Encode(entries)
		return
	}

	c.Header("Content-Disposition", `attachment; filename="activity-`+stamp+`.csv"`)
	c.Header("Content-Type", "text/csv; charset=utf-8")
	writer := csv.NewWriter(c.Writer)
	defer writer.Flush()
	_ = writer.Write([]string{
		"occurred_at", "actor_email", "session_id", "api_key_id", "ip", "user_agent",
		"project_slug", "cluster_slug", "namespace", "action", "target_kind", "target_name",
		"status", "error", "old_value", "new_value", "request_id",
	})
	for _, entry := range entries {
		_ = writer.Write([]string{
			entry.OccurredAt.UTC().Format(time.RFC3339),
			entry.ActorEmail,
			uuidString(entry.SessionID),
			uuidString(entry.APIKeyID),
			ipString(entry),
			entry.UserAgent,
			entry.ProjectSlug,
			entry.ClusterSlug,
			entry.Namespace,
			entry.Action,
			entry.TargetKind,
			entry.TargetName,
			string(entry.Status),
			entry.Error,
			jsonString(entry.OldValue),
			jsonString(entry.NewValue),
			entry.RequestID,
		})
	}
}

func uuidString(value *uuid.UUID) string {
	if value == nil {
		return ""
	}
	return value.String()
}

func ipString(entry audit.Entry) string {
	if entry.IP == nil {
		return ""
	}
	return entry.IP.String()
}

func jsonString(value any) string {
	if value == nil {
		return ""
	}
	encoded, err := json.Marshal(value)
	if err != nil {
		return ""
	}
	return string(encoded)
}
