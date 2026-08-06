package resources

import (
	"github.com/example/manifest-workbench/internal/registry"
	"github.com/example/manifest-workbench/internal/validate"
	"github.com/example/manifest-workbench/internal/yamlgen"
)

func init() {
	registry.Register(&registry.Definition{
		ID:         "deployment",
		Group:      "Workloads",
		Label:      "Deployment",
		Summary:    "Stateless replicas with rolling updates.",
		APIVersion: "apps/v1",
		Kinds:      []string{"Deployment"},
		Fields: append(append(metaFields(), []registry.Field{
			{Path: "spec.replicas", Label: "Replicas", Kind: registry.KindNumber, Half: true, Min: intPtr(0), Section: "Rollout"},
			{
				Path: "spec.strategy", Label: "Strategy", Kind: registry.KindSelect, Half: true, Section: "Rollout",
				Options: []registry.Option{{Value: "RollingUpdate", Label: "RollingUpdate"}, {Value: "Recreate", Label: "Recreate"}},
			},
			{Path: "spec.maxSurge", Label: "Max surge", Kind: registry.KindText, Mono: true, Half: true, Section: "Rollout", Placeholder: "25%"},
			{Path: "spec.maxUnavailable", Label: "Max unavailable", Kind: registry.KindText, Mono: true, Half: true, Section: "Rollout", Placeholder: "25%"},
			{
				Path: "selector", Label: "Selector labels", Kind: registry.KindKeyValue, Section: "Selector", Required: true,
				Help: "Also applied to the pod template. Immutable once the object exists.",
			},
			{
				Path: "containers", Label: "Containers", Kind: registry.KindArray, Section: "Containers",
				ItemLabel: "container", Required: true, ItemFields: containerFields(),
			},
		}...), registry.Field{
			Path: "pod.serviceAccountName", Label: "Service account", Kind: registry.KindText,
			Mono: true, Half: true, Section: "Pod settings",
		}),

		Defaults: func() registry.Model {
			return registry.Model{
				"metadata": metaDefaults("web"),
				"spec": map[string]any{
					"replicas": 2, "strategy": "RollingUpdate", "maxSurge": "", "maxUnavailable": "",
				},
				"selector":   []any{map[string]any{"key": "app", "value": "web"}},
				"containers": []any{defaultContainer("web", "nginx:1.27")},
				"pod":        map[string]any{"serviceAccountName": ""},
			}
		},

		Build: func(model registry.Model) ([]registry.File, error) {
			selector := registry.Pairs(model, "selector")
			if selector == nil {
				selector = map[string]string{"app": registry.String(model, "metadata.name")}
			}

			containers := make([]any, 0, 2)
			for _, row := range registry.Rows(model, "containers") {
				containers = append(containers, buildContainer(row))
			}

			strategy := yamlgen.NewMap()
			if registry.String(model, "spec.strategy") == "Recreate" {
				strategy.SetRaw("type", "Recreate")
			} else {
				strategy.SetRaw("type", "RollingUpdate")
				strategy.Set("rollingUpdate", yamlgen.NewMap().
					Set("maxSurge", registry.String(model, "spec.maxSurge")).
					Set("maxUnavailable", registry.String(model, "spec.maxUnavailable")))
			}

			podSpec := yamlgen.NewMap().
				Set("serviceAccountName", registry.String(model, "pod.serviceAccountName")).
				Set("containers", containers)

			spec := yamlgen.NewMap()
			if replicas, ok := registry.Int(model, "spec.replicas"); ok {
				spec.SetRaw("replicas", replicas)
			}
			spec.Set("selector", yamlgen.NewMap().Set("matchLabels", selector)).
				Set("strategy", strategy).
				Set("template", yamlgen.NewMap().
					Set("metadata", yamlgen.NewMap().Set("labels", selector)).
					Set("spec", podSpec))

			doc := yamlgen.NewMap().
				SetRaw("apiVersion", "apps/v1").
				SetRaw("kind", "Deployment").
				Set("metadata", buildMeta(model)).
				Set("spec", spec)

			file, err := yamlFile(slug(registry.String(model, "metadata.name"), "deployment")+"-deployment.yaml", doc)
			if err != nil {
				return nil, err
			}
			return []registry.File{file}, nil
		},

		Load: func(docs []map[string]any) (registry.Model, bool) {
			doc, ok := findDoc(docs, "Deployment")
			if !ok {
				return nil, false
			}
			containers := make([]any, 0, 2)
			for _, container := range docList(doc, "spec.template.spec.containers") {
				containers = append(containers, loadContainer(container))
			}
			selector := registry.DocMap(doc, "spec.selector.matchLabels")
			if selector == nil {
				selector = registry.DocMap(doc, "spec.template.metadata.labels")
			}
			replicas, _ := registry.Int(registry.Model(doc), "spec.replicas")
			return registry.Model{
				"metadata": loadMeta(doc),
				"spec": map[string]any{
					"replicas":       replicas,
					"strategy":       orDefault(registry.DocString(doc, "spec.strategy.type"), "RollingUpdate"),
					"maxSurge":       registry.DocString(doc, "spec.strategy.rollingUpdate.maxSurge"),
					"maxUnavailable": registry.DocString(doc, "spec.strategy.rollingUpdate.maxUnavailable"),
				},
				"selector":   registry.PairRows(selector),
				"containers": containers,
				"pod":        map[string]any{"serviceAccountName": registry.DocString(doc, "spec.template.spec.serviceAccountName")},
			}, true
		},

		Check: func(model registry.Model) []validate.Issue {
			issues := checkMeta(model)
			issues = append(issues, checkContainers(model, "containers")...)
			if registry.Pairs(model, "selector") == nil {
				issues = append(issues, validate.Issue{
					Level: validate.Error, Message: "At least one selector label is required", Path: "selector",
				})
			}
			return issues
		},
	})
}

func orDefault(value, fallback string) string {
	if value == "" {
		return fallback
	}
	return value
}
