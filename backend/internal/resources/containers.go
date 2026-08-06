package resources

import (
	"fmt"

	"github.com/example/manifest-workbench/internal/registry"
	"github.com/example/manifest-workbench/internal/validate"
	"github.com/example/manifest-workbench/internal/yamlgen"
)

func containerFields() []registry.Field {
	return []registry.Field{
		{Path: "name", Label: "Container name", Kind: registry.KindText, Required: true, Mono: true, Half: true},
		{Path: "image", Label: "Image", Kind: registry.KindText, Required: true, Mono: true, Half: true, Placeholder: "nginx:1.27"},
		{
			Path: "imagePullPolicy", Label: "Pull policy", Kind: registry.KindSelect, Half: true,
			Options: []registry.Option{
				{Value: "", Label: "Cluster default"},
				{Value: "IfNotPresent", Label: "IfNotPresent"},
				{Value: "Always", Label: "Always"},
				{Value: "Never", Label: "Never"},
			},
		},
		{Path: "command", Label: "Command (entrypoint)", Kind: registry.KindText, Mono: true, Half: true, Help: "Comma separated."},
		{Path: "args", Label: "Args", Kind: registry.KindText, Mono: true, Help: "Comma separated."},
		{
			Path: "ports", Label: "Container ports", Kind: registry.KindArray, ItemLabel: "port",
			ItemFields: []registry.Field{
				{Path: "name", Label: "Name", Kind: registry.KindText, Mono: true, Half: true, Placeholder: "http"},
				{Path: "containerPort", Label: "Port", Kind: registry.KindNumber, Half: true, Required: true, Min: intPtr(1), Max: intPtr(65535)},
				{
					Path: "protocol", Label: "Protocol", Kind: registry.KindSelect, Half: true,
					Options: []registry.Option{{Value: "TCP", Label: "TCP"}, {Value: "UDP", Label: "UDP"}, {Value: "SCTP", Label: "SCTP"}},
				},
			},
		},
		{Path: "env", Label: "Environment variables", Kind: registry.KindKeyValue, Help: "Literal values only."},
		{Path: "resources.requests.cpu", Label: "CPU request", Kind: registry.KindText, Mono: true, Half: true, Placeholder: "100m"},
		{Path: "resources.requests.memory", Label: "Memory request", Kind: registry.KindText, Mono: true, Half: true, Placeholder: "128Mi"},
		{Path: "resources.limits.cpu", Label: "CPU limit", Kind: registry.KindText, Mono: true, Half: true},
		{Path: "resources.limits.memory", Label: "Memory limit", Kind: registry.KindText, Mono: true, Half: true, Placeholder: "512Mi"},
		{
			Path: "volumeMounts", Label: "Volume mounts", Kind: registry.KindArray, ItemLabel: "mount",
			ItemFields: []registry.Field{
				{Path: "name", Label: "Volume name", Kind: registry.KindText, Mono: true, Half: true, Required: true},
				{Path: "mountPath", Label: "Mount path", Kind: registry.KindText, Mono: true, Half: true, Required: true, Placeholder: "/data"},
				{Path: "readOnly", Label: "Read only", Kind: registry.KindBoolean, Half: true},
			},
		},
	}
}

func defaultContainer(name, image string) map[string]any {
	return map[string]any{
		"name":            name,
		"image":           image,
		"imagePullPolicy": "",
		"command":         "",
		"args":            "",
		"ports":           []any{map[string]any{"name": "http", "containerPort": 8080, "protocol": "TCP"}},
		"env":             []any{},
		"resources": map[string]any{
			"requests": map[string]any{"cpu": "100m", "memory": "128Mi"},
			"limits":   map[string]any{"cpu": "", "memory": "512Mi"},
		},
		"volumeMounts": []any{},
	}
}

func buildContainer(model registry.Model) *yamlgen.Map {
	container := yamlgen.NewMap().
		Set("name", registry.String(model, "name")).
		Set("image", registry.String(model, "image")).
		Set("imagePullPolicy", registry.String(model, "imagePullPolicy")).
		Set("command", registry.List(model, "command")).
		Set("args", registry.List(model, "args"))

	ports := make([]any, 0, 2)
	for _, row := range registry.Rows(model, "ports") {
		number, ok := registry.Int(row, "containerPort")
		if !ok {
			continue
		}
		port := yamlgen.NewMap().Set("name", registry.String(row, "name")).SetRaw("containerPort", number)
		if protocol := registry.String(row, "protocol"); protocol != "" && protocol != "TCP" {
			port.Set("protocol", protocol)
		}
		ports = append(ports, port)
	}
	container.Set("ports", ports)

	env := make([]any, 0, 4)
	for _, row := range registry.Rows(model, "env") {
		name := registry.String(row, "key")
		if name == "" {
			continue
		}
		env = append(env, yamlgen.NewMap().SetRaw("name", name).SetRaw("value", registry.String(row, "value")))
	}
	container.Set("env", env)

	requests := yamlgen.NewMap().
		Set("cpu", registry.String(model, "resources.requests.cpu")).
		Set("memory", registry.String(model, "resources.requests.memory"))
	limits := yamlgen.NewMap().
		Set("cpu", registry.String(model, "resources.limits.cpu")).
		Set("memory", registry.String(model, "resources.limits.memory"))
	container.Set("resources", yamlgen.NewMap().Set("requests", requests).Set("limits", limits))

	mounts := make([]any, 0, 2)
	for _, row := range registry.Rows(model, "volumeMounts") {
		name, path := registry.String(row, "name"), registry.String(row, "mountPath")
		if name == "" || path == "" {
			continue
		}
		mount := yamlgen.NewMap().SetRaw("name", name).SetRaw("mountPath", path)
		if registry.Bool(row, "readOnly") {
			mount.SetRaw("readOnly", true)
		}
		mounts = append(mounts, mount)
	}
	container.Set("volumeMounts", mounts)

	return container
}

