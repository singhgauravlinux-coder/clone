package cluster

import (
	"context"
	"fmt"
	"sort"
	"strings"

	authv1 "k8s.io/api/authorization/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/discovery"
	"k8s.io/client-go/discovery/cached/memory"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/restmapper"
	"k8s.io/client-go/transport"
)

/*
Acting as the user, not as the platform.

A platform that holds one powerful credential per cluster and checks its own
permission table before using it has moved the enforcement boundary into its own
code. A bug in that table is then a privilege escalation, because the API server
has no idea a different human is on the other end.

Impersonation moves the boundary back. The stored credential is granted
`impersonate` on users and groups and nothing else; every request is made as the
logged-in user, and Kubernetes RBAC decides. The platform's own permissions
become a first filter — useful for hiding buttons and for scoping below what
RBAC can express — rather than the only one.

The cost is real and worth stating: the credential can act as anyone, so it is
equivalent to cluster-admin in the hands of an attacker who can forge an
identity. What it buys is that every action lands in the API server's audit log
attributed to a person, and that a mistake in this codebase cannot grant more
than the person already had.
*/

// Identity is who a request is made as.
type Identity struct {
	// Username as Kubernetes will see it. Usually the email, optionally
	// prefixed so downstream RBAC can tell platform users from other subjects.
	Username string
	// Groups map platform roles onto RBAC groups. The API server binds
	// ClusterRoles to these.
	Groups []string
	// Extra is surfaced to admission webhooks and appears in the audit log.
	// Carrying the request id here is what joins the two audit trails.
	Extra map[string][]string
}

// Valid reports whether the identity is safe to send.
//
// Impersonation headers are, in the end, strings in an HTTP request. A username
// containing a newline is a header injection, and one that is empty silently
// falls back to the service account — which is exactly the failure that makes
// impersonation worse than useless.
func (i Identity) Valid() error {
	if strings.TrimSpace(i.Username) == "" {
		return fmt.Errorf("impersonation requires a username")
	}
	if err := checkHeaderSafe("username", i.Username); err != nil {
		return err
	}
	for _, group := range i.Groups {
		if err := checkHeaderSafe("group", group); err != nil {
			return err
		}
	}
	for key, values := range i.Extra {
		if err := checkHeaderSafe("extra key", key); err != nil {
			return err
		}
		for _, value := range values {
			if err := checkHeaderSafe("extra value", value); err != nil {
				return err
			}
		}
	}
	// system:masters is bound to cluster-admin with no way to revoke it.
	// Impersonating into it would let anyone with any platform role take the
	// cluster, so it is refused here rather than trusted to configuration.
	for _, group := range i.Groups {
		if group == "system:masters" {
			return fmt.Errorf("refusing to impersonate system:masters")
		}
	}
	if strings.HasPrefix(i.Username, "system:") {
		return fmt.Errorf("refusing to impersonate the built-in subject %q", i.Username)
	}
	return nil
}

func checkHeaderSafe(field, value string) error {
	if strings.ContainsAny(value, "\r\n\x00") {
		return fmt.Errorf("%s contains a control character", field)
	}
	if len(value) > 512 {
		return fmt.Errorf("%s is too long", field)
	}
	return nil
}

// As returns a connection that makes every call as the given identity.
//
// The returned connection shares nothing mutable with the original: a new
// rest.Config, its own clients and its own discovery cache. Sharing the
// discovery cache would leak one user's view of the API surface to another,
// which for a cluster with per-namespace CRDs is a real information leak.
func (c *Connection) As(identity Identity) (*Connection, error) {
	if err := identity.Valid(); err != nil {
		return nil, err
	}

	config := rest.CopyConfig(c.config)
	config.Impersonate = rest.ImpersonationConfig{
		UserName: identity.Username,
		Groups:   identity.Groups,
		Extra:    identity.Extra,
	}
	// Impersonated requests must never reuse a cached authenticated transport
	// keyed on the base credential.
	config.WrapTransport = nil

	clientset, err := kubernetes.NewForConfig(config)
	if err != nil {
		return nil, fmt.Errorf("build impersonated clientset: %w", err)
	}
	dynamicClient, err := dynamic.NewForConfig(config)
	if err != nil {
		return nil, fmt.Errorf("build impersonated dynamic client: %w", err)
	}
	discoveryClient := memory.NewMemCacheClient(clientset.Discovery())

	return &Connection{
		config:    config,
		dynamic:   dynamicClient,
		clientset: clientset,
		mapper:    restmapper.NewDeferredDiscoveryRESTMapper(discoveryClient),
		discovery: discoveryClient,
	}, nil
}

// Impersonating reports whether this connection acts as someone.
func (c *Connection) Impersonating() (string, bool) {
	name := c.config.Impersonate.UserName
	return name, name != ""
}

