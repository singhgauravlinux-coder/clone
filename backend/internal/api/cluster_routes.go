package api

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"github.com/example/manifest-workbench/internal/audit"
)

/*
The read-only half of cluster access.

Every route here is a GET. Nothing in this file can change a cluster, which is
what makes it safe to grant `cluster.read` widely: a viewer can see everything
that is running and still be unable to touch it.
*/

// InventoryQuery bounds a read of live cluster state.
type InventoryQuery struct {
	Namespaces    []string `json:"namespaces"`
	Kinds         []string `json:"kinds"`
	LabelSelector string   `json:"labelSelector"`
	Search        string   `json:"search"`
	SkipCustom    bool     `json:"skipCustom"`
	// OnlyManaged narrows to objects this platform applied, which is the
	// difference between "our applications" and "everything in the cluster".
	OnlyManaged bool `json:"onlyManaged"`
	MaxObjects  int  `json:"maxObjects"`
	// Refresh bypasses the cache. The default answer comes from the last sync
	// so that opening the explorer does not hammer the API server.
	Refresh bool `json:"refresh"`
}

// LogQuery bounds a log read.
type LogQuery struct {
	Container  string
	TailLines  int64
	Previous   bool
	Timestamps bool
	Since      time.Duration
}

// InventoryService is the port over live cluster reads. The implementation
// holds the credentials; this package never does.
type InventoryService interface {
	Namespaces(ctx context.Context, principal Principal, clusterID uuid.UUID) ([]string, error)
	APIResources(ctx context.Context, principal Principal, clusterID uuid.UUID) (any, error)
	Inventory(ctx context.Context, principal Principal, clusterID uuid.UUID, query InventoryQuery) (any, error)
	Topology(ctx context.Context, principal Principal, clusterID uuid.UUID, query InventoryQuery) (any, error)
	Events(ctx context.Context, principal Principal, clusterID uuid.UUID, namespace, uid string) (any, error)
	Logs(ctx context.Context, principal Principal, clusterID uuid.UUID, namespace, pod string, query LogQuery) ([]string, error)
	StreamLogs(ctx context.Context, principal Principal, clusterID uuid.UUID, namespace, pod string, query LogQuery) (io.ReadCloser, error)
	Metrics(ctx context.Context, principal Principal, clusterID uuid.UUID, namespace string) (any, error)
	// Permissions asks the API server what this identity may do, so the UI can
	// disable a button because the cluster would refuse it rather than because
	// our own table says so.
	Permissions(ctx context.Context, principal Principal, clusterID uuid.UUID, namespace string) (any, error)
	// Stream pushes inventory changes until the context ends.
	Stream(ctx context.Context, principal Principal, clusterID uuid.UUID, query InventoryQuery, out chan<- any) error
}

func (s Services) mountCluster(group *gin.RouterGroup) {
	cluster := group.Group("/clusters/:clusterID", s.authenticate(true), s.tenantScope(), s.require("cluster.read", clusterScope))

	cluster.GET("/namespaces", s.clusterNamespaces)
	cluster.GET("/api-resources", s.clusterAPIResources)
	cluster.GET("/resources", s.clusterInventory)
	cluster.GET("/topology", s.clusterTopology)
	cluster.GET("/resources/:uid/events", s.resourceEvents)
	cluster.GET("/resources/:uid/logs", s.resourceLogs)
	cluster.GET("/metrics", s.clusterMetrics)
	cluster.GET("/permissions", s.clusterPermissions)
	cluster.GET("/stream", s.clusterStream)
}

func (s Services) clusterIDs(c *gin.Context) (principal Principal, clusterID uuid.UUID, ok bool) {
	principal, found := PrincipalFrom(c)
	if !found {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "unauthenticated"})
		return Principal{}, uuid.Nil, false
	}
	id, err := uuid.Parse(c.Param("clusterID"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "bad cluster id"})
		return Principal{}, uuid.Nil, false
	}
	return principal, id, true
}

