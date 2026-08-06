// Package cluster owns every interaction with a Kubernetes API server.
//
// It is the only package permitted to hold a credential or open a connection.
// Everything above it works with rendered bytes and typed results, which keeps
// the authoring path completely free of cluster access.
package cluster

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	stderrors "errors"
	"fmt"
	"io"
	"sort"
	"strings"
	"time"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
	utilyaml "k8s.io/apimachinery/pkg/util/yaml"
	"k8s.io/client-go/discovery"
	"k8s.io/client-go/discovery/cached/memory"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/restmapper"
	"k8s.io/client-go/tools/clientcmd"
)

// FieldManager identifies this platform in managedFields. Keeping it stable is
// what makes server-side apply able to detect and resolve conflicts.
const FieldManager = "manifest-workbench"

// Credential describes how to reach a cluster. Exactly one of Kubeconfig or
// ServiceAccount is populated.
type Credential struct {
	Kubeconfig []byte
	// Context selects a named context inside a multi-cluster kubeconfig.
	Context string

	ServiceAccount *ServiceAccountCredential
}

// ServiceAccountCredential is the recommended production path: a token bound
// to a ServiceAccount with only the RBAC the platform needs.
type ServiceAccountCredential struct {
	APIServerURL          string
	Token                 string
	CABundle              []byte
	InsecureSkipTLSVerify bool
}

// Connection is a live, reusable handle to one cluster.
type Connection struct {
	config    *rest.Config
	dynamic   dynamic.Interface
	clientset kubernetes.Interface
	mapper    meta.RESTMapper
	discovery discovery.DiscoveryInterface
}

// Connect builds a connection and verifies it by reading the server version,
// so a misconfigured credential fails at attach time rather than at apply time.
func Connect(_ context.Context, credential Credential) (*Connection, error) {
	config, err := buildConfig(credential)
	if err != nil {
		return nil, err
	}
	// Bound every call. A hung API server must not hold a request goroutine.
	config.Timeout = 30 * time.Second
	config.QPS = 25
	config.Burst = 50
	config.UserAgent = FieldManager

	clientset, err := kubernetes.NewForConfig(config)
	if err != nil {
		return nil, fmt.Errorf("build clientset: %w", err)
	}
	dynamicClient, err := dynamic.NewForConfig(config)
	if err != nil {
		return nil, fmt.Errorf("build dynamic client: %w", err)
	}
	discoveryClient := memory.NewMemCacheClient(clientset.Discovery())
	mapper := restmapper.NewDeferredDiscoveryRESTMapper(discoveryClient)

	if _, err := clientset.Discovery().ServerVersion(); err != nil {
		return nil, fmt.Errorf("reach api server: %w", err)
	}
	return &Connection{
		config:    config,
		dynamic:   dynamicClient,
		clientset: clientset,
		mapper:    mapper,
		discovery: discoveryClient,
	}, nil
}

func buildConfig(credential Credential) (*rest.Config, error) {
	switch {
	case len(credential.Kubeconfig) > 0:
		raw, err := clientcmd.Load(credential.Kubeconfig)
		if err != nil {
			return nil, fmt.Errorf("parse kubeconfig: %w", err)
		}
		overrides := &clientcmd.ConfigOverrides{}
		if credential.Context != "" {
			overrides.CurrentContext = credential.Context
		}
		return clientcmd.NewDefaultClientConfig(*raw, overrides).ClientConfig()
	case credential.ServiceAccount != nil:
		sa := credential.ServiceAccount
		if sa.APIServerURL == "" || sa.Token == "" {
			return nil, fmt.Errorf("service account credential needs an api server url and a token")
		}
		config := &rest.Config{
			Host:        sa.APIServerURL,
			BearerToken: sa.Token,
			TLSClientConfig: rest.TLSClientConfig{
				CAData:   sa.CABundle,
				Insecure: sa.InsecureSkipTLSVerify,
			},
		}
		if sa.InsecureSkipTLSVerify && len(sa.CABundle) > 0 {
			return nil, fmt.Errorf("cannot set both a CA bundle and insecure skip verify")
		}
		return config, nil
	default:
		return nil, fmt.Errorf("no credential supplied")
	}
}

// ServerVersion reports the cluster version, used for the health poller.
func (c *Connection) ServerVersion() (string, error) {
	version, err := c.discovery.ServerVersion()
	if err != nil {
		return "", err
	}
	return version.GitVersion, nil
}

