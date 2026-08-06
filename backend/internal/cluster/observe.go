package cluster

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"sort"
	"strconv"
	"strings"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/fields"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/watch"
)

/*
The three things an operator opens a resource to see: what happened to it, what
it is saying, and what it is consuming.

All three are read straight from the API server on demand. None of them are
stored, because all three are cheap to refetch and expensive to keep correct.
*/

// Event is one Kubernetes event, trimmed.
type Event struct {
	Type      string    `json:"type"`
	Reason    string    `json:"reason"`
	Message   string    `json:"message"`
	Source    string    `json:"source,omitempty"`
	Count     int32     `json:"count"`
	FirstSeen time.Time `json:"firstSeen"`
	LastSeen  time.Time `json:"lastSeen"`
}

// Events returns the events attached to one object, newest first.
//
// The field selector is what keeps this cheap: asking the API server for one
// object's events rather than listing a namespace and filtering here.
func (c *Connection) Events(ctx context.Context, namespace, uid string) ([]Event, error) {
	selector := fields.OneTermEqualSelector("involvedObject.uid", uid).String()
	list, err := c.clientset.CoreV1().Events(namespace).List(ctx, metav1.ListOptions{
		FieldSelector: selector,
		Limit:         100,
	})
	if err != nil {
		return nil, fmt.Errorf("list events: %w", err)
	}
	events := make([]Event, 0, len(list.Items))
	for _, item := range list.Items {
		events = append(events, Event{
			Type:      item.Type,
			Reason:    item.Reason,
			Message:   item.Message,
			Source:    item.Source.Component,
			Count:     item.Count,
			FirstSeen: item.FirstTimestamp.Time,
			LastSeen:  lastSeen(item),
		})
	}
	sort.Slice(events, func(i, j int) bool { return events[i].LastSeen.After(events[j].LastSeen) })
	return events, nil
}

// lastSeen prefers the modern eventTime, falling back for older clusters.
func lastSeen(event corev1.Event) time.Time {
	if !event.LastTimestamp.IsZero() {
		return event.LastTimestamp.Time
	}
	if !event.EventTime.IsZero() {
		return event.EventTime.Time
	}
	return event.FirstTimestamp.Time
}

// LogOptions bounds a log read. Unbounded log reads are a denial of service on
// the platform, not on the cluster.
type LogOptions struct {
	Container string
	// TailLines caps how far back to read. Defaults to 200.
	TailLines int64
	// Since limits by age; zero means no limit.
	Since time.Duration
	// Previous reads the terminated instance, which is where a CrashLoopBackOff
	// actually explains itself.
	Previous bool
	Follow   bool
	// Timestamps prefixes each line with the container's own clock.
	Timestamps bool
}

// Logs opens a log stream for one pod container. The caller closes it.
func (c *Connection) Logs(ctx context.Context, namespace, pod string, options LogOptions) (io.ReadCloser, error) {
	if options.TailLines <= 0 {
		options.TailLines = 200
	}
	request := c.clientset.CoreV1().Pods(namespace).GetLogs(pod, &corev1.PodLogOptions{
		Container:  options.Container,
		TailLines:  &options.TailLines,
		Previous:   options.Previous,
		Follow:     options.Follow,
		Timestamps: options.Timestamps,
		SinceSeconds: func() *int64 {
			if options.Since <= 0 {
				return nil
			}
			seconds := int64(options.Since.Seconds())
			return &seconds
		}(),
	})
	stream, err := request.Stream(ctx)
	if err != nil {
		return nil, fmt.Errorf("open log stream for %s/%s: %w", namespace, pod, err)
	}
	return stream, nil
}

// LogLines drains a bounded number of lines. Used for the non-follow case,
// where holding the stream open buys nothing.
func (c *Connection) LogLines(ctx context.Context, namespace, pod string, options LogOptions) ([]string, error) {
	options.Follow = false
	stream, err := c.Logs(ctx, namespace, pod, options)
	if err != nil {
		return nil, err
	}
	defer stream.Close()

	scanner := bufio.NewScanner(stream)
	// A single log line can legitimately be long; the default 64 KiB token
	// limit turns that into a confusing truncation error.
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	lines := make([]string, 0, options.TailLines)
	for scanner.Scan() {
		lines = append(lines, scanner.Text())
		if int64(len(lines)) >= options.TailLines {
			break
		}
	}
	if err := scanner.Err(); err != nil && err != io.EOF {
		return lines, fmt.Errorf("read log stream: %w", err)
	}
	return lines, nil
}

var metricsPodGVR = schema.GroupVersionResource{
	Group: "metrics.k8s.io", Version: "v1beta1", Resource: "pods",
}

// PodMetric is one sample from metrics-server.
type PodMetric struct {
	Namespace string `json:"namespace"`
	Pod       string `json:"pod"`
	Container string `json:"container,omitempty"`
	// CPU in millicores, memory in mebibytes: the units the UI displays.
	CPUMillicores int64 `json:"cpuMillicores"`
	MemoryMiB     int64 `json:"memoryMiB"`
}