func parseInventoryQuery(c *gin.Context) InventoryQuery {
	query := InventoryQuery{
		Namespaces:    c.QueryArray("namespace"),
		Kinds:         c.QueryArray("kind"),
		LabelSelector: c.Query("labelSelector"),
		Search:        c.Query("search"),
		SkipCustom:    c.Query("skipCustom") == "true",
		OnlyManaged:   c.Query("onlyManaged") == "true",
		Refresh:       c.Query("refresh") == "true",
		MaxObjects:    5000,
	}
	if raw := c.Query("maxObjects"); raw != "" {
		if value, err := strconv.Atoi(raw); err == nil && value > 0 && value <= 50000 {
			query.MaxObjects = value
		}
	}
	return query
}

func (s Services) clusterNamespaces(c *gin.Context) {
	principal, clusterID, ok := s.clusterIDs(c)
	if !ok {
		return
	}
	namespaces, err := s.Inventory.Namespaces(c.Request.Context(), principal, clusterID)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, namespaces)
}

func (s Services) clusterAPIResources(c *gin.Context) {
	principal, clusterID, ok := s.clusterIDs(c)
	if !ok {
		return
	}
	resources, err := s.Inventory.APIResources(c.Request.Context(), principal, clusterID)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, resources)
}

// clusterInventory is the explorer's list view: everything running, not just
// what this platform deployed.
func (s Services) clusterInventory(c *gin.Context) {
	principal, clusterID, ok := s.clusterIDs(c)
	if !ok {
		return
	}
	query := parseInventoryQuery(c)

	// Reading a whole cluster is bounded work, but it is not instant work.
	ctx, cancel := context.WithTimeout(c.Request.Context(), 60*time.Second)
	defer cancel()

	inventory, err := s.Inventory.Inventory(ctx, principal, clusterID, query)
	if err != nil {
		s.record(c, audit.Entry{
			Action: "cluster.inventory", Status: audit.Failure, Error: err.Error(), ClusterID: &clusterID,
		})
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	// Reading the cluster is an audited action: it is how someone enumerates
	// what you are running.
	s.record(c, audit.Entry{
		Action: "cluster.inventory", Status: audit.Success, ClusterID: &clusterID,
		Namespace: strings.Join(query.Namespaces, ","),
		Metadata:  map[string]any{"refresh": query.Refresh, "kinds": query.Kinds},
	})
	c.JSON(http.StatusOK, inventory)
}

func (s Services) clusterTopology(c *gin.Context) {
	principal, clusterID, ok := s.clusterIDs(c)
	if !ok {
		return
	}
	ctx, cancel := context.WithTimeout(c.Request.Context(), 60*time.Second)
	defer cancel()

	graph, err := s.Inventory.Topology(ctx, principal, clusterID, parseInventoryQuery(c))
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, graph)
}

func (s Services) resourceEvents(c *gin.Context) {
	principal, clusterID, ok := s.clusterIDs(c)
	if !ok {
		return
	}
	events, err := s.Inventory.Events(c.Request.Context(), principal, clusterID, c.Query("namespace"), c.Param("uid"))
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, events)
}

func parseLogQuery(c *gin.Context) LogQuery {
	query := LogQuery{
		Container:  c.Query("container"),
		TailLines:  200,
		Previous:   c.Query("previous") == "true",
		Timestamps: c.Query("timestamps") == "true",
	}
	if raw := c.Query("tail"); raw != "" {
		if value, err := strconv.ParseInt(raw, 10, 64); err == nil && value > 0 && value <= 5000 {
			query.TailLines = value
		}
	}
	if raw := c.Query("sinceSeconds"); raw != "" {
		if value, err := strconv.Atoi(raw); err == nil && value > 0 {
			query.Since = time.Duration(value) * time.Second
		}
	}
	return query
}

