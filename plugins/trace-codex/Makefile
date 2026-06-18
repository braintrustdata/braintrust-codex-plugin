# Makefile for the Braintrust Codex tracing plugin.
#
# Targets:
#   make test          Lint + typecheck + unit tests + a full build + live
#                      integration check.
#   make lint          Run the Biome linter/formatter check (no writes).
#   make typecheck     Run the TypeScript type checker.
#   make unit          Run only the bun unit tests.
#   make build         Compile the host binary (and per-platform binaries).
#   make integration   Build, boot the server via the hook binary, health-check,
#                      assert the version, then shut it down.
#   make clean         Remove build artifacts.

SHELL := /bin/bash

# Port used only by the integration test. Chosen from the IANA dynamic/private
# range (49152-65535) and deliberately different from the default (52734) so
# the test never collides with a real running server.
TEST_PORT ?= 54219

# Expected /health version, read from the plugin manifest (single source of truth).
EXPECTED_VERSION := $(shell sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' .codex-plugin/plugin.json | head -1)

BIN := bin/codex-hook
BASE_URL := http://127.0.0.1:$(TEST_PORT)

.PHONY: test lint typecheck unit build integration clean

test: lint typecheck unit integration

lint:
	@echo "==> Linting (biome)"
	bun run check

typecheck:
	@echo "==> Typechecking (tsc)"
	bun run typecheck

unit:
	@echo "==> Running unit tests"
	bun test

build:
	@echo "==> Building binaries"
	BUILD_HOST_ONLY=1 bun run build

integration: build
	@echo "==> Integration test (port $(TEST_PORT), expecting version $(EXPECTED_VERSION))"
	@set -euo pipefail; \
	export BRAINTRUST_EVENT_SERVER_PORT=$(TEST_PORT); \
	export BRAINTRUST_EVENT_SERVER_LOG_DIR="$$(mktemp -d)"; \
	cleanup() { curl -s -o /dev/null -X POST $(BASE_URL)/shutdown || true; }; \
	trap cleanup EXIT; \
	echo "    -> invoking hook dispatcher (boots server in background)"; \
	echo '{"hook_event_name":"SessionStart","session_id":"make-test"}' | "$(BIN)" hook; \
	echo "    -> waiting for /health on $(BASE_URL)"; \
	version=""; \
	for i in $$(seq 1 50); do \
		body="$$(curl -s --max-time 1 $(BASE_URL)/health || true)"; \
		if [ -n "$$body" ]; then version="$$body"; break; fi; \
		sleep 0.1; \
	done; \
	if [ -z "$$version" ]; then echo "FAIL: server never became healthy on $(BASE_URL)"; exit 1; fi; \
	echo "    -> /health returned: $$version"; \
	expected='{"version":"$(EXPECTED_VERSION)"}'; \
	if [ "$$version" != "$$expected" ]; then \
		echo "FAIL: version mismatch"; echo "  expected: $$expected"; echo "  actual:   $$version"; exit 1; \
	fi; \
	echo "    -> version matches ($(EXPECTED_VERSION))"; \
	echo "    -> calling /shutdown"; \
	code="$$(curl -s -o /dev/null -w '%{http_code}' -X POST $(BASE_URL)/shutdown)"; \
	if [ "$$code" != "200" ]; then echo "FAIL: /shutdown returned $$code (expected 200)"; exit 1; fi; \
	echo "    -> /shutdown returned 200"; \
	echo "    -> verifying server stopped"; \
	stopped=0; \
	for i in $$(seq 1 30); do \
		if ! curl -s -o /dev/null --max-time 1 $(BASE_URL)/health; then stopped=1; break; fi; \
		sleep 0.1; \
	done; \
	if [ "$$stopped" != "1" ]; then echo "FAIL: server still responding after shutdown"; exit 1; fi; \
	echo "    -> server stopped cleanly"; \
	echo "PASS: integration test"

clean:
	@echo "==> Cleaning"
	rm -rf bin
