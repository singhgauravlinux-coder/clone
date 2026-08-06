package resources

import (
	"fmt"
	"strconv"
	"strings"

	"github.com/example/manifest-workbench/internal/registry"
	"github.com/example/manifest-workbench/internal/validate"
	"github.com/example/manifest-workbench/internal/yamlgen"
)

func init() {
	registry.Register(&registry.Definition{
		ID:         "ingress",
		Group:      "Networking",
		Label:      "Ingress",
		Summary:    "HTTP routing from outside the cluster to Services.",
		APIVersion: "networking.k8s.io/v1",
		Kinds:      []string{"Ingress"},
		Fields: append(metaFields(), []registry.Field{
			{
				Path: "spec.ingressClassName", Label: "Ingress class", Kind: registry.KindText, Mono: true,
				Half: true, Section: "Controller", Placeholder: "nginx",
			},
			{
				Path: "rules", Label: "Rules", Kind: registry.KindArray, Section: "Rules",
				ItemLabel: "host rule", Required: true,
				ItemFields: []registry.Field{
					{
						Path: "host", Label: "Host", Kind: registry.KindText, Mono: true,
						Placeholder: "app.example.com", Help: "Leave empty to match any host.",
					},
					{
						Path: "paths", Label: "Paths", Kind: registry.KindArray, ItemLabel: "path",
						ItemFields: []registry.Field{
							{Path: "path", Label: "Path", Kind: registry.KindText, Mono: true, Half: true, Required: true},
							{
								Path: "pathType", Label: "Path type", Kind: registry.KindSelect, Half: true,
								Options: []registry.Option{
									{Value: "Prefix", Label: "Prefix"},
									{Value: "Exact", Label: "Exact"},
									{Value: "ImplementationSpecific", Label: "ImplementationSpecific"},
								},
							},
							{Path: "serviceName", Label: "Service", Kind: registry.KindText, Mono: true, Half: true, Required: true},
							{Path: "servicePort", Label: "Service port", Kind: registry.KindText, Mono: true, Half: true, Required: true},
						},
					},
				},
			},
			{
				Path: "tls", Label: "TLS", Kind: registry.KindArray, Section: "TLS", ItemLabel: "certificate",
				ItemFields: []registry.Field{
					{Path: "secretName", Label: "Secret name", Kind: registry.KindText, Mono: true, Half: true, Required: true},
					{Path: "hosts", Label: "Hosts", Kind: registry.KindText, Mono: true, Half: true, Help: "Comma separated."},
				},
			},
		}...),

		Defaults: func() registry.Model {
			return registry.Model{
				"metadata": metaDefaults("web"),
				"spec":     map[string]any{"ingressClassName": "nginx"},
				"rules": []any{map[string]any{
					"host": "app.example.com",
					"paths": []any{map[string]any{
						"path": "/", "pathType": "Prefix", "serviceName": "web", "servicePort": "80",
					}},
				}},
				"tls": []any{},
			}
		},

		Build: func(model registry.Model) ([]registry.File, error) {
			rules := make([]any, 0, 2)
			for _, rule := range registry.Rows(model, "rules") {
				paths := make([]any, 0, 2)
				for _, path := range registry.Rows(rule, "paths") {
					serviceName := registry.String(path, "serviceName")
					if serviceName == "" {
						continue
					}
					port := yamlgen.NewMap()
					raw := registry.String(path, "servicePort")
					if number, err := strconv.Atoi(raw); err == nil {
						port.SetRaw("number", number)
					} else {
						port.Set("name", raw)
					}
					paths = append(paths, yamlgen.NewMap().
						SetRaw("path", orDefault(registry.String(path, "path"), "/")).
						SetRaw("pathType", orDefault(registry.String(path, "pathType"), "Prefix")).
						Set("backend", yamlgen.NewMap().Set("service", yamlgen.NewMap().
							SetRaw("name", serviceName).
							Set("port", port))))
				}
				rules = append(rules, yamlgen.NewMap().
					Set("host", registry.String(rule, "host")).
					Set("http", yamlgen.NewMap().Set("paths", paths)))
			}

			tls := make([]any, 0, 1)
			for _, entry := range registry.Rows(model, "tls") {
				secret := registry.String(entry, "secretName")
				if secret == "" {
					continue
				}
				tls = append(tls, yamlgen.NewMap().
					Set("hosts", registry.List(entry, "hosts")).
					SetRaw("secretName", secret))
			}

			doc := yamlgen.NewMap().
				SetRaw("apiVersion", "networking.k8s.io/v1").
				SetRaw("kind", "Ingress").
				Set("metadata", buildMeta(model)).
				Set("spec", yamlgen.NewMap().
					Set("ingressClassName", registry.String(model, "spec.ingressClassName")).
					Set("tls", tls).
					Set("rules", rules))

			file, err := yamlFile(slug(registry.String(model, "metadata.name"), "ingress")+"-ingress.yaml", doc)
			if err != nil {
				return nil, err
			}
			return []registry.File{file}, nil
		},

		Load: func(docs []map[string]any) (registry.Model, bool) {
			doc, ok := findDoc(docs, "Ingress")
			if !ok {
				return nil, false
			}
			rules := make([]any, 0, 2)
			for _, rule := range docList(doc, "spec.rules") {
				paths := make([]any, 0, 2)
				for _, path := range docList(rule, "http.paths") {
					port := registry.DocString(path, "backend.service.port.number")
					if port == "" {
						port = registry.DocString(path, "backend.service.port.name")
					}
					paths = append(paths, map[string]any{
						"path":        orDefault(registry.DocString(path, "path"), "/"),
						"pathType":    orDefault(registry.DocString(path, "pathType"), "Prefix"),
						"serviceName": registry.DocString(path, "backend.service.name"),
						"servicePort": port,
					})
				}
				rules = append(rules, map[string]any{
					"host":  registry.DocString(rule, "host"),
					"paths": paths,
				})
			}
			tls := make([]any, 0, 1)
			for _, entry := range docList(doc, "spec.tls") {
				tls = append(tls, map[string]any{
					"secretName": registry.DocString(entry, "secretName"),
					"hosts":      strings.Join(docStrings(entry, "hosts"), ", "),
				})
			}
			return registry.Model{
				"metadata": loadMeta(doc),
				"spec":     map[string]any{"ingressClassName": registry.DocString(doc, "spec.ingressClassName")},
				"rules":    rules,
				"tls":      tls,
			}, true
		},

		Check: func(model registry.Model) []validate.Issue {
			issues := checkMeta(model)
			rules := registry.Rows(model, "rules")
			if len(rules) == 0 {
				issues = append(issues, validate.Issue{
					Level: validate.Error, Message: "At least one rule is required", Path: "rules",
				})
			}
			for index, rule := range rules {
				host := registry.String(rule, "host")
				if host != "" && !validate.IsDNSSubdomain(strings.TrimPrefix(host, "*.")) {
					issues = append(issues, validate.Issue{
						Level:   validate.Error,
						Message: fmt.Sprintf("Host %q is not a valid DNS name", host),
						Path:    fmt.Sprintf("rules.%d.host", index),
					})
				}
				paths := registry.Rows(rule, "paths")
				if len(paths) == 0 {
					issues = append(issues, validate.Issue{
						Level: validate.Error, Message: "A rule needs at least one path", Path: fmt.Sprintf("rules.%d.paths", index),
					})
				}
				for pathIndex, path := range paths {
					base := fmt.Sprintf("rules.%d.paths.%d", index, pathIndex)
					if value := registry.String(path, "path"); value != "" && !strings.HasPrefix(value, "/") {
						issues = append(issues, validate.Issue{
							Level: validate.Error, Message: `Path must start with "/"`, Path: base + ".path",
						})
					}
					issues = append(issues, validate.Name(registry.String(path, "serviceName"), base+".serviceName", "Service")...)
					if port, err := strconv.Atoi(registry.String(path, "servicePort")); err == nil {
						issues = append(issues, validate.Port(port, base+".servicePort", "Service port")...)
					}
				}
			}
			if registry.String(model, "spec.ingressClassName") == "" {
				issues = append(issues, validate.Issue{
					Level:   validate.Warning,
					Message: "No ingress class set, so the cluster default controller handles this",
					Path:    "spec.ingressClassName",
				})
			}
			return issues
		},
	})
}