// resourceLogs returns a bounded tail, or streams when follow=true.
//
// Reading logs is audited without recording the content: the log body may
// contain anything, and an audit trail is not the place to copy it to.
func (s Services) resourceLogs(c *gin.Context) {
	principal, clusterID, ok := s.clusterIDs(c)
	if !ok {
		return
	}
	namespace := c.Query("namespace")
	pod := c.Query("pod")
	if namespace == "" || pod == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "namespace and pod are required"})
		return
	}
	query := parseLogQuery(c)

	s.record(c, audit.Entry{
		Action: "cluster.logs.read", Status: audit.Success, ClusterID: &clusterID,
		Namespace: namespace, TargetKind: "Pod", TargetName: pod,
		Metadata: map[string]any{"container": query.Container, "tail": query.TailLines},
	})

	if c.Query("follow") != "true" {
		lines, err := s.Inventory.Logs(c.Request.Context(), principal, clusterID, namespace, pod, query)
		if err != nil {
			c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, gin.H{"lines": lines})
		return
	}

	stream, err := s.Inventory.StreamLogs(c.Request.Context(), principal, clusterID, namespace, pod, query)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	defer stream.Close()

	sseHeaders(c)
	buffer := make([]byte, 4096)
	for {
		read, readErr := stream.Read(buffer)
		if read > 0 {
			for _, line := range strings.Split(strings.TrimRight(string(buffer[:read]), "\n"), "\n") {
				fmt.Fprintf(c.Writer, "data: %s\n\n", line)
			}
			c.Writer.Flush()
		}
		if readErr != nil {
			return
		}
		if c.Request.Context().Err() != nil {
			return
		}
	}
}

func (s Services) clusterMetrics(c *gin.Context) {
	principal, clusterID, ok := s.clusterIDs(c)
	if !ok {
		return
	}
	samples, err := s.Inventory.Metrics(c.Request.Context(), principal, clusterID, c.Query("namespace"))
	if err != nil {
		// metrics-server is optional. A cluster without it is not broken, so
		// this is a 200 with an explanation rather than an error the UI has to
		// render as a failure.
		c.JSON(http.StatusOK, gin.H{"available": false, "reason": err.Error(), "samples": []any{}})
		return
	}
	c.JSON(http.StatusOK, gin.H{"available": true, "samples": samples})
}

// clusterStream pushes inventory changes over server-sent events.
//
// SSE rather than websockets: the traffic is one-directional, it survives
// proxies that mangle upgrades, and the browser reconnects on its own.
// clusterPermissions reports what the caller may actually do on this cluster,
// as the API server sees it. In impersonate mode this is the truth; in shared
// credential mode it describes the stored credential, which the response says
// plainly so the UI does not present it as a statement about the user.
func (s Services) clusterPermissions(c *gin.Context) {
	principal, clusterID, ok := s.clusterIDs(c)
	if !ok {
		return
	}
	permissions, err := s.Inventory.Permissions(
		c.Request.Context(), principal, clusterID, c.Query("namespace"),
	)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, permissions)
}

func (s Services) clusterStream(c *gin.Context) {
	principal, clusterID, ok := s.clusterIDs(c)
	if !ok {
		return
	}
	ctx, cancel := context.WithCancel(c.Request.Context())
	defer cancel()

	changes := make(chan any, 64)
	go func() {
		defer close(changes)
		if err := s.Inventory.Stream(ctx, principal, clusterID, parseInventoryQuery(c), changes); err != nil {
			_ = c.Error(err)
		}
	}()

	sseHeaders(c)
	heartbeat := time.NewTicker(25 * time.Second)
	defer heartbeat.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-heartbeat.C:
			// Keeps intermediaries from closing an idle connection.
			fmt.Fprint(c.Writer, ": keep-alive\n\n")
			c.Writer.Flush()
		case change, open := <-changes:
			if !open {
				return
			}
			c.SSEvent("change", change)
			c.Writer.Flush()
		}
	}
}

func sseHeaders(c *gin.Context) {
	c.Writer.Header().Set("Content-Type", "text/event-stream")
	c.Writer.Header().Set("Cache-Control", "no-cache")
	c.Writer.Header().Set("Connection", "keep-alive")
	// Nginx buffers by default, which turns a live stream into a batch.
	c.Writer.Header().Set("X-Accel-Buffering", "no")
	c.Writer.Flush()
}