// Decode splits a multi-document YAML stream into objects.
func Decode(manifest []byte) ([]*unstructured.Unstructured, error) {
	reader := utilyaml.NewYAMLOrJSONDecoder(bytes.NewReader(manifest), 4096)
	var objects []*unstructured.Unstructured
	for {
		raw := map[string]any{}
		if err := reader.Decode(&raw); err != nil {
			if stderrors.Is(err, io.EOF) {
				break
			}
			return nil, fmt.Errorf("decode manifest: %w", err)
		}
		if len(raw) == 0 {
			continue
		}
		object := &unstructured.Unstructured{Object: raw}
		if object.GetKind() == "" {
			return nil, fmt.Errorf("document has no kind")
		}
		objects = append(objects, object)
	}
	return objects, nil
}

// ApplyOptions controls one apply run.
type ApplyOptions struct {
	// Namespace is used for namespaced objects that do not carry one.
	Namespace string
	// DryRun sends the request with dryRun=All: the API server validates and
	// runs admission, then discards the result. This is a real server-side
	// check, not a client-side guess.
	DryRun bool
	// Force takes ownership of fields managed by another field manager. Off by
	// default because silently stealing fields from another controller is how
	// two systems end up fighting over one object.
	Force bool
}

// Result is the outcome for one object.
type Result struct {
	GVK       schema.GroupVersionKind `json:"gvk"`
	Namespace string                  `json:"namespace"`
	Name      string                  `json:"name"`
	Operation string                  `json:"operation"` // created, configured, unchanged, failed
	Error     string                  `json:"error,omitempty"`
}

// Apply performs a server-side apply for each object in order. It stops at the
// first failure: a half-applied bundle is easier to reason about when the
// failure point is deterministic.
func (c *Connection) Apply(ctx context.Context, objects []*unstructured.Unstructured, options ApplyOptions) ([]Result, error) {
	results := make([]Result, 0, len(objects))
	for _, object := range objects {
		result, err := c.applyOne(ctx, object, options)
		results = append(results, result)
		if err != nil {
			return results, err
		}
	}
	return results, nil
}

func (c *Connection) applyOne(ctx context.Context, object *unstructured.Unstructured, options ApplyOptions) (Result, error) {
	gvk := object.GroupVersionKind()
	result := Result{GVK: gvk, Name: object.GetName(), Namespace: object.GetNamespace()}

	resource, namespaced, err := c.resourceFor(gvk)
	if err != nil {
		result.Operation = "failed"
		result.Error = err.Error()
		return result, err
	}
	if namespaced && object.GetNamespace() == "" {
		object.SetNamespace(options.Namespace)
		result.Namespace = options.Namespace
	}
	if !namespaced {
		result.Namespace = ""
	}

	var client dynamic.ResourceInterface = c.dynamic.Resource(resource)
	if namespaced {
		client = c.dynamic.Resource(resource).Namespace(object.GetNamespace())
	}

	before, getErr := client.Get(ctx, object.GetName(), metav1.GetOptions{})
	existed := getErr == nil

	payload, err := json.Marshal(object.Object)
	if err != nil {
		result.Operation = "failed"
		result.Error = err.Error()
		return result, err
	}

	patchOptions := metav1.PatchOptions{FieldManager: FieldManager, Force: &options.Force}
	if options.DryRun {
		patchOptions.DryRun = []string{metav1.DryRunAll}
	}

	after, err := client.Patch(ctx, object.GetName(), types.ApplyPatchType, payload, patchOptions)
	if err != nil {
		result.Operation = "failed"
		result.Error = summarise(err)
		return result, fmt.Errorf("apply %s/%s: %w", gvk.Kind, object.GetName(), err)
	}

	switch {
	case !existed:
		result.Operation = "created"
	case before.GetResourceVersion() == after.GetResourceVersion():
		result.Operation = "unchanged"
	default:
		result.Operation = "configured"
	}
	return result, nil
}

