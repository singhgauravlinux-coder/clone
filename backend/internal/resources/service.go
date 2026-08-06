package resources

import (
	"fmt"
	"strconv"

	"github.com/example/manifest-workbench/internal/registry"
	"github.com/example/manifest-workbench/internal/validate"
	"github.com/example/manifest-workbench/internal/yamlgen"
)

func init() {
	registry.Register(&registry.Definition{
		ID:         "service",
		Group:      "Networking",
		Label:      "Service",
		Summary:    "Stable virtual IP and DNS name for a set of pods.",
		APIVersion: "v1",
		Kinds:      []string{"Service"},
		Fields: append(metaFields(), []registry.Field{
			{
				Path: "spec.type", Label: "Type", Kind: registry.KindSelect, Half: true, Section: "Routing",
				Options: []registry.Option{
					{Value: "ClusterIP", Label: "ClusterIP"},
					{Value: "NodePort", Label: "NodePort"},
					{Value: "LoadBalancer", Label: "LoadBalancer"},
					{Value: "ExternalName", Label: "ExternalName"},
				},
			},
			{
				Path: "spec.headless", Label: "Headless (clusterIP: None)", Kind: registry.KindBoolean, Half: true,
				Section: "Routing", Help: "Use for StatefulSet peer discovery.",
			},
			{
				Path: "spec.externalName", Label: "External name", Kind: registry.KindText, Mono: true,
				Section: "Routing", Placeholder: "db.example.com",
			},
			{
				Path: "selector", Label: "Pod selector", Kind: registry.KindKeyValue, Section: "Selector",
				Help: "Must match the pod labels of the workload.",
			},
			{
				Path: "ports", Label: "Ports", Kind: registry.KindArray, Section: "Ports", ItemLabel: "port",
				ItemFields: []registry.Field{
					{Path: "name", Label: "Name", Kind: registry.KindText, Mono: true, Half: true, Placeholder: "http"},
					{Path: "port", Label: "Service port", Kind: registry.KindNumber, Half: true, Required: true, Min: intPtr(1), Max: intPtr(65535)},
					{Path: "targetPort", Label: "Target port", Kind: registry.KindText, Mono: true, Half: true, Help: "Container port name or number."},
					{
						Path: "protocol", Label: "Protocol", Kind: registry.KindSelect, Half: true,
						Options: []registry.Option{{Value: "TCP", Label: "TCP"}, {Value: "UDP", Label: "UDP"}, {Value: "SCTP", Label: "SCTP"}},
					},
					{Path: "nodePort", Label: "Node port", Kind: registry.KindNumber, Half: true, Min: intPtr(30000), Max: intPtr(32767)},
				},
			},
		}...),

		Defaults: func() registry.Model {
			return registry.Model{
				"metadata": metaDefaults("web"),
				"spec":     map[string]any{"type": "ClusterIP", "headless": false, "externalName": ""},
				"selector": []any{map[string]any{"key": "app", "value": "web"}},
				"ports": []any{map[string]any{
					"name": "http", "port": 80, "targetPort": "http", "protocol": "TCP", "nodePort": "",
				}},
			}
		},

		Build: func(model registry.Model) ([]registry.File, error) {
			serviceType := orDefault(registry.String(model, "spec.type"), "ClusterIP")
			external := serviceType == "ExternalName"

			spec := yamlgen.NewMap()
			if serviceType != "ClusterIP" {
				spec.SetRaw("type", serviceType)
			}
			if !external && registry.Bool(model, "spec.headless") {
				spec.SetRaw("clusterIP", "None")
			}
			if external {
				spec.Set("externalName", registry.String(model, "spec.externalName"))
			} else {
				spec.Set("selector", registry.Pairs(model, "selector"))
				ports := make([]any, 0, 2)
				for _, row := range registry.Rows(model, "ports") {
					number, ok := registry.Int(row, "port")
					if !ok {
						continue
					}
					port := yamlgen.NewMap().Set("name", registry.String(row, "name")).SetRaw("port", number)
					if target := registry.String(row, "targetPort"); target != "" {
						if parsed, err := strconv.Atoi(target); err == nil {
							port.SetRaw("targetPort", parsed)
						} else {
							port.SetRaw("targetPort", target)
						}
					}
					if protocol := registry.String(row, "protocol"); protocol != "" && protocol != "TCP" {
						port.SetRaw("protocol", protocol)
					}
					if nodePort, ok := registry.Int(row, "nodePort"); ok {
						port.SetRaw("nodePort", nodePort)
					}
					ports = append(ports, port)
				}
				spec.Set("ports", ports)
			}

			doc := yamlgen.NewMap().
				SetRaw("apiVersion", "v1").
				SetRaw("kind", "Service").
				Set("metadata", buildMeta(model)).
				Set("spec", spec)

			file, err := yamlFile(slug(registry.String(model, "metadata.name"), "service")+"-service.yaml", doc)
			if err != nil {
				return nil, err
			}
			return []registry.File{file}, nil
		},

		Load: func(docs []map[string]any) (registry.Model, bool) {
			doc, ok := findDoc(docs, "Service")
			if !ok {
				return nil, false
			}
			ports := make([]any, 0, 2)
			for _, port := range docList(doc, "spec.ports") {
				number, _ := registry.Int(registry.Model(port), "port")
				nodePort := any("")
				if value, ok := registry.Int(registry.Model(port), "nodePort"); ok {
					nodePort = value
				}
				ports = append(ports, map[string]any{
					"name":       registry.DocString(port, "name"),
					"port":       number,
					"targetPort": registry.DocString(port, "targetPort"),
					"protocol":   orDefault(registry.DocString(port, "protocol"), "TCP"),
					"nodePort":   nodePort,
				})
			}
			return registry.Model{
				"metadata": loadMeta(doc),
				"spec": map[string]any{
					"type":         orDefault(registry.DocString(doc, "spec.type"), "ClusterIP"),
					"headless":     registry.DocString(doc, "spec.clusterIP") == "None",
					"externalName": registry.DocString(doc, "spec.externalName"),
				},
				"selector": registry.PairRows(registry.DocMap(doc, "spec.selector")),
				"ports":    ports,
			}, true
		},

		Check: func(model registry.Model) []validate.Issue {
			issues := checkMeta(model)
			serviceType := registry.String(model, "spec.type")
			ports := registry.Rows(model, "ports")
			if serviceType == "ExternalName" {
				if !validate.IsDNSSubdomain(registry.String(model, "spec.externalName")) {
					issues = append(issues, validate.Issue{
						Level: validate.Error, Message: "External name must be a DNS name", Path: "spec.externalName",
					})
				}
				return issues
			}
			if registry.Pairs(model, "selector") == nil {
				issues = append(issues, validate.Issue{
					Level: validate.Error, Message: "A Service with no selector never gets endpoints", Path: "selector",
				})
			}
			if len(ports) == 0 {
				issues = append(issues, validate.Issue{
					Level: validate.Error, Message: "At least one port is required", Path: "ports",
				})
			}
			for index, row := range ports {
				base := fmt.Sprintf("ports.%d", index)
				if number, ok := registry.Int(row, "port"); ok {
					issues = append(issues, validate.Port(number, base+".port", "Service port")...)
				}
				if len(ports) > 1 && registry.String(row, "name") == "" {
					issues = append(issues, validate.Issue{
						Level:   validate.Error,
						Message: "Every port needs a name when a Service exposes more than one",
						Path:    base + ".name",
					})
				}
				if nodePort, ok := registry.Int(row, "nodePort"); ok {
					if nodePort < 30000 || nodePort > 32767 {
						issues = append(issues, validate.Issue{
							Level: validate.Error, Message: "Node port must be between 30000 and 32767", Path: base + ".nodePort",
						})
					}
					if serviceType == "ClusterIP" {
						issues = append(issues, validate.Issue{
							Level: validate.Warning, Message: "Node ports are ignored on a ClusterIP Service", Path: base + ".nodePort",
						})
					}
				}
			}
			return issues
		},
	})
}
