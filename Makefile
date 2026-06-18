# Root Makefile.
#
# Delegates to each plugin's own Makefile so CI only needs to run `make test`
# here. When a new plugin gains a Makefile, add it to PLUGIN_DIRS below.

SHELL := /bin/bash

PLUGIN_DIRS := plugins/trace-codex

.PHONY: test build clean $(PLUGIN_DIRS)

# Default: run every plugin's `test` target.
test: $(PLUGIN_DIRS)

# Run `make test` in each plugin directory.
$(PLUGIN_DIRS):
	@echo "==> $@"
	$(MAKE) -C $@ test

build:
	@for dir in $(PLUGIN_DIRS); do \
		echo "==> build $$dir"; \
		$(MAKE) -C $$dir build; \
	done

clean:
	@for dir in $(PLUGIN_DIRS); do \
		echo "==> clean $$dir"; \
		$(MAKE) -C $$dir clean; \
	done
