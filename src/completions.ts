// Pyright-based autocompletion using @typefox/pyright-browser.
// Runs Pyright (1.9MB) in a Web Worker and speaks LSP directly,
// registering Monaco providers for completion, hover, and signatures.

import * as monaco from "monaco-editor";
import type { editor } from "monaco-editor";
import {
  BrowserMessageReader,
  BrowserMessageWriter,
  createMessageConnection,
  type MessageConnection,
} from "vscode-jsonrpc/browser";

// Vite imports all .pyi stubs as raw strings at build time.
const stubModules = import.meta.glob<string>(
  "../resources/stubs/*.pyi",
  { eager: true, query: "?raw", import: "default" },
);

const DOC_URI = "file:///main.py";
let connection: MessageConnection | null = null;
let docVersion = 0;

// -- LSP helpers -----------------------------------------------------------

function lspPos(pos: monaco.Position) {
  return { line: pos.lineNumber - 1, character: pos.column - 1 };
}

function monacoRange(r: any): monaco.IRange {
  return {
    startLineNumber: r.start.line + 1,
    startColumn: r.start.character + 1,
    endLineNumber: r.end.line + 1,
    endColumn: r.end.character + 1,
  };
}

function lspDocToMarkdown(doc: any): monaco.IMarkdownString | string {
  if (!doc) {
    return "";
  }
  if (typeof doc === "string") {
    return { value: doc };
  }
  if (doc.kind === "markdown") {
    return { value: doc.value };
  }
  return { value: doc.value || "" };
}

function convertCompletionKind(k: number): monaco.languages.CompletionItemKind {
  // LSP CompletionItemKind -> Monaco CompletionItemKind
  const map: Record<number, monaco.languages.CompletionItemKind> = {
    1: monaco.languages.CompletionItemKind.Text,
    2: monaco.languages.CompletionItemKind.Method,
    3: monaco.languages.CompletionItemKind.Function,
    4: monaco.languages.CompletionItemKind.Constructor,
    5: monaco.languages.CompletionItemKind.Field,
    6: monaco.languages.CompletionItemKind.Variable,
    7: monaco.languages.CompletionItemKind.Class,
    8: monaco.languages.CompletionItemKind.Interface,
    9: monaco.languages.CompletionItemKind.Module,
    10: monaco.languages.CompletionItemKind.Property,
    11: monaco.languages.CompletionItemKind.Unit,
    12: monaco.languages.CompletionItemKind.Value,
    13: monaco.languages.CompletionItemKind.Enum,
    14: monaco.languages.CompletionItemKind.Keyword,
    15: monaco.languages.CompletionItemKind.Snippet,
    16: monaco.languages.CompletionItemKind.Color,
    17: monaco.languages.CompletionItemKind.File,
    18: monaco.languages.CompletionItemKind.Reference,
    19: monaco.languages.CompletionItemKind.Folder,
    20: monaco.languages.CompletionItemKind.EnumMember,
    21: monaco.languages.CompletionItemKind.Constant,
    22: monaco.languages.CompletionItemKind.Struct,
    23: monaco.languages.CompletionItemKind.Event,
    24: monaco.languages.CompletionItemKind.Operator,
    25: monaco.languages.CompletionItemKind.TypeParameter,
  };
  return map[k] || monaco.languages.CompletionItemKind.Text;
}

// -- Send document updates -------------------------------------------------

async function updateDocument(code: string) {
  if (!connection) {
    return;
  }

  docVersion++;

  if (docVersion === 1) {
    await connection.sendNotification("textDocument/didOpen", {
      textDocument: {
        uri: DOC_URI,
        languageId: "python",
        version: docVersion,
        text: code,
      },
    });
  } else {
    await connection.sendNotification("textDocument/didChange", {
      textDocument: { uri: DOC_URI, version: docVersion },
      contentChanges: [{ text: code }],
    });
  }
}

// -- Register Monaco providers ---------------------------------------------

function registerProviders() {
  monaco.languages.registerCompletionItemProvider("python", {
    triggerCharacters: [".", "[", '"', "'"],
    provideCompletionItems: async (model, position) => {
      await updateDocument(model.getValue());

      const result: any = await connection!.sendRequest(
        "textDocument/completion",
        {
          textDocument: { uri: DOC_URI },
          position: lspPos(position),
        },
      );

      const items = Array.isArray(result) ? result : result?.items || [];

      // Find the start of the word being typed so the completion
      // replaces the partial prefix instead of appending to it.
      const wordInfo = model.getWordUntilPosition(position);
      const defaultRange: monaco.IRange = {
        startLineNumber: position.lineNumber,
        startColumn: wordInfo.startColumn,
        endLineNumber: position.lineNumber,
        endColumn: position.column,
      };

      return {
        suggestions: items.map((item: any) => {
          const range = item.textEdit?.range
            ? monacoRange(item.textEdit.range)
            : defaultRange;

          const rawText = item.textEdit?.newText || item.insertText || item.label;
          // LSP kinds 2=Method, 3=Function, 4=Constructor
          const isFuncLike = item.kind === 2 || item.kind === 3 || item.kind === 4;
          const insertText = isFuncLike ? rawText + "($0)" : rawText;
          const insertTextRules = isFuncLike
            ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet
            : undefined;

          return {
            label: item.label,
            kind: convertCompletionKind(item.kind || 1),
            insertText,
            insertTextRules,
            range,
            detail: item.detail || "",
            documentation: lspDocToMarkdown(item.documentation),
            sortText: item.sortText,
            filterText: item.filterText,
            command: isFuncLike
              ? { id: "editor.action.triggerParameterHints", title: "" }
              : undefined,
          };
        }),
      };
    },
  });

  monaco.languages.registerHoverProvider("python", {
    provideHover: async (model, position) => {
      await updateDocument(model.getValue());

      const result: any = await connection!.sendRequest("textDocument/hover", {
        textDocument: { uri: DOC_URI },
        position: lspPos(position),
      });

      if (!result) {
        return null;
      }

      const contents = Array.isArray(result.contents)
        ? result.contents
        : [result.contents];

      return {
        range: result.range ? monacoRange(result.range) : undefined,
        contents: contents.map((c: any) => {
          if (typeof c === "string") {
            return { value: c };
          }
          return { value: "```" + (c.language || "") + "\n" + c.value + "\n```" };
        }),
      };
    },
  });

  monaco.languages.registerSignatureHelpProvider("python", {
    signatureHelpTriggerCharacters: ["(", ","],
    provideSignatureHelp: async (model, position) => {
      await updateDocument(model.getValue());

      const result: any = await connection!.sendRequest(
        "textDocument/signatureHelp",
        {
          textDocument: { uri: DOC_URI },
          position: lspPos(position),
        },
      );

      if (!result || !result.signatures?.length) {
        return null;
      }

      return {
        value: {
          signatures: result.signatures.map((sig: any) => ({
            label: sig.label,
            documentation: lspDocToMarkdown(sig.documentation),
            parameters: (sig.parameters || []).map((p: any) => ({
              label: p.label,
              documentation: lspDocToMarkdown(p.documentation),
            })),
          })),
          activeSignature: result.activeSignature || 0,
          activeParameter: result.activeParameter || 0,
        },
        dispose: () => {},
      };
    },
  });

}

