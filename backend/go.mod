module github.com/example/manifest-workbench

go 1.22

// Direct dependencies only; `go mod tidy` resolves the transitive set.
//
// Every module the code imports must be listed here. `go mod download` reads
// this file and nothing else, so a package imported by the code but missing
// from this list downloads clean and then fails at build time with a confusing
// "missing go.sum entry" — which is exactly what happened to k8s.io/api.
require (
	github.com/gin-gonic/gin v1.10.0
	github.com/golang-jwt/jwt/v5 v5.2.1
	github.com/google/uuid v1.6.0
	golang.org/x/crypto v0.26.0
	gopkg.in/yaml.v3 v3.0.1
	k8s.io/api v0.30.4
	k8s.io/apimachinery v0.30.4
	k8s.io/client-go v0.30.4
)

// The PostgreSQL driver is intentionally absent: the store implementations
// behind the api ports are not written yet, so nothing imports it. Add
// github.com/jackc/pgx/v5 with the first repository.