// CanImpersonate checks that the stored credential is actually allowed to
// impersonate before a cluster is put into that mode.
//
// Discovering this at connect time turns a confusing 403 on every later request
// into one clear message at the point of configuration.
func (c *Connection) CanImpersonate(ctx context.Context) error {
	for _, resource := range []string{"users", "groups"} {
		review := &authv1.SelfSubjectAccessReview{
			Spec: authv1.SelfSubjectAccessReviewSpec{
				ResourceAttributes: &authv1.ResourceAttributes{
					Verb:     "impersonate",
					Group:    "",
					Resource: resource,
				},
			},
		}
		result, err := c.clientset.AuthorizationV1().
			SelfSubjectAccessReviews().Create(ctx, review, metav1.CreateOptions{})
		if err != nil {
			return fmt.Errorf("check impersonate on %s: %w", resource, err)
		}
		if !result.Status.Allowed {
			return fmt.Errorf(
				"this credential cannot impersonate %s: %s", resource, result.Status.Reason)
		}
	}
	return nil
}

// Permission is one answer from an access review.
type Permission struct {
	Verb      string `json:"verb"`
	Group     string `json:"group"`
	Resource  string `json:"resource"`
	Namespace string `json:"namespace,omitempty"`
	Name      string `json:"name,omitempty"`
	Allowed   bool   `json:"allowed"`
	Reason    string `json:"reason,omitempty"`
}

// Can asks the API server whether the current identity may do something.
//
// This is what lets the UI grey out a button honestly. Deciding it locally from
// the platform's own role table produces a UI that offers actions the cluster
// will refuse, which is worse than not offering them.
func (c *Connection) Can(ctx context.Context, permissions []Permission) ([]Permission, error) {
	out := make([]Permission, 0, len(permissions))
	for _, wanted := range permissions {
		review := &authv1.SelfSubjectAccessReview{
			Spec: authv1.SelfSubjectAccessReviewSpec{
				ResourceAttributes: &authv1.ResourceAttributes{
					Namespace: wanted.Namespace,
					Verb:      wanted.Verb,
					Group:     wanted.Group,
					Resource:  wanted.Resource,
					Name:      wanted.Name,
				},
			},
		}
		result, err := c.clientset.AuthorizationV1().
			SelfSubjectAccessReviews().Create(ctx, review, metav1.CreateOptions{})
		if err != nil {
			return nil, fmt.Errorf("access review for %s %s: %w", wanted.Verb, wanted.Resource, err)
		}
		wanted.Allowed = result.Status.Allowed
		wanted.Reason = result.Status.Reason
		out = append(out, wanted)
	}
	return out, nil
}

// VisibleNamespaces returns the namespaces this identity may list resources in.
//
// A user who cannot list namespaces cluster-wide can still be entitled to
// several of them, so a plain list call returning 403 must not be read as "you
// have access to nothing". This falls back to reviewing the namespaces the
// platform already knows about.
func (c *Connection) VisibleNamespaces(ctx context.Context, candidates []string) ([]string, error) {
	if all, err := c.Namespaces(ctx); err == nil {
		return all, nil
	}

	review := &authv1.SelfSubjectRulesReview{}
	var visible []string
	for _, namespace := range candidates {
		review.Spec.Namespace = namespace
		result, err := c.clientset.AuthorizationV1().
			SelfSubjectRulesReviews().Create(ctx, review, metav1.CreateOptions{})
		if err != nil {
			continue
		}
		for _, rule := range result.Status.ResourceRules {
			if containsAny(rule.Verbs, "list", "*") {
				visible = append(visible, namespace)
				break
			}
		}
	}
	sort.Strings(visible)
	if len(visible) == 0 {
		return nil, fmt.Errorf("this identity cannot list resources in any known namespace")
	}
	return visible, nil
}

func containsAny(values []string, wanted ...string) bool {
	for _, value := range values {
		for _, candidate := range wanted {
			if value == candidate {
				return true
			}
		}
	}
	return false
}

// impersonationHeaders is used only by tests and by the debug endpoint, to show
// exactly what would be sent without making a request.
func impersonationHeaders(identity Identity) map[string][]string {
	headers := map[string][]string{
		transport.ImpersonateUserHeader: {identity.Username},
	}
	if len(identity.Groups) > 0 {
		headers[transport.ImpersonateGroupHeader] = identity.Groups
	}
	for key, values := range identity.Extra {
		headers[transport.ImpersonateUserExtraHeaderPrefix+key] = values
	}
	return headers
}

// Discovery exposes the underlying client for callers that need raw access.
func (c *Connection) Discovery() discovery.DiscoveryInterface { return c.discovery }
