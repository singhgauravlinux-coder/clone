// Package registry holds the catalogue of resource definitions. A definition
// owns its form schema, its renderer and its rules, so adding a resource type
// means adding one file and calling Register from its init function.
package registry

import (
	"fmt"
	"sort"
	"sync"

	"github.com/example/manifest-workbench/internal/validate"
)

// FieldKind mirrors the control the frontend renders.
type FieldKind string

// Supported field kinds.
const (
	KindText       FieldKind = "text"
	KindTextarea   FieldKind = "textarea"
	KindNumber     FieldKind = "number"
	KindBoolean    FieldKind = "boolean"
	KindSelect     FieldKind = "select"
	KindKeyValue   FieldKind = "keyvalue"
	KindStringList FieldKind = "stringlist"
	KindArray      FieldKind = "array"
)

// Option is one choice in a select or string list.
type Option struct {
	Value string `json:"value"`
	Label string `json:"label"`
	Help  string `json:"help,omitempty"`
}

// Field describes one control in the generated form.
type Field struct {
	Path        string    `json:"path"`
	Label       string    `json:"label"`
	Kind        FieldKind `json:"kind"`
	Help        string    `json:"help,omitempty"`
	Placeholder string    `json:"placeholder,omitempty"`
	Required    bool      `json:"required,omitempty"`
	Section     string    `json:"section,omitempty"`
	Half        bool      `json:"half,omitempty"`
	Mono        bool      `json:"mono,omitempty"`
	Options     []Option  `json:"options,omitempty"`
	Min         *int      `json:"min,omitempty"`
	Max         *int      `json:"max,omitempty"`
	ItemLabel   string    `json:"itemLabel,omitempty"`
	ItemFields  []Field   `json:"itemFields,omitempty"`
}

// File is one generated artefact.
type File struct {
	Path     string `json:"path"`
	Content  string `json:"content"`
	Language string `json:"language"`
}

// Definition is everything the service knows about one resource type.
type Definition struct {
	ID         string   `json:"id"`
	Group      string   `json:"group"`
	Label      string   `json:"label"`
	Summary    string   `json:"summary"`
	APIVersion string   `json:"apiVersion,omitempty"`
	Kinds      []string `json:"kinds,omitempty"`
	Fields     []Field  `json:"fields"`

	// Defaults returns a fresh model for a new document.
	Defaults func() Model `json:"-"`
	// Build renders the model. It must never contact a cluster.
	Build func(Model) ([]File, error) `json:"-"`
	// Load fills a model from parsed YAML documents. ok is false when the
	// documents do not match this definition.
	Load func(docs []map[string]any) (model Model, ok bool) `json:"-"`
	// Check holds rules beyond the required-field sweep.
	Check func(Model) []validate.Issue `json:"-"`
}

var (
	mu      sync.RWMutex
	byID    = map[string]*Definition{}
	ordered []*Definition
)

// Register adds a definition to the catalogue. It panics on a duplicate ID,
// because that can only be a programming mistake at start up.
func Register(definition *Definition) {
	mu.Lock()
	defer mu.Unlock()
	if _, exists := byID[definition.ID]; exists {
		panic(fmt.Sprintf("registry: duplicate resource id %q", definition.ID))
	}
	byID[definition.ID] = definition
	ordered = append(ordered, definition)
}

// All returns the catalogue in registration order.
func All() []*Definition {
	mu.RLock()
	defer mu.RUnlock()
	out := make([]*Definition, len(ordered))
	copy(out, ordered)
	return out
}

// Get looks up one definition.
func Get(id string) (*Definition, bool) {
	mu.RLock()
	defer mu.RUnlock()
	definition, ok := byID[id]
	return definition, ok
}

// Group is a set of definitions shown together in the sidebar.
type Group struct {
	Name  string        `json:"name"`
	Items []*Definition `json:"items"`
}

// Groups returns the catalogue grouped for display.
func Groups() []Group {
	var groups []Group
	for _, definition := range All() {
		found := false
		for index := range groups {
			if groups[index].Name == definition.Group {
				groups[index].Items = append(groups[index].Items, definition)
				found = true
				break
			}
		}
		if !found {
			groups = append(groups, Group{Name: definition.Group, Items: []*Definition{definition}})
		}
	}
	return groups
}

// Generate renders a model into files.
func Generate(definition *Definition, model Model) ([]File, error) {
	files, err := definition.Build(model)
	if err != nil {
		return nil, err
	}
	return files, nil
}

// Validate runs the required-field sweep followed by the definition's own rules.
func Validate(definition *Definition, model Model) []validate.Issue {
	issues := requiredSweep(definition.Fields, model, "")
	if definition.Check != nil {
		issues = append(issues, definition.Check(model)...)
	}
	return validate.Sort(issues)
}

func requiredSweep(fields []Field, model Model, prefix string) []validate.Issue {
	var issues []validate.Issue
	for _, field := range fields {
		value := Get(model, field.Path)
		path := prefix + field.Path
		if field.Required && isBlank(value) {
			issues = append(issues, validate.Issue{
				Level:   validate.Error,
				Message: field.Label + " is required",
				Path:    path,
			})
		}
		if field.Kind == KindArray && len(field.ItemFields) > 0 {
			for index, row := range Rows(model, field.Path) {
				issues = append(issues, requiredSweep(field.ItemFields, row, fmt.Sprintf("%s.%d.", path, index))...)
			}
		}
	}
	return issues
}

func isBlank(value any) bool {
	switch typed := value.(type) {
	case nil:
		return true
	case string:
		return typed == ""
	case []any:
		return len(typed) == 0
	case map[string]any:
		return len(typed) == 0
	default:
		return false
	}
}

// Import matches parsed documents to a definition and fills in a model.
// Definitions that declare a matching kind are tried first, so the two
// kind-less formats act as fallbacks.
func Import(docs []map[string]any) (*Definition, Model, []string, error) {
	if len(docs) == 0 {
		return nil, nil, nil, fmt.Errorf("no YAML documents found")
	}
	kinds := map[string]bool{}
	for _, doc := range docs {
		if kind, ok := doc["kind"].(string); ok && kind != "" {
			kinds[kind] = true
		}
	}
	candidates := All()
	sort.SliceStable(candidates, func(i, j int) bool {
		return matchesKind(candidates[i], kinds) && !matchesKind(candidates[j], kinds)
	})
	for _, definition := range candidates {
		if definition.Load == nil {
			continue
		}
		model, ok := definition.Load(docs)
		if !ok {
			continue
		}
		covered := map[string]bool{}
		for _, kind := range definition.Kinds {
			covered[kind] = true
		}
		var ignored []string
		for kind := range kinds {
			if !covered[kind] {
				ignored = append(ignored, kind)
			}
		}
		sort.Strings(ignored)
		return definition, model, ignored, nil
	}
	names := make([]string, 0, len(kinds))
	for kind := range kinds {
		names = append(names, kind)
	}
	sort.Strings(names)
	if len(names) == 0 {
		return nil, nil, nil, fmt.Errorf("this document does not look like a resource this service can edit")
	}
	return nil, nil, nil, fmt.Errorf("no form matches kind %v", names)
}

func matchesKind(definition *Definition, kinds map[string]bool) bool {
	for _, kind := range definition.Kinds {
		if kinds[kind] {
			return true
		}
	}
	return false
}
