.PHONY: start build check clean help

run:          ## Dev mode with hot-reload
	cargo tauri dev

build:          ## Build distributable (DMG/MSI/AppImage)
	cargo tauri build

check:          ## Type-check TS + Rust without building
	npx tsc --noEmit && cd src-tauri && cargo check

clean:          ## Deep clean (node_modules, dist, target)
	rm -rf dist node_modules src-tauri/target package-lock.json

help:           ## Show all commands
	@grep -E '^[a-z]+:.*##' Makefile | sed 's/:.*## /\t/'
