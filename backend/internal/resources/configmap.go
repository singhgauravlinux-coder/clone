package resources

import (
	"fmt"

	"github.com/example/manifest-workbench/internal/registry"
	"github.com/example/manifest-workbench/internal/validate"
	"github.com/example/manifest-workbench/internal/yamlgen"
)

func init() {
	registry.Register(&registry.Definition{
		ID:         "configmap",
		Group:      "Configuration",
		Label:      "ConfigMap",
		Summary:    "Non-confidential key/value data for pods.",
		APIVersion: "v1",
		Kinds:      []string{"ConfigMap"},
		Fields: append(metaFields(), []registry.Field{
			{
				Path: "immutable", Label: "Immutable", Kind: registry.KindBoolean, Half: true, Section: "Data",
				Help: "Blocks updates and reduces API server load.",
			},
			{
				Path: "entries", Label: "Data", Kind: registry.KindArray, Section: "Data", ItemLabel: "entry", Required: true,
				ItemFields: []registry.Field{
					{
						Path: "key", Label: "Key", Kind: registry.KindText, Mono: true, Required: true,
						Placeholder: "application.yaml", Help: `Letters, digits, "-", "_" and "." only.`,
					},
					{Path: "value", Label: "Value", Kind: registry.KindTextarea, Mono: true},
				},
			},
		}...),

		Defaults: func() registry.Model {
			return registry.Model{
				"metadata":  metaDefaults("app-config"),
				"immutable": false,
				"entries":   []any{map[string]any{"key": "LOG_LEVEL", "value": "info"}},
			}
		},

		Build: func(model registry.Model) ([]registry.File, error) {
			data := yamlgen.NewMap()
			for _, row := range registry.Rows(model, "entries") {
				if key := registry.String(row, "key"); key != "" {
					data.SetRaw(key, registry.String(row, "value"))
				}
			}
			doc := yamlgen.NewMap().
				SetRaw("apiVersion", "v1").
				SetRaw("kind", "ConfigMap").
				Set("metadata", buildMeta(model))
			if registry.Bool(model, "immutable") {
				doc.SetRaw("immutable", true)
			}
			doc.Set("data", data)

			file, err := yamlFile(slug(registry.String(model, "metadata.name"), "configmap")+"-configmap.yaml", doc)
			if err != nil {
				return nil, err
			}
			return []registry.File{file}, nil
		},

		Load: func(docs []map[string]any) (registry.Model, bool) {
			doc, ok := findDoc(docs, "ConfigMap")
			if !ok {
				return nil, false
			}
			entries := make([]any, 0, 4)
			for key, value := range registry.DocMap(doc, "data") {
				entries = append(entries, map[string]any{"key": key, "value": value})
			}
			return registry.Model{
				"metadata":  loadMeta(doc),
				"immutable": registry.Bool(registry.Model(doc), "immutable"),
				"entries":   entries,
			}, true
		},

		Check: func(model registry.Model) []validate.Issue {
			issues := checkMeta(model)
			seen := map[string]bool{}
			rows := registry.Rows(model, "entries")
			for index, row := range rows {
				path := fmt.Sprintf("entries.%d.key", index)
				key := registry.String(row, "key")
				switch {
				case key == "":
					issues = append(issues, validate.Issue{Level: validate.Error, Message: "Key is required", Path: path})
				case !validate.IsConfigKey(key):
					issues = append(issues, validate.Issue{
						Level: validate.Error, Message: fmt.Sprintf("%q is not a valid key", key), Path: path,
					})
				case seen[key]:
					issues = append(issues, validate.Issue{
						Level: validate.Error, Message: fmt.Sprintf("Key %q appears twice", key), Path: path,
					})
				}
				seen[key] = true
			}
			if len(rows) == 0 {
				issues = append(issues, validate.Issue{
					Level: validate.Warning, Message: "This ConfigMap has no data", Path: "entries",
				})
			}
			return issues
		},
	})
}
