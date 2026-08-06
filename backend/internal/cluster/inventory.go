package cluster

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/discovery"
)

/*
Reading a whole cluster.

Three things make this harder than "list everything":

  - The set of kinds is not knowable ahead of time. CRDs mean discovery has to
    happen at read time, and an aggregated API server that is down must degrade
    the result rather than fail it.
  - A scoped ServiceAccount will be refused on most of what it discovers. A 403
    is the normal case, not an error, and it must be reported as "not visible"
    rather than silently dropped — otherwise the UI shows an empty namespace and
    the operator concludes it is empty.
  - Listing every object in a large cluster is the easiest way to knock over an
    API server. Everything here paginates, bounds its concurrency and obeys a
    deadline.
*/

// APIResource is one listable kind, resolved at read time so CRDs appear
// without the platform knowing about them in advance.
type APIResource struct {
	GVR        schema.GroupVersionResource `json:"gvr"`
	Group      string                      `json:"group"`
	Version    string                      `json:"version"`
	Kind       string                      `json:"kind"`
	Plural     string                      `json:"plural"`
	Namespaced bool                        `json:"namespaced"`
	Verbs      []string                    `json:"verbs"`
	ShortNames []string                    `json:"shortNames,omitempty"`
	Categories []string                    `json:"categories,omitempty"`
	// Custom is true for anything outside the well-known Kubernetes groups.
	Custom bool `json:"custom"`
}

// builtInGroups are the groups shipped with Kubernetes. Anything else is a CRD
// or an aggregated API, which the UI groups separately.
var builtInGroups = map[string]bool{
	"":                             true,
	"apps":                         true,
	"batch":                        true,
	"networking.k8s.io":            true,
	"autoscaling":                  true,
	"policy":                       true,
	"rbac.authorization.k8s.io":    true,
	"storage.k8s.io":               true,
	"apiextensions.k8s.io":         true,
	"admissionregistration.k8s.io": true,
	"coordination.k8s.io":          true,
	"scheduling.k8s.io":            true,
	"node.k8s.io":                  true,
	"discovery.k8s.io":             true,
	"events.k8s.io":                true,
	"certificates.k8s.io":          true,
	"authentication.k8s.io":        true,
	"authorization.k8s.io":         true,
	"flowcontrol.apiserver.k8s.io": true,
}

// noisyResources are listable but never worth walking a whole cluster for.
// Events have their own endpoint; the rest are either write-only or enormous.
var noisyResources = map[string]bool{
	"events":                    true,
	"componentstatuses":         true,
	"bindings":                  true,
	"localsubjectaccessreviews": true,
	"selfsubjectaccessreviews":  true,
	"selfsubjectrulesreviews":   true,
	"subjectaccessreviews":      true,
	"tokenreviews":              true,
	"controllerrevisions":       true,
	"endpointslices":            true,
}

// APIResources enumerates every listable kind the server exposes.
//
// Partial discovery failure is expected in real clusters: a broken metrics or
// custom aggregated API server makes its own group unreadable without affecting
// the rest. Those groups come back in `failed` instead of aborting the call.
func (c *Connection) APIResources(_ context.Context) (resources []APIResource, failed []string, err error) {
	lists, err := c.discovery.ServerPreferredResources()
	if err != nil {
		var groupErr *discovery.ErrGroupDiscoveryFailed
		if !errors.As(err, &groupErr) {
			return nil, nil, fmt.Errorf("discover api resources: %w", err)
		}
		for gv, groupError := range groupErr.Groups {
			failed = append(failed, fmt.Sprintf("%s: %s", gv.String(), groupError))
		}
	}

	for _, list := range lists {
		if list == nil || len(list.APIResources) == 0 {
			continue
		}
		gv, parseErr := schema.ParseGroupVersion(list.GroupVersion)
		if parseErr != nil {
			failed = append(failed, fmt.Sprintf("%s: %s", list.GroupVersion, parseErr))
			continue
		}
		for _, apiResource := range list.APIResources {
			// Subresources ("pods/log") are addressed directly, never listed.
			if strings.Contains(apiResource.Name, "/") {
				continue
			}
			if !hasVerb(apiResource.Verbs, "list") || noisyResources[apiResource.Name] {
				continue
			}
			resources = append(resources, APIResource{
				GVR:        gv.WithResource(apiResource.Name),
				Group:      gv.Group,
				Version:    gv.Version,
				Kind:       apiResource.Kind,
				Plural:     apiResource.Name,
				Namespaced: apiResource.Namespaced,
				Verbs:      apiResource.Verbs,
				ShortNames: apiResource.ShortNames,
				Categories: apiResource.Categories,
				Custom:     !builtInGroups[gv.Group],
			})
		}
	}

	sort.Slice(resources, func(i, j int) bool {
		if resources[i].Group != resources[j].Group {
			return resources[i].Group < resources[j].Group
		}
		return resources[i].Kind < resources[j].Kind
	})
	sort.Strings(failed)
	return resources, failed, nil
}

