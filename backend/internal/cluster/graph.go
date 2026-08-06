package cluster

import (
	"sort"
	"strings"
)

/*
Turning a flat inventory into the tree the topology view draws.

Kubernetes gives us one reliable edge and several inferred ones:

  - ownerReferences with controller=true is authoritative. Deployment →
    ReplicaSet → Pod comes straight from the API server.
  - A Service has no owner edge to the workload it fronts. The relationship is a
    label selector, which has to be evaluated here.
  - An Ingress names Services by string, in a spec shape that changed between
    API versions.
  - A Pod references PVCs, ConfigMaps and Secrets by name, which is how storage
    and configuration attach to the tree.

Anything with no resolvable parent becomes a root. That matters: an orphaned
ReplicaSet whose Deployment was deleted should appear as a root rather than
vanish from the graph.
*/

// Node is one vertex of the rendered graph.
type Node struct {
	Object
	// ParentUID is the controller owner, or the workload a Service selects.
	ParentUID string `json:"parentId,omitempty"`
	// Edge explains why the parent is the parent, so the UI can style it and a
	// reviewer can tell an authoritative edge from an inferred one.
	Edge EdgeKind `json:"edge,omitempty"`
	// Depth is distance from the root, precomputed for the column layout.
	Depth int `json:"depth"`
	// Children counts direct descendants, so a collapsed node can say how much
	// it is hiding.
	Children int `json:"children"`
}

// EdgeKind records the provenance of a parent link.
type EdgeKind string

const (
	// EdgeOwner comes from ownerReferences and is authoritative.
	EdgeOwner EdgeKind = "owner"
	// EdgeSelector was inferred by matching a Service selector to pod labels.
	EdgeSelector EdgeKind = "selector"
	// EdgeBackend was inferred from an Ingress naming a Service.
	EdgeBackend EdgeKind = "backend"
	// EdgeMount was inferred from a pod referencing a volume or config source.
	EdgeMount EdgeKind = "mount"
)

// Graph is a rendered topology plus the roots to start drawing from.
type Graph struct {
	Nodes []Node   `json:"nodes"`
	Roots []string `json:"roots"`
	// Orphans are nodes whose ownerReference points at something that no longer
	// exists. Usually a controller mid-deletion; occasionally a real leak.
	Orphans []string `json:"orphans,omitempty"`
}

