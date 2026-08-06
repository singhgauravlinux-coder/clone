// Package audit writes the activity log.
//
// Two properties matter more than throughput. First, every entry is chained:
// each row stores the hash of the row before it, so a deleted or edited entry
// is detectable. Second, writes never block the request path on a failure that
// would otherwise be silent — a write error is escalated, not swallowed,
// because a missing audit entry is a security incident rather than a glitch.
package audit

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"net"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
)

// Status classifies the outcome of the audited action.
type Status string

// Outcomes.
const (
	Success Status = "success"
	Failure Status = "failure"
	Denied  Status = "denied"
)

// Entry is one row of activity_log.
type Entry struct {
	OccurredAt     time.Time
	OrganizationID *uuid.UUID
	UserID         *uuid.UUID
	ActorEmail     string
	SessionID      *uuid.UUID
	APIKeyID       *uuid.UUID
	IP             net.IP
	UserAgent      string
	ProjectID      *uuid.UUID
	ProjectSlug    string
	ClusterID      *uuid.UUID
	ClusterSlug    string
	Namespace      string
	Action         string
	TargetKind     string
	TargetName     string
	TargetID       *uuid.UUID
	Status         Status
	Error          string
	OldValue       any
	NewValue       any
	Metadata       map[string]any
	RequestID      string
}

// Recorder appends entries and maintains the hash chain.
type Recorder struct {
	db *sql.DB
	// The chain head is serialised: two concurrent writers must not read the
	// same previous hash. A single mutex is enough at platform write volumes;
	// beyond that, move the chain into a sequence-guarded stored procedure.
	mu       sync.Mutex
	prevHash []byte
	loaded   bool
}

// NewRecorder builds a recorder bound to a database handle.
func NewRecorder(db *sql.DB) *Recorder {
	return &Recorder{db: db}
}

// Fields that are blanked before an entry is stored. Matching is on the leaf
// key, case-insensitively, at any depth.
var redactedKeys = map[string]bool{
	"password":        true,
	"newpassword":     true,
	"currentpassword": true,
	"token":           true,
	"accesstoken":     true,
	"refreshtoken":    true,
	"clientsecret":    true,
	"kubeconfig":      true,
	"bearertoken":     true,
	"privatekey":      true,
	"ssh-privatekey":  true,
	"tls.key":         true,
	"mfasecret":       true,
	"stringdata":      true,
	"data":            true,
	"authorization":   true,
}

// Redact walks a value and replaces sensitive leaves with a marker. Secret
// bodies never reach the log, but the shape of the change still does, which is
// what an investigator actually needs.
func Redact(value any) any {
	switch typed := value.(type) {
	case map[string]any:
		out := make(map[string]any, len(typed))
		for key, child := range typed {
			if redactedKeys[strings.ToLower(key)] {
				out[key] = "***redacted***"
				continue
			}
			out[key] = Redact(child)
		}
		return out
	case []any:
		out := make([]any, len(typed))
		for index, child := range typed {
			out[index] = Redact(child)
		}
		return out
	default:
		return value
	}
}

// canonical produces a stable byte representation for hashing. Go map ordering
// is randomised, so the JSON encoder's sorted-key behaviour is relied on here.
func canonical(entry Entry, prev []byte, oldJSON, newJSON, metaJSON []byte) []byte {
	buffer := make([]byte, 0, 512)
	buffer = append(buffer, prev...)
	stamp := make([]byte, 8)
	binary.BigEndian.PutUint64(stamp, uint64(entry.OccurredAt.UTC().UnixNano()))
	buffer = append(buffer, stamp...)
	appendField := func(value string) {
		buffer = append(buffer, byte(len(value)>>8), byte(len(value)))
		buffer = append(buffer, value...)
	}
	appendField(uuidOrEmpty(entry.OrganizationID))
	appendField(uuidOrEmpty(entry.UserID))
	appendField(entry.ActorEmail)
	appendField(uuidOrEmpty(entry.SessionID))
	appendField(entry.IP.String())
	appendField(entry.Action)
	appendField(entry.TargetKind)
	appendField(entry.TargetName)
	appendField(string(entry.Status))
	appendField(entry.Error)
	appendField(entry.RequestID)
	buffer = append(buffer, oldJSON...)
	buffer = append(buffer, newJSON...)
	buffer = append(buffer, metaJSON...)
	return buffer
}

