package registry

import (
	"encoding/json"
	"strconv"
	"strings"
)

// Model is the form state for one resource. It arrives as decoded JSON, so
// every number is a float64 and every nested object is a map[string]any.
type Model map[string]any

// Get reads a dot path such as "spec.template.replicas" or "containers.0.image".
func Get(model Model, path string) any {
	var current any = map[string]any(model)
	for _, key := range strings.Split(path, ".") {
		switch node := current.(type) {
		case map[string]any:
			current = node[key]
		case Model:
			current = node[key]
		case []any:
			index, err := strconv.Atoi(key)
			if err != nil || index < 0 || index >= len(node) {
				return nil
			}
			current = node[index]
		default:
			return nil
		}
		if current == nil {
			return nil
		}
	}
	return current
}

// Set writes a dot path, creating intermediate maps as needed.
func Set(model Model, path string, value any) {
	keys := strings.Split(path, ".")
	node := map[string]any(model)
	for _, key := range keys[:len(keys)-1] {
		child, ok := node[key].(map[string]any)
		if !ok {
			child = map[string]any{}
			node[key] = child
		}
		node = child
	}
	node[keys[len(keys)-1]] = value
}

// String reads a trimmed string value, returning "" when unset.
func String(model Model, path string) string {
	switch value := Get(model, path).(type) {
	case string:
		return strings.TrimSpace(value)
	case float64:
		return strconv.FormatFloat(value, 'f', -1, 64)
	case int:
		return strconv.Itoa(value)
	case bool:
		return strconv.FormatBool(value)
	case json.Number:
		return value.String()
	default:
		return ""
	}
}

// Int reads a numeric value. The second result is false when the field is empty.
func Int(model Model, path string) (int, bool) {
	switch value := Get(model, path).(type) {
	case float64:
		return int(value), true
	case int:
		return value, true
	case json.Number:
		number, err := value.Int64()
		return int(number), err == nil
	case string:
		trimmed := strings.TrimSpace(value)
		if trimmed == "" {
			return 0, false
		}
		number, err := strconv.Atoi(trimmed)
		return number, err == nil
	default:
		return 0, false
	}
}

// Bool reads a checkbox value.
func Bool(model Model, path string) bool {
	value, _ := Get(model, path).(bool)
	return value
}

// Rows reads an array field as a slice of sub-models.
func Rows(model Model, path string) []Model {
	raw, ok := Get(model, path).([]any)
	if !ok {
		return nil
	}
	rows := make([]Model, 0, len(raw))
	for _, item := range raw {
		if row, ok := item.(map[string]any); ok {
			rows = append(rows, Model(row))
		}
	}
	return rows
}

// Pairs reads a key/value field into a map, dropping rows with no key.
func Pairs(model Model, path string) map[string]string {
	rows := Rows(model, path)
	if len(rows) == 0 {
		return nil
	}
	out := map[string]string{}
	for _, row := range rows {
		key := String(row, "key")
		if key == "" {
			continue
		}
		out[key] = String(row, "value")
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

// List splits a comma or newline separated field, or reads a string array.
func List(model Model, path string) []string {
	switch value := Get(model, path).(type) {
	case []any:
		out := make([]string, 0, len(value))
		for _, item := range value {
			if text, ok := item.(string); ok && strings.TrimSpace(text) != "" {
				out = append(out, strings.TrimSpace(text))
			}
		}
		if len(out) == 0 {
			return nil
		}
		return out
	case string:
		out := make([]string, 0, 4)
		for _, part := range strings.FieldsFunc(value, func(r rune) bool { return r == ',' || r == '\n' }) {
			if trimmed := strings.TrimSpace(part); trimmed != "" {
				out = append(out, trimmed)
			}
		}
		if len(out) == 0 {
			return nil
		}
		return out
	default:
		return nil
	}
}

// DocString reads a string from a parsed YAML document.
func DocString(doc map[string]any, path string) string {
	return String(Model(doc), path)
}

// DocMap reads a nested mapping from a parsed YAML document.
func DocMap(doc map[string]any, path string) map[string]string {
	raw, ok := Get(Model(doc), path).(map[string]any)
	if !ok {
		return nil
	}
	out := map[string]string{}
	for key, value := range raw {
		out[key] = String(Model(map[string]any{"v": value}), "v")
	}
	return out
}

// PairRows converts a map back into the {key, value} rows the form expects.
func PairRows(values map[string]string) []any {
	rows := make([]any, 0, len(values))
	for key, value := range values {
		rows = append(rows, map[string]any{"key": key, "value": value})
	}
	return rows
}