// BuildGraph resolves every edge it can and returns a drawable tree.
func BuildGraph(objects []Object) Graph {
	byUID := make(map[string]*Node, len(objects))
	nodes := make([]Node, 0, len(objects))
	for _, object := range objects {
		nodes = append(nodes, Node{Object: object})
	}
	for index := range nodes {
		byUID[nodes[index].UID] = &nodes[index]
	}

	var orphans []string

	// 1. Authoritative edges.
	for index := range nodes {
		node := &nodes[index]
		for _, owner := range node.Owners {
			if !owner.Controller {
				continue
			}
			if _, exists := byUID[owner.UID]; exists {
				node.ParentUID = owner.UID
				node.Edge = EdgeOwner
			} else {
				// The owner was not in this read: either deleted, or outside
				// the namespaces we were allowed to list.
				orphans = append(orphans, node.UID)
			}
			break
		}
	}

	// 2. Services attach to the workload whose pod template they select.
	//    Matching against workloads rather than pods keeps the graph readable:
	//    one edge to the Deployment instead of one per replica.
	workloads := make([]*Node, 0, 16)
	for index := range nodes {
		switch nodes[index].Kind {
		case "Deployment", "StatefulSet", "DaemonSet", "Job", "CronJob", "ReplicaSet":
			workloads = append(workloads, &nodes[index])
		}
	}
	pods := make([]*Node, 0, 32)
	for index := range nodes {
		if nodes[index].Kind == "Pod" {
			pods = append(pods, &nodes[index])
		}
	}

	for index := range nodes {
		node := &nodes[index]
		if node.Kind != "Service" || len(node.Selector) == 0 || node.ParentUID != "" {
			continue
		}
		if target := bestWorkloadFor(node, workloads, pods); target != nil {
			node.ParentUID = target.UID
			node.Edge = EdgeSelector
		}
	}

	// 3. Ingresses hang off the first Service they route to.
	servicesByName := map[string]*Node{}
	for index := range nodes {
		if nodes[index].Kind == "Service" {
			servicesByName[nodes[index].Namespace+"/"+nodes[index].Name] = &nodes[index]
		}
	}
	for index := range nodes {
		node := &nodes[index]
		if node.Kind != "Ingress" || node.ParentUID != "" {
			continue
		}
		for _, backend := range node.Backends {
			if service, ok := servicesByName[node.Namespace+"/"+backend]; ok {
				node.ParentUID = service.UID
				node.Edge = EdgeBackend
				break
			}
		}
	}

	// 4. Configuration and storage attach to the workload that mounts them.
	//    Without this a namespace renders as a workload tree plus a drift of
	//    unconnected ConfigMaps, which tells an operator nothing.
	mounts := mountIndex(nodes)
	for index := range nodes {
		node := &nodes[index]
		if node.ParentUID != "" {
			continue
		}
		switch node.Kind {
		case "ConfigMap", "Secret", "PersistentVolumeClaim", "ServiceAccount":
			if ownerUID, ok := mounts[node.Namespace+"/"+node.Kind+"/"+node.Name]; ok {
				node.ParentUID = ownerUID
				node.Edge = EdgeMount
			}
		}
	}

	// 5. Depth, child counts and roots.
	for index := range nodes {
		if nodes[index].ParentUID == "" {
			continue
		}
		if parent, ok := byUID[nodes[index].ParentUID]; ok {
			parent.Children++
		}
	}
	var roots []string
	for index := range nodes {
		node := &nodes[index]
		node.Depth = depthOf(node, byUID, 0)
		if node.ParentUID == "" {
			roots = append(roots, node.UID)
		}
	}

	sort.Slice(nodes, func(i, j int) bool {
		if nodes[i].Depth != nodes[j].Depth {
			return nodes[i].Depth < nodes[j].Depth
		}
		if nodes[i].Kind != nodes[j].Kind {
			return kindRank(nodes[i].Kind) < kindRank(nodes[j].Kind)
		}
		return nodes[i].Name < nodes[j].Name
	})
	sort.Strings(roots)
	sort.Strings(orphans)
	return Graph{Nodes: nodes, Roots: roots, Orphans: orphans}
}

// depthOf walks up the parent chain with a guard, because a malformed
// ownerReference cycle must not hang the request.
func depthOf(node *Node, byUID map[string]*Node, guard int) int {
	if node.ParentUID == "" || guard > 32 {
		return 0
	}
	parent, ok := byUID[node.ParentUID]
	if !ok {
		return 0
	}
	return depthOf(parent, byUID, guard+1) + 1
}

// bestWorkloadFor picks the workload a Service selects. A Service selector
// matches pod labels, so the workload's pod template selector is checked first
// and a live pod second — the latter catches Services pointed at pods created
// by something this read did not cover.
func bestWorkloadFor(service *Node, workloads []*Node, pods []*Node) *Node {
	for _, workload := range workloads {
		if workload.Namespace != service.Namespace || len(workload.Selector) == 0 {
			continue
		}
		if isSubset(service.Selector, workload.Selector) {
			return workload
		}
	}
	for _, pod := range pods {
		if pod.Namespace != service.Namespace {
			continue
		}
		if isSubset(service.Selector, pod.Labels) {
			// Attach to the pod's controller if it has one, else the pod.
			return pod
		}
	}
	return nil
}

// isSubset reports whether every selector key matches, which is exactly the
// semantics of a Service selector.
func isSubset(selector, labels map[string]string) bool {
	if len(selector) == 0 {
		return false
	}
	for key, value := range selector {
		if labels[key] != value {
			return false
		}
	}
	return true
}

