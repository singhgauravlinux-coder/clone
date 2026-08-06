module github.com/example/manifest-workbench

go 1.22

// Direct dependencies only. Run `go mod tidy` after cloning to resolve the
// transitive set; this file is kept minimal on purpose so it is reviewable.
require (
	github.com/gin-gonic/gin v1.10.0
	github.com/golang-jwt/jwt/v5 v5.2.1
	github.com/google/uuid v1.6.0
	github.com/jackc/pgx/v5 v5.6.0
	golang.org/x/crypto v0.26.0
	gopkg.in/yaml.v3 v3.0.1
	k8s.io/apimachinery v0.30.4
	k8s.io/client-go v0.30.4
)