func uuidOrEmpty(value *uuid.UUID) string {
	if value == nil {
		return ""
	}
	return value.String()
}

// Record appends one entry. It returns an error rather than logging quietly:
// the caller decides whether the audited action should be rolled back.
func (r *Recorder) Record(ctx context.Context, entry Entry) error {
	if entry.Action == "" {
		return fmt.Errorf("audit: action is required")
	}
	if entry.Status == "" {
		entry.Status = Success
	}
	if entry.OccurredAt.IsZero() {
		entry.OccurredAt = time.Now().UTC()
	}

	oldJSON, err := marshalOrNull(Redact(entry.OldValue))
	if err != nil {
		return fmt.Errorf("audit: encode old value: %w", err)
	}
	newJSON, err := marshalOrNull(Redact(entry.NewValue))
	if err != nil {
		return fmt.Errorf("audit: encode new value: %w", err)
	}
	metaJSON, err := json.Marshal(Redact(orEmpty(entry.Metadata)))
	if err != nil {
		return fmt.Errorf("audit: encode metadata: %w", err)
	}

	r.mu.Lock()
	defer r.mu.Unlock()

	if !r.loaded {
		if err := r.loadHead(ctx); err != nil {
			return err
		}
	}

	sum := sha256.Sum256(canonical(entry, r.prevHash, oldJSON, newJSON, metaJSON))

	const insert = `
INSERT INTO activity_log (
    occurred_at, organization_id, user_id, actor_email, session_id, api_key_id,
    ip, user_agent, project_id, project_slug, cluster_id, cluster_slug, namespace,
    action, target_kind, target_name, target_id, status, error,
    old_value, new_value, metadata, request_id, prev_hash, entry_hash
) VALUES (
    $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,
    $20,$21,$22,$23,$24,$25
)`
	_, err = r.db.ExecContext(ctx, insert,
		entry.OccurredAt, entry.OrganizationID, entry.UserID, nullString(entry.ActorEmail),
		entry.SessionID, entry.APIKeyID, nullIP(entry.IP), nullString(entry.UserAgent),
		entry.ProjectID, nullString(entry.ProjectSlug), entry.ClusterID, nullString(entry.ClusterSlug),
		nullString(entry.Namespace), entry.Action, nullString(entry.TargetKind), nullString(entry.TargetName),
		entry.TargetID, string(entry.Status), nullString(entry.Error),
		nullJSON(oldJSON), nullJSON(newJSON), metaJSON, nullString(entry.RequestID),
		nullBytes(r.prevHash), sum[:],
	)
	if err != nil {
		// Force a head reload so a transient failure cannot leave the in-memory
		// chain pointing at a row that was never committed.
		r.loaded = false
		return fmt.Errorf("audit: insert: %w", err)
	}
	r.prevHash = sum[:]
	return nil
}

func (r *Recorder) loadHead(ctx context.Context) error {
	var head []byte
	err := r.db.QueryRowContext(ctx, `SELECT entry_hash FROM activity_log ORDER BY id DESC LIMIT 1`).Scan(&head)
	if err != nil && err != sql.ErrNoRows {
		return fmt.Errorf("audit: load chain head: %w", err)
	}
	r.prevHash = head
	r.loaded = true
	return nil
}

// Verify walks the chain and reports the first entry whose stored previous
// hash does not match its predecessor.
func (r *Recorder) Verify(ctx context.Context, fromID int64) (brokenID int64, err error) {
	row := r.db.QueryRowContext(ctx, `SELECT broken_id FROM activity_log_verify($1)`, fromID)
	switch err := row.Scan(&brokenID); err {
	case sql.ErrNoRows:
		return 0, nil
	case nil:
		return brokenID, nil
	default:
		return 0, fmt.Errorf("audit: verify: %w", err)
	}
}

func marshalOrNull(value any) ([]byte, error) {
	if value == nil {
		return nil, nil
	}
	return json.Marshal(value)
}

func orEmpty(value map[string]any) map[string]any {
	if value == nil {
		return map[string]any{}
	}
	return value
}

func nullString(value string) any {
	if value == "" {
		return nil
	}
	return value
}

func nullBytes(value []byte) any {
	if len(value) == 0 {
		return nil
	}
	return value
}

func nullJSON(value []byte) any {
	if len(value) == 0 {
		return nil
	}
	return string(value)
}

func nullIP(value net.IP) any {
	if value == nil {
		return nil
	}
	return value.String()
}
