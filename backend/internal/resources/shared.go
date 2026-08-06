// Package resources holds one file per resource type. Each file registers its
// definition in an init function, so main only has to import this package.
package resources

import (
	"strings"

	"github.com/example/manifest-workbench/internal/registry"
	"github.com/example/manifest-workbench/internal/validate"
	"github.com/example/manifest-workbench/internal/yamlgen"
)

func intPtr(value int) *int { return &value }

// slug turns a resource name into a safe file name so a bundle stays readable
// in Git.
func slug(value, fallback string) string {
	var out []rune
	for _, r := range strings.ToLower(strings.TrimSpace(value)) {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9', r == '.', r == '_', r == '-':
			out = append(out, r)
		default:
			out = append(out, '-')
		}
	}
	cleaned := strings.Trim(string(out), "-")
	if cleaned == "" {
		return fallback
	}
	return cleaned
}

// metaFields returns the standard name, namespace, labels and annotations
// controls that every namespaced object shares.
func metaFields() []registry.Field {
	return []registry.Field{
		{
			Path: "metadata.name", Label: "Name", Kind: registry.KindText, Required: true,
			Mono: true, Half: true, Section: "Metadata", Placeholder: "web",
			Help: `Lowercase letters, numbers, "-" and "." only.`,
		},
		{
			Path: "metadata.namespace", Label: "Namespace", Kind: registry.KindText,
			Mono: true, Half: true, Section: "Metadata", Placeholder: "default",
			Help: "Leave empty to let the applying tool choose.",
		},
		{Path: "metadata.labels", Label: "Labels", Kind: registry.KindKeyValue, Section: "Metadata"},
		{Path: "metadata.annotations", Label: "Annotations", Kind: registry.KindKeyValue, Section: "Metadata"},
	}
}

func metaDefaults(name string) map[string]any {
	return map[string]any{
		"name":        name,
		"namespace":   "",
		"labels":      []any{map[string]any{"key": "app", "value": name}},
		"annotations": []any{},
	}
}

func buildMeta(model registry.Model) *yamlgen.Map {
	return yamlgen.NewMap().
		Set("name", registry.String(model, "metadata.name")).
		Set("namespace", registry.String(model, "metadata.namespace")).
		Set("labels", registry.Pairs(model, "metadata.labels")).
		Set("annotations", registry.Pairs(model, "metadata.annotations"))
}

func loadMeta(doc map[string]any) map[string]any {
	return map[string]any{
		"name":        registry.DocString(doc, "metadata.name"),
		"namespace":   registry.DocString(doc, "metadata.namespace"),
		"labels":      registry.PairRows(registry.DocMap(doc, "metadata.labels")),
		"annotations": registry.PairRows(registry.DocMap(doc, "metadata.annotations")),
	}
}

func checkMeta(model registry.Model) []validate.Issue {
	issues := validate.Name(registry.String(model, "metadata.name"), "metadata.name", "Name")
	if namespace := registry.String(model, "metadata.namespace"); namespace != "" {
		issues = append(issues, validate.Name(namespace, "metadata.namespace", "Namespace")...)
	}
	issues = append(issues, validate.Labels(registry.Pairs(model, "metadata.labels"), "metadata.labels", "Labels")...)
	issues = append(issues, validate.Labels(registry.Pairs(model, "metadata.annotations"), "metadata.annotations", "Annotations")...)
	return issues
}

// findDoc returns the first document with one of the given kinds.
func findDoc(docs []map[string]any, kinds ...string) (map[string]any, bool) {
	for _, doc := range docs {
		kind, _ := doc["kind"].(string)
		for _, wanted := range kinds {
			if kind == wanted {
				return doc, true
			}
		}
	}
	return nil, false
}

// docList reads a slice of sub-documents, e.g. spec.template.spec.containers.
func docList(doc map[string]any, path string) []map[string]any {
	raw, ok := registry.Get(registry.Model(doc), path).([]any)
	if !ok {
		return nil
	}
	out := make([]map[string]any, 0, len(raw))
	for _, item := range raw {
		if entry, ok := item.(map[string]any); ok {
			out = append(out, entry)
		}
	}
	return out
}

// yamlFile renders one document into a generated file.
func yamlFile(path string, doc any) (registry.File, error) {
	content, err := yamlgen.Render(doc)
	if err != nil {
		return registry.File{}, err
	}
	return registry.File{Path: path, Content: content, Language: "yaml"}, nil
}