func hasVerb(verbs metav1.Verbs, wanted string) bool {
	for _, verb := range verbs {
		if verb == wanted {
			return true
		}
	}
	return false
}

// Namespaces lists namespace names, which is the first thing the explorer needs
// and the cheapest call that proves the credential works.
func (c *Connection) Namespaces(ctx context.Context) ([]string, error) {
	list, err := c.clientset.CoreV1().Namespaces().List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list namespaces: %w", err)
	}
	names := make([]string, 0, len(list.Items))
	for _, item := range list.Items {
		names = append(names, item.Name)
	}
	sort.Strings(names)
	return names, nil
}

// InventoryOptions bounds a read of the cluster.
type InventoryOptions struct {
	// Namespaces to read. Empty means every namespace the credential can see.
	Namespaces []string
	// Kinds restricts the walk. Empty means every discovered listable kind.
	Kinds []string
	// SkipCustom leaves CRDs out, which makes the common case much cheaper.
	SkipCustom bool
	// LabelSelector is passed to the API server, so filtering costs nothing here.
	LabelSelector string
	// PageSize bounds one response. 500 is the kubectl default.
	PageSize int64
	// Concurrency caps simultaneous list calls against one API server.
	Concurrency int
	// MaxObjects stops the walk early rather than exhausting memory on a cluster
	// with hundreds of thousands of objects.
	MaxObjects int
	// KeepRaw retains the full object. Off by default: the summary is a
	// fraction of the size and is all the topology needs.
	KeepRaw bool
}

func (o *InventoryOptions) applyDefaults() {
	if o.PageSize <= 0 {
		o.PageSize = 500
	}
	if o.Concurrency <= 0 {
		o.Concurrency = 8
	}
	if o.MaxObjects <= 0 {
		o.MaxObjects = 20000
	}
}

// OwnerRef is the trimmed ownerReference the graph builder needs.
type OwnerRef struct {
	UID        string `json:"uid"`
	Kind       string `json:"kind"`
	Name       string `json:"name"`
	Controller bool   `json:"controller"`
}

// Object is one live resource, summarised. This is the shape the frontend
// receives, and it is deliberately not the full manifest.
type Object struct {
	UID             string            `json:"uid"`
	APIVersion      string            `json:"apiVersion"`
	Kind            string            `json:"kind"`
	Name            string            `json:"name"`
	Namespace       string            `json:"namespace,omitempty"`
	ResourceVersion string            `json:"resourceVersion"`
	Labels          map[string]string `json:"labels,omitempty"`
	Annotations     map[string]string `json:"annotations,omitempty"`
	Owners          []OwnerRef        `json:"owners,omitempty"`
	CreatedAt       time.Time         `json:"createdAt"`
	Health          Health            `json:"health"`
	Message         string            `json:"message,omitempty"`
	Images          []string          `json:"images,omitempty"`
	ReplicasDesired *int64            `json:"replicasDesired,omitempty"`
	ReplicasReady   *int64            `json:"replicasReady,omitempty"`
	Node            string            `json:"node,omitempty"`
	Restarts        int64             `json:"restarts,omitempty"`
	// Selector lets the graph attach a Service to the workload it fronts.
	Selector map[string]string `json:"selector,omitempty"`
	// Backends are the Service names an Ingress routes to.
	Backends []string `json:"backends,omitempty"`
	// ManagedBy is read from managedFields: which controller last wrote this.
	ManagedBy string `json:"managedBy,omitempty"`
	// Managed is true when this platform's field manager appears in
	// managedFields, i.e. the platform applied it rather than merely found it.
	Managed bool                       `json:"managed"`
	Raw     *unstructured.Unstructured `json:"raw,omitempty"`
}

// Unreadable records a kind the credential could not list, and why. Surfacing
// this is the difference between "the namespace is empty" and "you cannot see
// into this namespace".
type Unreadable struct {
	Kind      string `json:"kind"`
	Group     string `json:"group"`
	Namespace string `json:"namespace,omitempty"`
	Reason    string `json:"reason"`
	Forbidden bool   `json:"forbidden"`
}

// Inventory is one complete read of a cluster.
type Inventory struct {
	Objects    []Object     `json:"objects"`
	Unreadable []Unreadable `json:"unreadable,omitempty"`
	// Failed API groups from discovery, e.g. a metrics server that is down.
	DiscoveryFailures []string      `json:"discoveryFailures,omitempty"`
	Truncated         bool          `json:"truncated"`
	TakenAt           time.Time     `json:"takenAt"`
	Duration          time.Duration `json:"durationMs"`
}

