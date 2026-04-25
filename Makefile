.PHONY: run build check clean help
.DEFAULT_GOAL := run

node_modules: package.json package-lock.json
	npm install
	@touch $@

run: node_modules  ## Dev mode with hot-reload
	cargo tauri dev

build: node_modules  ## Build distributable (DMG/MSI/DEB)
	cargo tauri build

check:          ## Type-check TS + Rust without building
	npx tsc --noEmit && cd src-tauri && cargo check

clean:          ## Deep clean (node_modules, dist, target)
	rm -rf dist node_modules src-tauri/target

help:           ## Show all commands
	@grep -E '^[a-z]+:.*##' Makefile | sed 's/:.*## /\t/'