// mountIndex maps "namespace/Kind/name" to the UID of a workload that mounts it,
// derived from pod specs in the inventory.
func mountIndex(nodes []Node) map[string]string {
	index := map[string]string{}
	for i := range nodes {
		node := &nodes[i]
		if node.Raw == nil {
			continue
		}
		// Prefer the controller so configuration hangs off the Deployment
		// rather than off one replica.
		owner := node.UID
		if node.ParentUID != "" {
			owner = node.ParentUID
		}
		for kind, names := range referencedNames(node) {
			for _, name := range names {
				key := node.Namespace + "/" + kind + "/" + name
				if _, exists := index[key]; !exists {
					index[key] = owner
				}
			}
		}
	}
	return index
}

// referencedNames pulls volume and env references out of a pod spec. It works
// on the raw object, so it only contributes when the inventory was read with
// KeepRaw enabled — the graph degrades to fewer edges rather than being wrong.
func referencedNames(node *Node) map[string][]string {
	out := map[string][]string{}
	if node.Raw == nil {
		return out
	}
	specPaths := [][]string{
		{"spec"},
		{"spec", "template", "spec"},
	}
	for _, path := range specPaths {
		spec, found, _ := nestedMap(node.Raw.Object, path...)
		if !found {
			continue
		}
		if account, ok := spec["serviceAccountName"].(string); ok && account != "" {
			out["ServiceAccount"] = append(out["ServiceAccount"], account)
		}
		volumes, _ := spec["volumes"].([]any)
		for _, entry := range volumes {
			volume, ok := entry.(map[string]any)
			if !ok {
				continue
			}
			if source, ok := volume["configMap"].(map[string]any); ok {
				out["ConfigMap"] = append(out["ConfigMap"], stringField(source, "name"))
			}
			if source, ok := volume["secret"].(map[string]any); ok {
				out["Secret"] = append(out["Secret"], stringField(source, "secretName"))
			}
			if source, ok := volume["persistentVolumeClaim"].(map[string]any); ok {
				out["PersistentVolumeClaim"] = append(out["PersistentVolumeClaim"], stringField(source, "claimName"))
			}
		}
		containers, _ := spec["containers"].([]any)
		for _, entry := range containers {
			container, ok := entry.(map[string]any)
			if !ok {
				continue
			}
			sources, _ := container["envFrom"].([]any)
			for _, sourceEntry := range sources {
				source, ok := sourceEntry.(map[string]any)
				if !ok {
					continue
				}
				if ref, ok := source["configMapRef"].(map[string]any); ok {
					out["ConfigMap"] = append(out["ConfigMap"], stringField(ref, "name"))
				}
				if ref, ok := source["secretRef"].(map[string]any); ok {
					out["Secret"] = append(out["Secret"], stringField(ref, "name"))
				}
			}
		}
	}
	for kind, names := range out {
		out[kind] = dedupe(names)
	}
	return out
}

func nestedMap(object map[string]any, path ...string) (map[string]any, bool, error) {
	current := object
	for _, key := range path {
		next, ok := current[key].(map[string]any)
		if !ok {
			return nil, false, nil
		}
		current = next
	}
	return current, true, nil
}

func stringField(object map[string]any, key string) string {
	value, _ := object[key].(string)
	return value
}

func dedupe(values []string) []string {
	seen := map[string]bool{}
	out := values[:0]
	for _, value := range values {
		if value == "" || seen[value] {
			continue
		}
		seen[value] = true
		out = append(out, value)
	}
	return out
}

// kindRank keeps the columns in the order an operator reads them rather than
// alphabetically, which would put ConfigMap before Deployment.
func kindRank(kind string) int {
	order := []string{
		"Namespace", "CronJob", "Deployment", "StatefulSet", "DaemonSet", "Job",
		"ReplicaSet", "Pod", "Service", "Ingress", "HorizontalPodAutoscaler",
		"ConfigMap", "Secret", "PersistentVolumeClaim", "ServiceAccount",
	}
	for index, candidate := range order {
		if strings.EqualFold(kind, candidate) {
			return index
		}
	}
	return len(order)
}
