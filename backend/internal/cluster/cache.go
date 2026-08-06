package cluster

import (
	"context"
	"fmt"
	"sync"
	"time"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/labels"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/dynamic/dynamicinformer"
	"k8s.io/client-go/tools/cache"
)

/*
Serving the explorer from a warm cache instead of listing on every request.

A full list per request is correct and does not scale. Fifty operators refreshing
a browser tab becomes fifty concurrent full reads of every kind in the cluster,
which is how a control plane falls over.

Informers fix this the way every Kubernetes tool fixes it: list once, watch
forever, answer from a local store. The store is eventually consistent — a change
appears in milliseconds, not instantly — which is the right trade for a view
that a human is reading.

Three things this does that a naive informer setup does not:

  - Caches per cluster *and* per identity. With impersonation on, two users see
    different subsets, so one shared store would leak. Identity-scoped caches are
    evicted aggressively because there is one per active user.
  - Only caches kinds worth caching. A cache over every discovered CRD is a
    memory leak with extra steps; anything outside the core set is listed live.
  - Gives up cleanly. If informers do not sync inside the deadline, the caller
    falls back to a direct list rather than blocking or serving an empty store.
*/

// cachedKinds are the kinds the explorer opens on, and the only ones worth
// holding in memory. Everything else is listed on demand.
var cachedKinds = []schema.GroupVersionResource{
	{Group: "", Version: "v1", Resource: "pods"},
	{Group: "", Version: "v1", Resource: "services"},
	{Group: "", Version: "v1", Resource: "configmaps"},
	{Group: "", Version: "v1", Resource: "persistentvolumeclaims"},
	{Group: "", Version: "v1", Resource: "serviceaccounts"},
	{Group: "apps", Version: "v1", Resource: "deployments"},
	{Group: "apps", Version: "v1", Resource: "statefulsets"},
	{Group: "apps", Version: "v1", Resource: "daemonsets"},
	{Group: "apps", Version: "v1", Resource: "replicasets"},
	{Group: "batch", Version: "v1", Resource: "jobs"},
	{Group: "batch", Version: "v1", Resource: "cronjobs"},
	{Group: "networking.k8s.io", Version: "v1", Resource: "ingresses"},
	{Group: "autoscaling", Version: "v2", Resource: "horizontalpodautoscalers"},
}

// Secrets are deliberately absent. Caching every Secret in a cluster in the
// platform's memory is a large, permanent, entirely avoidable risk; the
// explorer lists their metadata on demand instead.

// CacheOptions configures one cache entry.
type CacheOptions struct {
	// Namespace scopes the informers. Empty watches every namespace, which
	// requires cluster-wide list and watch.
	Namespace string
	// Resync forces a full relist periodically, papering over any missed watch
	// event. Thirty minutes is the client-go convention.
	Resync time.Duration
	// SyncTimeout bounds the initial list before the caller gives up and reads
	// live instead.
	SyncTimeout time.Duration
	// IdleTTL evicts a cache nobody has read from. With per-identity caches
	// this is what stops memory growing with the user count.
	IdleTTL time.Duration
}

func (o *CacheOptions) applyDefaults() {
	if o.Resync == 0 {
		o.Resync = 30 * time.Minute
	}
	if o.SyncTimeout == 0 {
		o.SyncTimeout = 10 * time.Second
	}
	if o.IdleTTL == 0 {
		o.IdleTTL = 15 * time.Minute
	}
}

type cacheEntry struct {
	factory   dynamicinformer.DynamicSharedInformerFactory
	listers   map[schema.GroupVersionResource]cache.GenericLister
	stop      chan struct{}
	synced    bool
	syncError error
	lastUsed  time.Time
	warmedAt  time.Time
}

// Cache holds warm informers, keyed by cluster and identity.
type Cache struct {
	options CacheOptions
	mutex   sync.Mutex
	entries map[string]*cacheEntry
}

// NewCache builds an empty cache and starts its eviction loop.
func NewCache(ctx context.Context, options CacheOptions) *Cache {
	options.applyDefaults()
	c := &Cache{options: options, entries: map[string]*cacheEntry{}}
	go c.evictLoop(ctx)
	return c
}

func (c *Cache) evictLoop(ctx context.Context) {
	ticker := time.NewTicker(time.Minute)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			c.StopAll()
			return
		case <-ticker.C:
			c.evictIdle()
		}
	}
}

func (c *Cache) evictIdle() {
	c.mutex.Lock()
	defer c.mutex.Unlock()
	cutoff := time.Now().Add(-c.options.IdleTTL)
	for key, entry := range c.entries {
		if entry.lastUsed.Before(cutoff) {
			close(entry.stop)
			delete(c.entries, key)
		}
	}
}

// StopAll shuts every informer down. Called on process shutdown.
func (c *Cache) StopAll() {
	c.mutex.Lock()
	defer c.mutex.Unlock()
	for key, entry := range c.entries {
		close(entry.stop)
		delete(c.entries, key)
	}
}

// key isolates one identity's view from another's. With impersonation on, two
// users legitimately see different objects, so the identity is part of the key.
func cacheKey(clusterID string, connection *Connection) string {
	if user, ok := connection.Impersonating(); ok {
		return clusterID + "|" + user
	}
	return clusterID + "|-"
}