// Metrics reads current usage from metrics.k8s.io.
//
// metrics-server is optional in a cluster, so a missing API is reported as a
// clean "unavailable" rather than an error: the resource view still works, it
// just has no graph.
func (c *Connection) Metrics(ctx context.Context, namespace string) ([]PodMetric, error) {
	list, err := c.dynamic.Resource(metricsPodGVR).Namespace(namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("metrics unavailable: %w", err)
	}
	var samples []PodMetric
	for index := range list.Items {
		item := &list.Items[index]
		containers, _, _ := unstructured.NestedSlice(item.Object, "containers")
		for _, entry := range containers {
			container, ok := entry.(map[string]any)
			if !ok {
				continue
			}
			usage, _ := container["usage"].(map[string]any)
			samples = append(samples, PodMetric{
				Namespace:     item.GetNamespace(),
				Pod:           item.GetName(),
				Container:     stringField(container, "name"),
				CPUMillicores: parseCPU(stringField(usage, "cpu")),
				MemoryMiB:     parseMemory(stringField(usage, "memory")),
			})
		}
	}
	return samples, nil
}

// parseCPU converts a quantity such as "137m" or "1" into millicores. Using the
// resource.Quantity parser would be more general; these two forms are the only
// ones metrics-server emits and this avoids a dependency in a hot path.
func parseCPU(value string) int64 {
	switch {
	case value == "":
		return 0
	case strings.HasSuffix(value, "n"):
		nanos, _ := strconv.ParseInt(strings.TrimSuffix(value, "n"), 10, 64)
		return nanos / 1_000_000
	case strings.HasSuffix(value, "u"):
		micros, _ := strconv.ParseInt(strings.TrimSuffix(value, "u"), 10, 64)
		return micros / 1_000
	case strings.HasSuffix(value, "m"):
		millis, _ := strconv.ParseInt(strings.TrimSuffix(value, "m"), 10, 64)
		return millis
	default:
		cores, _ := strconv.ParseFloat(value, 64)
		return int64(cores * 1000)
	}
}

func parseMemory(value string) int64 {
	suffixes := []struct {
		suffix string
		factor int64
	}{
		{"Ki", 1024}, {"Mi", 1024 * 1024}, {"Gi", 1024 * 1024 * 1024},
		{"K", 1000}, {"M", 1000 * 1000}, {"G", 1000 * 1000 * 1000},
	}
	for _, entry := range suffixes {
		if strings.HasSuffix(value, entry.suffix) {
			amount, _ := strconv.ParseInt(strings.TrimSuffix(value, entry.suffix), 10, 64)
			return amount * entry.factor / (1024 * 1024)
		}
	}
	bytes, _ := strconv.ParseInt(value, 10, 64)
	return bytes / (1024 * 1024)
}

// Change is one observed mutation, delivered to the UI over SSE.
type Change struct {
	Type   watch.EventType `json:"type"`
	Object Object          `json:"object"`
}

// Watch streams changes for one kind, resuming from a resourceVersion.
//
// This is the incremental half of the inventory: a full read establishes state,
// then a watch keeps it current without re-listing. The caller re-lists when the
// channel closes with a 410 Gone, which is the API server saying the requested
// resourceVersion has aged out of etcd's window.
func (c *Connection) Watch(ctx context.Context, resource APIResource, namespace, resourceVersion string, out chan<- Change) error {
	options := metav1.ListOptions{
		ResourceVersion: resourceVersion,
		// Bookmarks let the server advance our resourceVersion during quiet
		// periods, so a reconnect after an idle hour does not need a full list.
		AllowWatchBookmarks: true,
		TimeoutSeconds:      int64Ptr(1800),
	}

	client := c.dynamic.Resource(resource.GVR)
	var (
		watcher watch.Interface
		err     error
	)
	if resource.Namespaced && namespace != "" {
		watcher, err = client.Namespace(namespace).Watch(ctx, options)
	} else {
		watcher, err = client.Watch(ctx, options)
	}
	if err != nil {
		return fmt.Errorf("watch %s: %w", resource.Kind, err)
	}
	defer watcher.Stop()

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case event, open := <-watcher.ResultChan():
			if !open {
				return nil
			}
			if event.Type == watch.Bookmark {
				continue
			}
			if event.Type == watch.Error {
				return fmt.Errorf("watch %s failed, re-list required", resource.Kind)
			}
			object, ok := event.Object.(*unstructured.Unstructured)
			if !ok {
				continue
			}
			select {
			case out <- Change{Type: event.Type, Object: summariseObject(object, false)}:
			case <-ctx.Done():
				return ctx.Err()
			}
		}
	}
}

func int64Ptr(value int64) *int64 { return &value }