// Inventory walks every listable kind and returns what is actually running.
//
// This is the call behind the cluster explorer and behind live topology. It is
// read-only: nothing in this path can mutate a cluster.
func (c *Connection) Inventory(ctx context.Context, options InventoryOptions) (*Inventory, error) {
	options.applyDefaults()
	started := time.Now()

	resources, discoveryFailures, err := c.APIResources(ctx)
	if err != nil {
		return nil, err
	}

	wanted := map[string]bool{}
	for _, kind := range options.Kinds {
		wanted[strings.ToLower(kind)] = true
	}

	var (
		mutex      sync.Mutex
		objects    []Object
		unreadable []Unreadable
		truncated  bool
		wait       sync.WaitGroup
	)
	gate := make(chan struct{}, options.Concurrency)

	for _, resource := range resources {
		if options.SkipCustom && resource.Custom {
			continue
		}
		if len(wanted) > 0 && !wanted[strings.ToLower(resource.Kind)] && !wanted[resource.Plural] {
			continue
		}

		// A cluster-scoped kind is read once; a namespaced kind is read once
		// per requested namespace, or once across all of them.
		scopes := []string{""}
		if resource.Namespaced && len(options.Namespaces) > 0 {
			scopes = options.Namespaces
		}

		for _, namespace := range scopes {
			resource, namespace := resource, namespace
			wait.Add(1)
			gate <- struct{}{}
			go func() {
				defer wait.Done()
				defer func() { <-gate }()

				found, listErr := c.listAll(ctx, resource, namespace, options)
				mutex.Lock()
				defer mutex.Unlock()
				if listErr != nil {
					unreadable = append(unreadable, Unreadable{
						Kind:      resource.Kind,
						Group:     resource.Group,
						Namespace: namespace,
						Reason:    summarise(listErr),
						Forbidden: apierrors.IsForbidden(listErr),
					})
					return
				}
				if len(objects)+len(found) > options.MaxObjects {
					room := options.MaxObjects - len(objects)
					if room < 0 {
						room = 0
					}
					found = found[:room]
					truncated = true
				}
				objects = append(objects, found...)
			}()
		}
	}
	wait.Wait()

	if err := ctx.Err(); err != nil {
		return nil, fmt.Errorf("inventory cancelled: %w", err)
	}

	sort.Slice(objects, func(i, j int) bool {
		if objects[i].Namespace != objects[j].Namespace {
			return objects[i].Namespace < objects[j].Namespace
		}
		if objects[i].Kind != objects[j].Kind {
			return objects[i].Kind < objects[j].Kind
		}
		return objects[i].Name < objects[j].Name
	})
	sort.Slice(unreadable, func(i, j int) bool { return unreadable[i].Kind < unreadable[j].Kind })

	return &Inventory{
		Objects:           objects,
		Unreadable:        unreadable,
		DiscoveryFailures: discoveryFailures,
		Truncated:         truncated,
		TakenAt:           started,
		Duration:          time.Since(started),
	}, nil
}

// listAll pages through one kind. The continue token is the only correct way to
// read a large collection: a single unbounded list is what causes API server
// memory spikes.
func (c *Connection) listAll(ctx context.Context, resource APIResource, namespace string, options InventoryOptions) ([]Object, error) {
	var out []Object
	listOptions := metav1.ListOptions{Limit: options.PageSize, LabelSelector: options.LabelSelector}

	client := c.dynamic.Resource(resource.GVR)
	for {
		var (
			list *unstructured.UnstructuredList
			err  error
		)
		if resource.Namespaced && namespace != "" {
			list, err = client.Namespace(namespace).List(ctx, listOptions)
		} else {
			list, err = client.List(ctx, listOptions)
		}
		if err != nil {
			return nil, err
		}
		for index := range list.Items {
			out = append(out, summariseObject(&list.Items[index], options.KeepRaw))
		}
		listOptions.Continue = list.GetContinue()
		if listOptions.Continue == "" {
			return out, nil
		}
		if len(out) >= options.MaxObjects {
			return out, nil
		}
	}
}