// -- Boot ------------------------------------------------------------------

export async function registerCompletions(
  ed: editor.IStandaloneCodeEditor,
): Promise<void> {
  const workerUrl = new URL(
    "../node_modules/@typefox/pyright-browser/dist/pyright.worker.js",
    import.meta.url,
  ).href;

  const worker = new Worker(workerUrl);

  // Set up LSP connection over the worker.
  const reader = new BrowserMessageReader(worker);
  const writer = new BrowserMessageWriter(worker);

  connection = createMessageConnection(reader, writer);
  connection.listen();

  // Boot the Pyright server in foreground mode.
  // Must happen after connection.listen() so the reader is ready
  // to receive the server's responses.
  worker.postMessage({ type: "browser/boot", mode: "foreground" });

  // Give the server a moment to initialize internally.
  await new Promise((resolve) => setTimeout(resolve, 1000));

  // Build the stub files map for the worker's virtual filesystem.
  // Each stub becomes /<module>/__init__.pyi so Pyright's
  // import resolver can find them as packages under rootUri.
  const filesMap: Record<string, string> = {};

  for (const [path, content] of Object.entries(stubModules)) {
    const filename = path.split("/").pop();

    if (!filename) {
      continue;
    }

    const modName = filename.replace(/\.pyi$/, "");
    // Place stubs at root so "import sensor" resolves to
    // /sensor/__init__.pyi under rootUri file:///
    filesMap[`/${modName}/__init__.pyi`] = content;
  }

  // Initialize LSP with stubs pre-loaded via initializationOptions.files.
  // This writes files to the TestFileSystem during initialize AND passes
  // them to the background analysis thread via initializeFileSystem.
  await connection.sendRequest("initialize", {
    processId: null,
    rootUri: "file:///",
    initializationOptions: {
      files: filesMap,
    },
    capabilities: {
      textDocument: {
        completion: {
          completionItem: {
            snippetSupport: false,
            documentationFormat: ["markdown", "plaintext"],
          },
        },
        hover: {
          contentFormat: ["markdown", "plaintext"],
        },
        signatureHelp: {
          signatureInformation: {
            documentationFormat: ["markdown", "plaintext"],
            parameterInformation: { labelOffsetSupport: true },
          },
        },
        publishDiagnostics: {
          tagSupport: { valueSet: [1, 2] },
        },
      },
    },
  });

  await connection.sendNotification("initialized", {});

  // Configure Pyright search paths.
  await connection.sendNotification("workspace/didChangeConfiguration", {
    settings: {
      python: {
        analysis: {
          stubPath: "/",
          extraPaths: ["/"],
          typeshedPaths: [],
          diagnosticMode: "openFilesOnly",
          autoImportCompletions: false,
        },
        pythonVersion: "3.10",
        pythonPlatform: "All",
      },
    },
  });

  // Register Monaco completion/hover/signature providers.
  registerProviders();

  // Forward diagnostics to Monaco markers.
  connection.onNotification(
    "textDocument/publishDiagnostics",
    (params: any) => {
      if (params.uri !== DOC_URI) {
        return;
      }

      const model = ed.getModel();

      if (!model) {
        return;
      }

      const markers = (params.diagnostics || []).map((d: any) => ({
        severity:
          d.severity === 1
            ? monaco.MarkerSeverity.Error
            : d.severity === 2
              ? monaco.MarkerSeverity.Warning
              : d.severity === 3
                ? monaco.MarkerSeverity.Info
                : monaco.MarkerSeverity.Hint,
        message: d.message,
        startLineNumber: d.range.start.line + 1,
        startColumn: d.range.start.character + 1,
        endLineNumber: d.range.end.line + 1,
        endColumn: d.range.end.character + 1,
        source: "pyright",
      }));

      monaco.editor.setModelMarkers(model, "pyright", markers);
    },
  );

  // Send initial document content.
  const model = ed.getModel();

  if (model) {
    await updateDocument(model.getValue());

    ed.onDidChangeModelContent(async () => {
      await updateDocument(ed.getModel()?.getValue() || "");
    });
  }
}
