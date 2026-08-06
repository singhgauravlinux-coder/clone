// Package api exposes the generator over HTTP. Every handler is pure: it reads
// a model, renders text and returns it. Nothing here talks to a Kubernetes API
// server, and the service holds no cluster credentials.
package api

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/gin-gonic/gin"

	"github.com/example/manifest-workbench/internal/audit"
	"github.com/example/manifest-workbench/internal/registry"
	"github.com/example/manifest-workbench/internal/validate"
	"github.com/example/manifest-workbench/internal/yamlgen"
)

// Options configures the HTTP server.
type Options struct {
	// WebDir is the built frontend to serve. Empty disables static serving.
	WebDir string
	// Services wires the platform half. Leave zero for generator-only mode.
	Services Services
}

type modelRequest struct {
	ResourceID string         `json:"resourceId" binding:"required"`
	Model      registry.Model `json:"model"`
}

type yamlRequest struct {
	YAML string `json:"yaml" binding:"required"`
}

type generateResponse struct {
	Files  []registry.File  `json:"files"`
	Issues []validate.Issue `json:"issues"`
}

type importResponse struct {
	ResourceID string           `json:"resourceId"`
	Model      registry.Model   `json:"model"`
	Ignored    []string         `json:"ignored,omitempty"`
	Files      []registry.File  `json:"files"`
	Issues     []validate.Issue `json:"issues"`
}

// New builds the router.
//
// Every group is optional. With Services zero-valued the process is a pure
// generator with no database and no cluster access, which is how it runs in CI;
// with Services wired it is the full platform. The routes themselves do not
// change shape between the two, only which middleware guards them.
func New(options Options) *gin.Engine {
	router := gin.New()
	router.Use(gin.Logger(), gin.Recovery(), withRequestID(), securityHeaders())

	services := options.Services

	api := router.Group("/api")
	{
		api.GET("/healthz", func(c *gin.Context) {
			c.JSON(http.StatusOK, gin.H{"status": "ok", "mode": modeOf(services)})
		})

		// Generation is pure computation, so it is available to any
		// authenticated caller and to everyone when auth is not configured.
		generator := api.Group("", services.authenticate(services.Auth != nil))
		generator.GET("/resources", listResources)
		generator.GET("/resources/:id", getResource)
		generator.POST("/generate", services.audited("manifest.generate", generate))
		generator.POST("/validate", validateModel)
		generator.POST("/lint", lintYAML)
		generator.POST("/import", services.audited("manifest.import", importYAML))
	}

	if services.Auth != nil {
		services.mountAuth(api.Group("/auth"))
	}
	if services.Applications != nil && services.Deployments != nil {
		services.mountPlatform(api)
	}
	if services.Inventory != nil {
		services.mountCluster(api)
	}

	if options.WebDir != "" {
		serveStatic(router, options.WebDir)
	}
	return router
}

func modeOf(services Services) string {
	if services.Applications != nil {
		return "platform"
	}
	return "generator"
}

// audited wraps a handler so the action is recorded with the outcome the
// handler actually produced, rather than the one it intended.
func (s Services) audited(action string, handler gin.HandlerFunc) gin.HandlerFunc {
	return func(c *gin.Context) {
		handler(c)
		status := audit.Success
		message := ""
		if c.Writer.Status() >= 400 {
			status = audit.Failure
			message = http.StatusText(c.Writer.Status())
		}
		s.record(c, audit.Entry{Action: action, Status: status, Error: message})
	}
}

func listResources(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{"groups": registry.Groups()})
}

func getResource(c *gin.Context) {
	definition, ok := registry.Get(c.Param("id"))
	if !ok {
		c.JSON(http.StatusNotFound, gin.H{"error": "unknown resource"})
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"resource": definition,
		"defaults": definition.Defaults(),
	})
}

func generate(c *gin.Context) {
	var request modelRequest
	if err := c.ShouldBindJSON(&request); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	definition, ok := registry.Get(request.ResourceID)
	if !ok {
		c.JSON(http.StatusNotFound, gin.H{"error": "unknown resource"})
		return
	}
	model := request.Model
	if model == nil {
		model = definition.Defaults()
	}
	files, err := registry.Generate(definition, model)
	if err != nil {
		c.JSON(http.StatusUnprocessableEntity, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, generateResponse{Files: files, Issues: registry.Validate(definition, model)})
}

func validateModel(c *gin.Context) {
	var request modelRequest
	if err := c.ShouldBindJSON(&request); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	definition, ok := registry.Get(request.ResourceID)
	if !ok {
		c.JSON(http.StatusNotFound, gin.H{"error": "unknown resource"})
		return
	}
	model := request.Model
	if model == nil {
		model = definition.Defaults()
	}
	issues := registry.Validate(definition, model)
	c.JSON(http.StatusOK, gin.H{"issues": issues, "valid": !hasErrors(issues)})
}

// lintYAML checks a pasted document without needing a resource id. Useful from
// CI: pipe a manifest in and fail the build on errors.
func lintYAML(c *gin.Context) {
	var request yamlRequest
	if err := c.ShouldBindJSON(&request); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	docs, err := yamlgen.Parse(request.YAML)
	if err != nil {
		c.JSON(http.StatusUnprocessableEntity, gin.H{"error": err.Error()})
		return
	}
	definition, model, _, err := registry.Import(docs)
	if err != nil {
		c.JSON(http.StatusOK, gin.H{
			"valid":  true,
			"issues": []validate.Issue{},
			"note":   "parsed as valid YAML, but no form matches it so no field rules ran",
		})
		return
	}
	issues := registry.Validate(definition, model)
	c.JSON(http.StatusOK, gin.H{"resourceId": definition.ID, "issues": issues, "valid": !hasErrors(issues)})
}

func importYAML(c *gin.Context) {
	var request yamlRequest
	if err := c.ShouldBindJSON(&request); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	docs, err := yamlgen.Parse(request.YAML)
	if err != nil {
		c.JSON(http.StatusUnprocessableEntity, gin.H{"error": err.Error()})
		return
	}
	definition, model, ignored, err := registry.Import(docs)
	if err != nil {
		c.JSON(http.StatusUnprocessableEntity, gin.H{"error": err.Error()})
		return
	}
	files, err := registry.Generate(definition, model)
	if err != nil {
		c.JSON(http.StatusUnprocessableEntity, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, importResponse{
		ResourceID: definition.ID,
		Model:      model,
		Ignored:    ignored,
		Files:      files,
		Issues:     registry.Validate(definition, model),
	})
}

func hasErrors(issues []validate.Issue) bool {
	for _, issue := range issues {
		if issue.Level == validate.Error {
			return true
		}
	}
	return false
}

// serveStatic serves the built single page app, falling back to index.html so
// client side routing keeps working on a refresh.
func serveStatic(router *gin.Engine, dir string) {
	router.Static("/assets", filepath.Join(dir, "assets"))
	router.NoRoute(func(c *gin.Context) {
		if strings.HasPrefix(c.Request.URL.Path, "/api/") {
			c.JSON(http.StatusNotFound, gin.H{"error": "not found"})
			return
		}
		candidate := filepath.Join(dir, filepath.Clean(c.Request.URL.Path))
		if info, err := os.Stat(candidate); err == nil && !info.IsDir() {
			c.File(candidate)
			return
		}
		c.File(filepath.Join(dir, "index.html"))
	})
}