// summariseObject reduces a live object to what the UI and the graph need.
func summariseObject(object *unstructured.Unstructured, keepRaw bool) Object {
	summary := Object{
		UID:             string(object.GetUID()),
		APIVersion:      object.GetAPIVersion(),
		Kind:            object.GetKind(),
		Name:            object.GetName(),
		Namespace:       object.GetNamespace(),
		ResourceVersion: object.GetResourceVersion(),
		Labels:          object.GetLabels(),
		Annotations:     trimAnnotations(object.GetAnnotations()),
		CreatedAt:       object.GetCreationTimestamp().Time,
		Health:          Assess(object),
	}
	for _, owner := range object.GetOwnerReferences() {
		summary.Owners = append(summary.Owners, OwnerRef{
			UID:        string(owner.UID),
			Kind:       owner.Kind,
			Name:       owner.Name,
			Controller: owner.Controller != nil && *owner.Controller,
		})
	}
	for _, entry := range object.GetManagedFields() {
		if entry.Manager == FieldManager {
			summary.Managed = true
		}
		summary.ManagedBy = entry.Manager
	}

	summary.Images = extractImages(object)
	summary.ReplicasDesired = intField(object, "spec", "replicas")
	if ready := intField(object, "status", "readyReplicas"); ready != nil {
		summary.ReplicasReady = ready
	}
	summary.Message = statusMessage(object)

	switch object.GetKind() {
	case "Pod":
		summary.Node, _, _ = unstructured.NestedString(object.Object, "spec", "nodeName")
		summary.Restarts = podRestarts(object)
	case "Service":
		selector, _, _ := unstructured.NestedStringMap(object.Object, "spec", "selector")
		summary.Selector = selector
	case "Ingress":
		summary.Backends = ingressBackends(object)
	case "Deployment", "StatefulSet", "DaemonSet", "ReplicaSet", "Job":
		selector, _, _ := unstructured.NestedStringMap(object.Object, "spec", "selector", "matchLabels")
		summary.Selector = selector
	}

	if keepRaw {
		summary.Raw = object
	}
	return summary
}

// trimAnnotations drops the ones that are large and never displayed.
func trimAnnotations(annotations map[string]string) map[string]string {
	if len(annotations) == 0 {
		return nil
	}
	out := make(map[string]string, len(annotations))
	for key, value := range annotations {
		if key == "kubectl.kubernetes.io/last-applied-configuration" {
			continue
		}
		if len(value) > 1024 {
			value = value[:1024] + "…"
		}
		out[key] = value
	}
	return out
}

func extractImages(object *unstructured.Unstructured) []string {
	paths := [][]string{
		{"spec", "containers"},
		{"spec", "template", "spec", "containers"},
		{"spec", "jobTemplate", "spec", "template", "spec", "containers"},
	}
	var images []string
	for _, path := range paths {
		containers, found, _ := unstructured.NestedSlice(object.Object, path...)
		if !found {
			continue
		}
		for _, entry := range containers {
			container, ok := entry.(map[string]any)
			if !ok {
				continue
			}
			if image, ok := container["image"].(string); ok && image != "" {
				images = append(images, image)
			}
		}
	}
	return images
}

func intField(object *unstructured.Unstructured, path ...string) *int64 {
	value, found, err := unstructured.NestedInt64(object.Object, path...)
	if !found || err != nil {
		return nil
	}
	return &value
}

func podRestarts(object *unstructured.Unstructured) int64 {
	statuses, found, _ := unstructured.NestedSlice(object.Object, "status", "containerStatuses")
	if !found {
		return 0
	}
	var total int64
	for _, entry := range statuses {
		status, ok := entry.(map[string]any)
		if !ok {
			continue
		}
		if count, ok := status["restartCount"].(int64); ok {
			total += count
		}
	}
	return total
}

// statusMessage prefers the reason a controller gave over anything invented
// here, so the UI shows the same words kubectl would.
func statusMessage(object *unstructured.Unstructured) string {
	if phase, found, _ := unstructured.NestedString(object.Object, "status", "phase"); found && phase != "" {
		if reason, ok, _ := unstructured.NestedString(object.Object, "status", "reason"); ok && reason != "" {
			return phase + ": " + reason
		}
		return phase
	}
	conditions, found, _ := unstructured.NestedSlice(object.Object, "status", "conditions")
	if !found {
		return ""
	}
	for _, entry := range conditions {
		condition, ok := entry.(map[string]any)
		if !ok {
			continue
		}
		if status, _ := condition["status"].(string); status == "True" {
			continue
		}
		message, _ := condition["message"].(string)
		if message != "" {
			return message
		}
	}
	return ""
}

func ingressBackends(object *unstructured.Unstructured) []string {
	seen := map[string]bool{}
	var names []string
	add := func(name string) {
		if name != "" && !seen[name] {
			seen[name] = true
			names = append(names, name)
		}
	}
	if name, found, _ := unstructured.NestedString(object.Object, "spec", "defaultBackend", "service", "name"); found {
		add(name)
	}
	rules, _, _ := unstructured.NestedSlice(object.Object, "spec", "rules")
	for _, ruleEntry := range rules {
		rule, ok := ruleEntry.(map[string]any)
		if !ok {
			continue
		}
		paths, _, _ := unstructured.NestedSlice(rule, "http", "paths")
		for _, pathEntry := range paths {
			path, ok := pathEntry.(map[string]any)
			if !ok {
				continue
			}
			name, _, _ := unstructured.NestedString(path, "backend", "service", "name")
			add(name)
		}
	}
	return names
}