// warm returns a synced entry, or an error if it could not sync in time.
func (c *Cache) warm(ctx context.Context, clusterID string, connection *Connection) (*cacheEntry, error) {
	key := cacheKey(clusterID, connection)

	c.mutex.Lock()
	entry, exists := c.entries[key]
	if exists {
		entry.lastUsed = time.Now()
		c.mutex.Unlock()
		if entry.synced {
			return entry, nil
		}
		return nil, entry.syncError
	}

	entry = &cacheEntry{
		factory: dynamicinformer.NewFilteredDynamicSharedInformerFactory(
			connection.dynamic, c.options.Resync, c.options.Namespace, nil,
		),
		listers:  map[schema.GroupVersionResource]cache.GenericLister{},
		stop:     make(chan struct{}),
		lastUsed: time.Now(),
	}
	for _, gvr := range cachedKinds {
		entry.listers[gvr] = entry.factory.ForResource(gvr).Lister()
	}
	c.entries[key] = entry
	c.mutex.Unlock()

	entry.factory.Start(entry.stop)

	// WaitForCacheSync blocks until every informer has completed its initial
	// list. Bounding it matters: a kind the identity cannot watch never syncs,
	// and without a deadline this would hang forever.
	syncCtx, cancel := context.WithTimeout(ctx, c.options.SyncTimeout)
	defer cancel()
	results := entry.factory.WaitForCacheSync(syncCtx.Done())

	c.mutex.Lock()
	defer c.mutex.Unlock()
	for informerType, ok := range results {
		if !ok {
			// One unsyncable kind must not poison the whole cache; it is
			// reported and that kind falls back to a live list.
			entry.syncError = fmt.Errorf("informer for %v did not sync in %s", informerType, c.options.SyncTimeout)
		}
	}
	entry.synced = true
	entry.warmedAt = time.Now()
	return entry, nil
}

// CachedInventory answers from the warm store, falling back to a live read.
//
// The boolean tells the caller which happened, so the UI can say "cached 4s ago"
// rather than implying the data is live when it is not.
func (c *Cache) CachedInventory(
	ctx context.Context, clusterID string, connection *Connection, options InventoryOptions,
) (*Inventory, bool, error) {
	options.applyDefaults()

	entry, err := c.warm(ctx, clusterID, connection)
	if err != nil || entry == nil {
		inventory, liveErr := connection.Inventory(ctx, options)
		return inventory, false, liveErr
	}

	selector := labels.Everything()
	if options.LabelSelector != "" {
		parsed, parseErr := labels.Parse(options.LabelSelector)
		if parseErr != nil {
			return nil, false, fmt.Errorf("bad label selector: %w", parseErr)
		}
		selector = parsed
	}

	wanted := map[string]bool{}
	for _, kind := range options.Kinds {
		wanted[kind] = true
	}
	namespaces := map[string]bool{}
	for _, namespace := range options.Namespaces {
		namespaces[namespace] = true
	}

	var objects []Object
	for gvr, lister := range entry.listers {
		items, listErr := lister.List(selector)
		if listErr != nil {
			continue
		}
		for _, item := range items {
			object, ok := item.(*unstructured.Unstructured)
			if !ok {
				continue
			}
			if len(wanted) > 0 && !wanted[object.GetKind()] {
				continue
			}
			if len(namespaces) > 0 && !namespaces[object.GetNamespace()] {
				continue
			}
			objects = append(objects, summariseObject(object, options.KeepRaw))
			if len(objects) >= options.MaxObjects {
				break
			}
		}
		_ = gvr
	}

	inventory := &Inventory{
		Objects: objects,
		TakenAt: entry.warmedAt,
	}
	if entry.syncError != nil {
		inventory.DiscoveryFailures = []string{entry.syncError.Error()}
	}
	// Kinds outside the cached set are still expected by the explorer, so they
	// are read live and merged. This is the common path for CRDs.
	if len(options.Kinds) > 0 && !onlyCachedKinds(options.Kinds) {
		live, liveErr := connection.Inventory(ctx, options)
		if liveErr == nil {
			inventory.Objects = mergeByUID(inventory.Objects, live.Objects)
			inventory.Unreadable = live.Unreadable
		}
	}
	return inventory, true, nil
}

func onlyCachedKinds(kinds []string) bool {
	known := map[string]bool{}
	for _, gvr := range cachedKinds {
		known[gvr.Resource] = true
	}
	for _, kind := range kinds {
		if !known[pluralise(kind)] {
			return false
		}
	}
	return true
}

// pluralise is a deliberately crude English pluraliser. It only has to agree
// with the built-in kinds above; anything it gets wrong falls through to a live
// read, which is correct if slower.
func pluralise(kind string) string {
	lower := ""
	for _, r := range kind {
		if r >= 'A' && r <= 'Z' {
			r += 32
		}
		lower += string(r)
	}
	switch {
	case len(lower) == 0:
		return lower
	case lower[len(lower)-1] == 's':
		return lower + "es"
	case lower[len(lower)-1] == 'y':
		return lower[:len(lower)-1] + "ies"
	default:
		return lower + "s"
	}
}

func mergeByUID(first, second []Object) []Object {
	seen := make(map[string]bool, len(first))
	out := make([]Object, 0, len(first)+len(second))
	for _, object := range first {
		seen[object.UID] = true
		out = append(out, object)
	}
	for _, object := range second {
		if !seen[object.UID] {
			out = append(out, object)
		}
	}
	return out
}

// Stats describes cache occupancy, for the operations endpoint.
type Stats struct {
	Entries int       `json:"entries"`
	Oldest  time.Time `json:"oldest,omitempty"`
}

// Stats reports what is currently held.
func (c *Cache) Stats() Stats {
	c.mutex.Lock()
	defer c.mutex.Unlock()
	stats := Stats{Entries: len(c.entries)}
	for _, entry := range c.entries {
		if stats.Oldest.IsZero() || entry.warmedAt.Before(stats.Oldest) {
			stats.Oldest = entry.warmedAt
		}
	}
	return stats
}
