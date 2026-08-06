// Package yamlgen renders manifests with a stable key order.
//
// Kubernetes objects read badly when apiVersion, kind and metadata come out in
// whatever order a Go map iterates, and a shuffled file produces a noisy diff
// every time it is regenerated. Map keeps insertion order and drops empty
// values so optional form fields never emit `key: ""`.
package yamlgen

import (
	"errors"
	"io"
	"reflect"
	"strings"

	"gopkg.in/yaml.v3"
)

type pair struct {
	key   string
	value any
}

// Map is an ordered mapping node.
type Map struct {
	pairs []pair
}

// NewMap returns an empty ordered mapping.
func NewMap() *Map { return &Map{} }

// Set appends a key, skipping empty values.
func (m *Map) Set(key string, value any) *Map {
	if IsEmpty(value) {
		return m
	}
	m.pairs = append(m.pairs, pair{key: key, value: value})
	return m
}

// SetRaw appends a key even when the value is empty. Use it for fields where
// an explicit empty value is meaningful, such as `data: {}`.
func (m *Map) SetRaw(key string, value any) *Map {
	m.pairs = append(m.pairs, pair{key: key, value: value})
	return m
}

// Len reports how many keys survived the empty-value filter.
func (m *Map) Len() int {
	if m == nil {
		return 0
	}
	return len(m.pairs)
}

// MarshalYAML implements yaml.Marshaler.
func (m *Map) MarshalYAML() (any, error) {
	node := &yaml.Node{Kind: yaml.MappingNode}
	if m == nil {
		return node, nil
	}
	for _, p := range m.pairs {
		key := &yaml.Node{}
		if err := key.Encode(p.key); err != nil {
			return nil, err
		}
		value := &yaml.Node{}
		if err := value.Encode(p.value); err != nil {
			return nil, err
		}
		node.Content = append(node.Content, key, value)
	}
	return node, nil
}

// IsEmpty reports values that should be omitted from generated YAML.
func IsEmpty(value any) bool {
	if value == nil {
		return true
	}
	switch typed := value.(type) {
	case string:
		return strings.TrimSpace(typed) == ""
	case *Map:
		return typed == nil || typed.Len() == 0
	}
	rv := reflect.ValueOf(value)
	switch rv.Kind() {
	case reflect.Slice, reflect.Array, reflect.Map:
		return rv.Len() == 0
	case reflect.Ptr, reflect.Interface:
		return rv.IsNil()
	default:
		return false
	}
}

// Render encodes a single document with two-space indentation.
func Render(doc any) (string, error) {
	var out strings.Builder
	encoder := yaml.NewEncoder(&out)
	encoder.SetIndent(2)
	if err := encoder.Encode(doc); err != nil {
		return "", err
	}
	if err := encoder.Close(); err != nil {
		return "", err
	}
	return out.String(), nil
}

// RenderAll joins several documents into one file.
func RenderAll(docs []any) (string, error) {
	parts := make([]string, 0, len(docs))
	for _, doc := range docs {
		text, err := Render(doc)
		if err != nil {
			return "", err
		}
		if strings.TrimSpace(text) != "" {
			parts = append(parts, text)
		}
	}
	return strings.Join(parts, "---\n"), nil
}

// Parse reads a multi-document string into generic maps.
func Parse(text string) ([]map[string]any, error) {
	decoder := yaml.NewDecoder(strings.NewReader(text))
	docs := make([]map[string]any, 0, 2)
	for {
		var doc map[string]any
		err := decoder.Decode(&doc)
		if err != nil {
			if errors.Is(err, io.EOF) {
				break
			}
			return nil, err
		}
		if doc != nil {
			docs = append(docs, doc)
		}
	}
	return docs, nil
}
