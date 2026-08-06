// Package validate holds the field rules that the API server would apply at
// admission time, so a manifest can be checked without a cluster.
package validate

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

// Level marks whether an issue blocks or merely warns.
type Level string

const (
	// Error means the manifest would be rejected.
	Error Level = "error"
	// Warning means the manifest applies but is probably not what you want.
	Warning Level = "warning"
)

// Issue is one validation finding tied to a form field path.
type Issue struct {
	Level   Level  `json:"level"`
	Message string `json:"message"`
	Path    string `json:"path,omitempty"`
}

var (
	dns1123Subdomain = regexp.MustCompile(`^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$`)
	dns1123Label     = regexp.MustCompile(`^[a-z0-9]([-a-z0-9]*[a-z0-9])?$`)
	labelKey         = regexp.MustCompile(`^([a-z0-9]([-a-z0-9.]*[a-z0-9])?/)?[A-Za-z0-9]([-A-Za-z0-9_.]*[A-Za-z0-9])?$`)
	labelValue       = regexp.MustCompile(`^([A-Za-z0-9]([-A-Za-z0-9_.]*[A-Za-z0-9])?)?$`)
	quantity         = regexp.MustCompile(`^[+-]?(\d+(\.\d*)?|\.\d+)(([EPTGMK]i?)|[munp]|[eE][+-]?\d+)?$`)
	configKey        = regexp.MustCompile(`^[-._a-zA-Z0-9]+$`)
)

// IsDNSSubdomain reports whether name is a valid object name.
func IsDNSSubdomain(name string) bool { return dns1123Subdomain.MatchString(name) }

// IsDNSLabel reports whether name fits in a single DNS label.
func IsDNSLabel(name string) bool { return dns1123Label.MatchString(name) }

// IsConfigKey reports whether key is usable in ConfigMap or Secret data.
func IsConfigKey(key string) bool { return configKey.MatchString(key) }

// Name checks an object name and returns any problems.
func Name(value, path, label string) []Issue {
	name := strings.TrimSpace(value)
	if label == "" {
		label = "Name"
	}
	if name == "" {
		return []Issue{{Level: Error, Message: label + " is required", Path: path}}
	}
	var issues []Issue
	if len(name) > 253 {
		issues = append(issues, Issue{Level: Error, Message: label + " must be 253 characters or fewer", Path: path})
	}
	if !dns1123Subdomain.MatchString(name) {
		issues = append(issues, Issue{
			Level:   Error,
			Message: label + ` must be lowercase alphanumerics, "-" or ".", starting and ending with an alphanumeric`,
			Path:    path,
		})
	}
	return issues
}

// Labels checks label keys and values.
func Labels(values map[string]string, path, label string) []Issue {
	if label == "" {
		label = "Labels"
	}
	var issues []Issue
	for key, value := range values {
		if !labelKey.MatchString(key) {
			issues = append(issues, Issue{Level: Error, Message: fmt.Sprintf("%s: %q is not a valid key", label, key), Path: path})
		}
		if !labelValue.MatchString(value) {
			issues = append(issues, Issue{Level: Error, Message: fmt.Sprintf("%s: value for %q has invalid characters", label, key), Path: path})
		}
	}
	return issues
}

// Port checks that a port number is in range.
func Port(value int, path, label string) []Issue {
	if label == "" {
		label = "Port"
	}
	if value < 1 || value > 65535 {
		return []Issue{{Level: Error, Message: label + " must be an integer between 1 and 65535", Path: path}}
	}
	return nil
}

// Quantity checks a resource quantity such as 100m or 256Mi.
func Quantity(value, path, label string) []Issue {
	text := strings.TrimSpace(value)
	if text == "" {
		return nil
	}
	if !quantity.MatchString(text) {
		return []Issue{{
			Level:   Error,
			Message: fmt.Sprintf("%s: %q is not a valid quantity (try 100m, 1, 256Mi, 2Gi)", label, text),
			Path:    path,
		}}
	}
	return nil
}

// Image checks an image reference and warns about floating tags.
func Image(value, path string) []Issue {
	image := strings.TrimSpace(value)
	if image == "" {
		return []Issue{{Level: Error, Message: "Image is required", Path: path}}
	}
	var issues []Issue
	if strings.ContainsAny(image, " \t") {
		issues = append(issues, Issue{Level: Error, Message: "Image reference cannot contain spaces", Path: path})
	}
	parts := strings.Split(image, "/")
	last := parts[len(parts)-1]
	switch {
	case !strings.Contains(last, ":") && !strings.Contains(image, "@"):
		issues = append(issues, Issue{
			Level:   Warning,
			Message: fmt.Sprintf("Image %q has no tag, so it resolves to :latest", image),
			Path:    path,
		})
	case strings.HasSuffix(last, ":latest"):
		issues = append(issues, Issue{
			Level:   Warning,
			Message: "Pinning :latest makes rollouts unreproducible",
			Path:    path,
		})
	}
	return issues
}

// Schedule checks a five field cron expression or a shorthand alias.
func Schedule(value, path string) []Issue {
	schedule := strings.TrimSpace(value)
	if schedule == "" {
		return []Issue{{Level: Error, Message: "Schedule is required", Path: path}}
	}
	if strings.HasPrefix(schedule, "@") {
		switch schedule {
		case "@yearly", "@annually", "@monthly", "@weekly", "@daily", "@midnight", "@hourly":
			return nil
		}
		return []Issue{{Level: Error, Message: "Unknown schedule alias " + schedule, Path: path}}
	}
	fields := strings.Fields(schedule)
	if len(fields) != 5 {
		return []Issue{{Level: Error, Message: "Schedule needs five fields: minute hour day-of-month month day-of-week", Path: path}}
	}
	bounds := [5][2]int{{0, 59}, {0, 23}, {1, 31}, {1, 12}, {0, 7}}
	var issues []Issue
	for index, field := range fields {
		if !cronFieldOK(field, bounds[index][0], bounds[index][1]) {
			issues = append(issues, Issue{
				Level:   Error,
				Message: fmt.Sprintf("Schedule field %d (%q) is out of range %d-%d", index+1, field, bounds[index][0], bounds[index][1]),
				Path:    path,
			})
		}
	}
	return issues
}

func cronFieldOK(field string, min, max int) bool {
	for _, chunk := range strings.Split(field, ",") {
		spec := chunk
		if slash := strings.Index(chunk, "/"); slash >= 0 {
			step := chunk[slash+1:]
			if _, err := strconv.Atoi(step); err != nil {
				return false
			}
			spec = chunk[:slash]
		}
		if spec == "*" {
			continue
		}
		for _, bound := range strings.Split(spec, "-") {
			number, err := strconv.Atoi(bound)
			if err != nil || number < min || number > max {
				return false
			}
		}
	}
	return true
}

// Sort puts errors before warnings without disturbing order inside a level.
func Sort(issues []Issue) []Issue {
	sorted := make([]Issue, 0, len(issues))
	seen := map[string]bool{}
	for _, level := range []Level{Error, Warning} {
		for _, issue := range issues {
			if issue.Level != level {
				continue
			}
			key := string(issue.Level) + "|" + issue.Path + "|" + issue.Message
			if seen[key] {
				continue
			}
			seen[key] = true
			sorted = append(sorted, issue)
		}
	}
	return sorted
}
