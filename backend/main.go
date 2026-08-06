// Command manifest-workbench serves the YAML generator.
//
// The service renders and validates files. It has no kubeconfig, no client-go
// dependency and no code path that reaches a cluster, which is the whole point:
// the output is meant to be reviewed and committed, not applied from here.
package main

import (
	"context"
	"errors"
	"flag"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/example/manifest-workbench/internal/api"

	// Registering the resource definitions is the only reason this package is
	// imported; each definition adds itself in an init function.
	_ "github.com/example/manifest-workbench/internal/resources"
)

func main() {
	addr := flag.String("addr", envOr("ADDR", ":8080"), "address to listen on")
	webDir := flag.String("web", envOr("WEB_DIR", ""), "directory holding the built frontend")
	flag.Parse()

	server := &http.Server{
		Addr:              *addr,
		Handler:           api.New(api.Options{WebDir: *webDir}),
		ReadHeaderTimeout: 10 * time.Second,
	}

	go func() {
		log.Printf("manifest workbench listening on %s", *addr)
		if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("server failed: %v", err)
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	<-stop

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := server.Shutdown(ctx); err != nil {
		log.Printf("shutdown: %v", err)
	}
}

func envOr(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}