// Delete removes the objects, tolerating ones that are already gone.
func (c *Connection) Delete(ctx context.Context, objects []*unstructured.Unstructured, namespace string) ([]Result, error) {
	policy := metav1.DeletePropagationForeground
	results := make([]Result, 0, len(objects))
	for _, object := range objects {
		gvk := object.GroupVersionKind()
		result := Result{GVK: gvk, Name: object.GetName(), Namespace: object.GetNamespace()}
		resource, namespaced, err := c.resourceFor(gvk)
		if err != nil {
			result.Operation, result.Error = "failed", err.Error()
			results = append(results, result)
			return results, err
		}
		var client dynamic.ResourceInterface = c.dynamic.Resource(resource)
		if namespaced {
			target := object.GetNamespace()
			if target == "" {
				target = namespace
			}
			result.Namespace = target
			client = c.dynamic.Resource(resource).Namespace(target)
		}
		err = client.Delete(ctx, object.GetName(), metav1.DeleteOptions{PropagationPolicy: &policy})
		switch {
		case apierrors.IsNotFound(err):
			result.Operation = "unchanged"
		case err != nil:
			result.Operation, result.Error = "failed", summarise(err)
			results = append(results, result)
			return results, err
		default:
			result.Operation = "deleted"
		}
		results = append(results, result)
	}
	return results, nil
}

// Live fetches the current object, or nil when it does not exist.
func (c *Connection) Live(ctx context.Context, object *unstructured.Unstructured, namespace string) (*unstructured.Unstructured, error) {
	resource, namespaced, err := c.resourceFor(object.GroupVersionKind())
	if err != nil {
		return nil, err
	}
	var client dynamic.ResourceInterface = c.dynamic.Resource(resource)
	if namespaced {
		target := object.GetNamespace()
		if target == "" {
			target = namespace
		}
		client = c.dynamic.Resource(resource).Namespace(target)
	}
	live, err := client.Get(ctx, object.GetName(), metav1.GetOptions{})
	if apierrors.IsNotFound(err) {
		return nil, nil
	}
	return live, err
}

func (c *Connection) resourceFor(gvk schema.GroupVersionKind) (schema.GroupVersionResource, bool, error) {
	mapping, err := c.mapper.RESTMapping(gvk.GroupKind(), gvk.Version)
	if err != nil {
		return schema.GroupVersionResource{}, false, fmt.Errorf("no server resource for %s: %w", gvk, err)
	}
	return mapping.Resource, mapping.Scope.Name() == meta.RESTScopeNameNamespace, nil
}

// summarise turns a Kubernetes error into one line suitable for an audit entry.
func summarise(err error) string {
	var status apierrors.APIStatus
	if stderrors.As(err, &status) {
		return fmt.Sprintf("%s: %s", status.Status().Reason, status.Status().Message)
	}
	return err.Error()
}

/* ── drift ──────────────────────────────────────────────────────────────── */

// Drift reports whether the live object still matches what was applied.
type Drift struct {
	Kind      string   `json:"kind"`
	Name      string   `json:"name"`
	Namespace string   `json:"namespace"`
	Missing   bool     `json:"missing"`
	Fields    []string `json:"fields,omitempty"`
	LiveHash  []byte   `json:"-"`
	WantHash  []byte   `json:"-"`
}

// Detect compares desired objects against the cluster. Only fields the platform
// declared are compared: a defaulted or controller-owned field changing is not
// drift, and treating it as such produces alerts nobody trusts.
func (c *Connection) Detect(ctx context.Context, objects []*unstructured.Unstructured, namespace string) ([]Drift, error) {
	var drifts []Drift
	for _, object := range objects {
		live, err := c.Live(ctx, object, namespace)
		if err != nil {
			return nil, err
		}
		entry := Drift{
			Kind:      object.GetKind(),
			Name:      object.GetName(),
			Namespace: object.GetNamespace(),
		}
		if live == nil {
			entry.Missing = true
			drifts = append(drifts, entry)
			continue
		}
		fields := compare("", object.Object, live.Object)
		entry.WantHash = hashObject(object.Object)
		entry.LiveHash = hashObject(project(object.Object, live.Object))
		if len(fields) > 0 {
			sort.Strings(fields)
			entry.Fields = fields
			drifts = append(drifts, entry)
		}
	}
	return drifts, nil
}

// compare walks the desired tree and records paths where live differs.
func compare(path string, want, live any) []string {
	switch wantTyped := want.(type) {
	case map[string]any:
		liveTyped, ok := live.(map[string]any)
		if !ok {
			return []string{path}
		}
		var out []string
		for key, child := range wantTyped {
			if isIgnored(key) {
				continue
			}
			next := key
			if path != "" {
				next = path + "." + key
			}
			liveChild, present := liveTyped[key]
			if !present {
				out = append(out, next)
				continue
			}
			out = append(out, compare(next, child, liveChild)...)
		}
		return out
	case []any:
		liveTyped, ok := live.([]any)
		if !ok || len(liveTyped) != len(wantTyped) {
			return []string{path}
		}
		var out []string
		for index, child := range wantTyped {
			out = append(out, compare(fmt.Sprintf("%s[%d]", path, index), child, liveTyped[index])...)
		}
		return out
	default:
		if fmt.Sprintf("%v", want) != fmt.Sprintf("%v", live) {
			return []string{path}
		}
		return nil
	}
}