func loadContainer(doc map[string]any) map[string]any {
	model := registry.Model(doc)
	ports := make([]any, 0, 2)
	for _, port := range docList(doc, "ports") {
		number, _ := registry.Int(registry.Model(port), "containerPort")
		protocol := registry.DocString(port, "protocol")
		if protocol == "" {
			protocol = "TCP"
		}
		ports = append(ports, map[string]any{
			"name":          registry.DocString(port, "name"),
			"containerPort": number,
			"protocol":      protocol,
		})
	}
	env := make([]any, 0, 4)
	for _, entry := range docList(doc, "env") {
		if _, isRef := entry["valueFrom"]; isRef {
			continue
		}
		env = append(env, map[string]any{
			"key":   registry.DocString(entry, "name"),
			"value": registry.DocString(entry, "value"),
		})
	}
	mounts := make([]any, 0, 2)
	for _, mount := range docList(doc, "volumeMounts") {
		mounts = append(mounts, map[string]any{
			"name":      registry.DocString(mount, "name"),
			"mountPath": registry.DocString(mount, "mountPath"),
			"readOnly":  registry.Bool(registry.Model(mount), "readOnly"),
		})
	}
	return map[string]any{
		"name":            registry.String(model, "name"),
		"image":           registry.String(model, "image"),
		"imagePullPolicy": registry.String(model, "imagePullPolicy"),
		"command":         joinList(docStrings(doc, "command")),
		"args":            joinList(docStrings(doc, "args")),
		"ports":           ports,
		"env":             env,
		"resources": map[string]any{
			"requests": map[string]any{
				"cpu":    registry.String(model, "resources.requests.cpu"),
				"memory": registry.String(model, "resources.requests.memory"),
			},
			"limits": map[string]any{
				"cpu":    registry.String(model, "resources.limits.cpu"),
				"memory": registry.String(model, "resources.limits.memory"),
			},
		},
		"volumeMounts": mounts,
	}
}

func checkContainers(model registry.Model, path string) []validate.Issue {
	rows := registry.Rows(model, path)
	var issues []validate.Issue
	if len(rows) == 0 {
		return []validate.Issue{{Level: validate.Error, Message: "At least one container is required", Path: path}}
	}
	seen := map[string]bool{}
	for index, row := range rows {
		base := fmt.Sprintf("%s.%d", path, index)
		name := registry.String(row, "name")
		issues = append(issues, validate.Name(name, base+".name", "Container name")...)
		if name != "" && seen[name] {
			issues = append(issues, validate.Issue{
				Level:   validate.Error,
				Message: fmt.Sprintf("Container name %q is used twice", name),
				Path:    base + ".name",
			})
		}
		seen[name] = true
		issues = append(issues, validate.Image(registry.String(row, "image"), base+".image")...)
		for portIndex, port := range registry.Rows(row, "ports") {
			if number, ok := registry.Int(port, "containerPort"); ok {
				issues = append(issues, validate.Port(number, fmt.Sprintf("%s.ports.%d.containerPort", base, portIndex), "Container port")...)
			}
		}
		for _, key := range []string{"requests.cpu", "requests.memory", "limits.cpu", "limits.memory"} {
			issues = append(issues, validate.Quantity(
				registry.String(row, "resources."+key),
				base+".resources."+key,
				key,
			)...)
		}
		if registry.String(row, "resources.requests.cpu") == "" && registry.String(row, "resources.limits.cpu") == "" {
			issues = append(issues, validate.Issue{
				Level:   validate.Warning,
				Message: fmt.Sprintf("Container %q has no CPU request, so the scheduler treats it as best effort", name),
				Path:    base + ".resources.requests.cpu",
			})
		}
	}
	return issues
}

func docStrings(doc map[string]any, key string) []string {
	raw, ok := doc[key].([]any)
	if !ok {
		return nil
	}
	out := make([]string, 0, len(raw))
	for _, item := range raw {
		if text, ok := item.(string); ok {
			out = append(out, text)
		}
	}
	return out
}

func joinList(values []string) string {
	result := ""
	for index, value := range values {
		if index > 0 {
			result += ", "
		}
		result += value
	}
	return result
}