// project keeps only the keys the desired object declares, so hashing a live
// object produces a value comparable with the desired one.
func project(want, live any) any {
	wantMap, ok := want.(map[string]any)
	if !ok {
		return live
	}
	liveMap, ok := live.(map[string]any)
	if !ok {
		return live
	}
	out := map[string]any{}
	for key, child := range wantMap {
		if isIgnored(key) {
			continue
		}
		if liveChild, present := liveMap[key]; present {
			out[key] = project(child, liveChild)
		}
	}
	return out
}

// Fields the API server owns. Comparing them produces permanent false drift.
func isIgnored(key string) bool {
	switch key {
	case "status", "creationTimestamp", "resourceVersion", "uid", "generation",
		"managedFields", "selfLink", "finalizers":
		return true
	default:
		return strings.HasPrefix(key, "kubectl.kubernetes.io/")
	}
}

func hashObject(value any) []byte {
	encoded, err := json.Marshal(value)
	if err != nil {
		return nil
	}
	sum := sha256.Sum256(encoded)
	return sum[:]
}

/* ── health ─────────────────────────────────────────────────────────────── */

// Health mirrors the states the topology view renders.
type Health string

// Health values.
const (
	Healthy     Health = "healthy"
	Progressing Health = "progressing"
	Degraded    Health = "degraded"
	Suspended   Health = "suspended"
	Missing     Health = "missing"
	Unknown     Health = "unknown"
)

// Assess derives a health value from an object's status. The rules follow what
// Argo CD does, because operators already know how to read those states.
func Assess(object *unstructured.Unstructured) Health {
	if object == nil {
		return Missing
	}
	switch object.GetKind() {
	case "Deployment", "StatefulSet", "DaemonSet":
		return assessWorkload(object)
	case "Job":
		return assessJob(object)
	case "CronJob":
		suspended, found, _ := unstructured.NestedBool(object.Object, "spec", "suspend")
		if found && suspended {
			return Suspended
		}
		return Healthy
	case "PersistentVolumeClaim":
		phase, _, _ := unstructured.NestedString(object.Object, "status", "phase")
		switch phase {
		case "Bound":
			return Healthy
		case "Pending":
			return Progressing
		default:
			return Degraded
		}
	case "Pod":
		phase, _, _ := unstructured.NestedString(object.Object, "status", "phase")
		switch phase {
		case "Running", "Succeeded":
			return Healthy
		case "Pending":
			return Progressing
		case "Failed":
			return Degraded
		default:
			return Unknown
		}
	case "Service", "ConfigMap", "Secret", "ServiceAccount", "Role", "RoleBinding",
		"ClusterRole", "ClusterRoleBinding", "Ingress":
		return Healthy
	default:
		return Unknown
	}
}

func assessWorkload(object *unstructured.Unstructured) Health {
	spec, _, _ := unstructured.NestedInt64(object.Object, "spec", "replicas")
	if object.GetKind() == "DaemonSet" {
		desired, _, _ := unstructured.NestedInt64(object.Object, "status", "desiredNumberScheduled")
		ready, _, _ := unstructured.NestedInt64(object.Object, "status", "numberReady")
		switch {
		case desired == 0:
			return Progressing
		case ready >= desired:
			return Healthy
		case ready == 0:
			return Degraded
		default:
			return Progressing
		}
	}
	if spec == 0 {
		return Suspended
	}
	ready, _, _ := unstructured.NestedInt64(object.Object, "status", "readyReplicas")
	updated, _, _ := unstructured.NestedInt64(object.Object, "status", "updatedReplicas")
	observed, found, _ := unstructured.NestedInt64(object.Object, "status", "observedGeneration")
	if found && observed < object.GetGeneration() {
		return Progressing
	}
	switch {
	case ready >= spec && updated >= spec:
		return Healthy
	case ready == 0:
		return Degraded
	default:
		return Progressing
	}
}

func assessJob(object *unstructured.Unstructured) Health {
	failed, _, _ := unstructured.NestedInt64(object.Object, "status", "failed")
	succeeded, _, _ := unstructured.NestedInt64(object.Object, "status", "succeeded")
	switch {
	case failed > 0:
		return Degraded
	case succeeded > 0:
		return Healthy
	default:
		return Progressing
	}
}
